import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { BankError, GM_CHANNEL, THEMES } from './bank.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const POLL_MS = 25_000;
const COOKIE_AGE_S = 30 * 24 * 60 * 60;
const BODY_LIMIT = 64 * 1024;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

// Every lobby lives under its own first path segment: /<lobby>/ is the player app, /<lobby>/admin its GM
// console, /<lobby>/api/... its API. QR codes carry /<lobby>/pay/<id> and /<lobby>/l/<code>.
const LOBBY_API = /^\/([a-z0-9-]+)(\/api\/.*)$/;
const LOBBY_APP = /^\/([a-z0-9-]+)(?:\/|\/(?:pay|l)\/[^/]+\/?)?$/;
const LOBBY_GM = /^\/([a-z0-9-]+)\/admin\/?$/;
// Links printed before lobbies existed; they now lead into the default lobby.
const LEGACY = /^\/(?:pay|l)\/[^/]+\/?$/;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': [
    "default-src 'self'",
    // blob: is for the QR scanner, which runs its decoder in a worker built from a blob.
    "script-src 'self' blob:",
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob: mediastream:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
};

function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at > 0) cookies[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return cookies;
}

// Requiring a JSON content type means another website can't make a visitor's browser post here.
async function readJson(req) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
    throw new BankError(415, 'BAD_REQUEST', 'Requests must be JSON.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new BankError(413, 'TOO_LARGE', 'Request too large.');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch {
    // reported below
  }
  throw new BankError(400, 'BAD_REQUEST', 'Malformed request.');
}

function router() {
  const routes = [];
  const add = (method, pattern, handler) => {
    const keys = [];
    const source = pattern.replace(/:(\w+)/g, (_, key) => {
      keys.push(key);
      return '([^/]+)';
    });
    routes.push({ method, regex: new RegExp(`^${source}$`), keys, handler });
  };
  const find = (method, pathname) => {
    for (const { method: wanted, regex, keys, handler } of routes) {
      const match = wanted === method && regex.exec(pathname);
      if (match) return { handler, params: Object.fromEntries(keys.map((key, i) => [key, decodeURIComponent(match[i + 1])])) };
    }
    return null;
  };
  return { add, find };
}

export function createApp(hub, { lanUrls = () => [] } = {}) {
  const lobbyRoutes = router();
  const hubRoutes = router();
  const files = new Map();
  const loginFails = [];

  // Lobby cookies are scoped to the lobby's path, so one phone can hold logins in several games at once.
  function setCookie(ctx, name, value, maxAge, scope = '/') {
    const secure = ctx.req.headers['x-forwarded-proto'] === 'https' || ctx.req.socket.encrypted;
    ctx.cookiesOut.push(
      `${name}=${value}; Path=${scope}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`,
    );
  }

  function send(ctx, status, headers, body) {
    if (ctx.cookiesOut.length) headers['Set-Cookie'] = ctx.cookiesOut;
    ctx.res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
    ctx.res.end(ctx.req.method === 'HEAD' ? undefined : body);
  }

  function sendJson(ctx, status, payload) {
    send(ctx, status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, JSON.stringify(payload));
  }

  const sendError = (ctx, status, code, message) => sendJson(ctx, status, { error: { code, message } });

  function redirect(ctx, location) {
    send(ctx, 302, { Location: location, 'Cache-Control': 'no-store' });
  }

  // Shared by every password form: a few wrong guesses a minute, then a pause.
  function throttle(ok) {
    const now = Date.now();
    while (loginFails.length && loginFails[0] < now - 60_000) loginFails.shift();
    if (loginFails.length >= 8) throw new BankError(429, 'SLOW_DOWN', 'Too many attempts. Wait a minute.');
    if (!ok) {
      loginFails.push(now);
      throw new BankError(401, 'BAD_PASSWORD', 'Wrong password.');
    }
  }

  const player = (handler) => (ctx) => {
    ctx.user = ctx.bank.sessionUser(ctx.cookies.sid);
    if (!ctx.user) throw new BankError(401, 'AUTH', 'Not logged in.');
    ctx.bank.markSeen(ctx.user.id);
    return handler(ctx);
  };

  // A lobby's console opens with that lobby's GM password, or for whoever runs it in the hub:
  // the organizer who created it, or the server owner.
  const gm = (handler) => (ctx) => {
    if (!ctx.bank.isGm(ctx.cookies.gm) && !hub.canManage(hub.viewer(ctx.cookies.hub), ctx.lobby)) {
      throw new BankError(401, 'AUTH', 'Game master login required.');
    }
    return handler(ctx);
  };

  // Any hub account: an organizer or the server owner.
  const account = (handler) => (ctx) => {
    ctx.viewer = hub.viewer(ctx.cookies.hub);
    if (!ctx.viewer) throw new BankError(401, 'AUTH', 'Log in first.');
    return handler(ctx);
  };

  const owner = (handler) => account((ctx) => {
    if (!ctx.viewer.master) throw new BankError(403, 'FORBIDDEN', 'Only the server owner can do that.');
    return handler(ctx);
  });

  const gmState = (ctx) => ({
    ...ctx.bank.adminState(),
    urls: lanUrls(),
    lobby: { slug: ctx.lobby.slug, title: ctx.lobby.title },
    hubAccess: hub.canManage(hub.viewer(ctx.cookies.hub), ctx.lobby),
    gmPassword: ctx.bank.adminPassword,
    themes: THEMES,
  });

  // What the hub page shows. Organizers see their own lobbies; the owner also sees everyone and the sign-up rules.
  const hubState = (viewer) => ({
    me: viewer.master ? { master: true } : { name: viewer.org.name },
    lobbies: hub.list(viewer),
    themes: THEMES,
    limit: viewer.master ? null : hub.settings.maxLobbies,
    ...(viewer.master ? { organizers: hub.organizers(), settings: hub.settings } : {}),
  });

  function hubLogIn(ctx, org) {
    hub.closeSession(ctx.cookies.hub);
    setCookie(ctx, 'hub', hub.openSession(org), COOKIE_AGE_S);
    return hubState(org ? { org } : { master: true });
  }

  // Long poll: if the caller is already up to date, hold the request until something changes for them.
  async function holdUntilChanged(ctx, channel) {
    if (ctx.url.searchParams.get('wait') !== ctx.bank.revOf(channel)) return;
    const { done, cancel } = ctx.bank.wait(channel, POLL_MS);
    ctx.res.once('close', cancel);
    await done;
    ctx.res.off('close', cancel);
  }

  function logIn(ctx, user) {
    ctx.bank.closeSession(ctx.cookies.sid);
    setCookie(ctx, 'sid', ctx.bank.openSession({ uid: user.id }), COOKIE_AGE_S, ctx.base);
    ctx.bank.markSeen(user.id);
    return ctx.bank.snapshot(user);
  }

  // ---------------------------------------------------------------- players

  const route = lobbyRoutes.add;

  // Everything the app needs to start, in one round trip: the bank's public settings and, if logged in, the account.
  route('GET', '/api/boot', (ctx) => {
    const user = ctx.bank.sessionUser(ctx.cookies.sid);
    if (user) ctx.bank.markSeen(user.id);
    return { config: ctx.bank.publicConfig(), me: user ? ctx.bank.snapshot(user) : null };
  });

  route('POST', '/api/signup', (ctx) => logIn(ctx, ctx.bank.signup(ctx.body)));
  route('POST', '/api/login', (ctx) => logIn(ctx, ctx.bank.loginPin(ctx.body.who, ctx.body.pin)));

  // `peek` lets the app say whose card was scanned before it switches accounts.
  route('POST', '/api/login/code', (ctx) => {
    const user = ctx.bank.loginCode(ctx.body.code);
    return ctx.body.peek ? { id: user.id, handle: user.handle } : logIn(ctx, user);
  });

  route('POST', '/api/logout', (ctx) => {
    ctx.bank.closeSession(ctx.cookies.sid);
    setCookie(ctx, 'sid', '', 0, ctx.base);
  });

  route('GET', '/api/me', player(async (ctx) => {
    await holdUntilChanged(ctx, ctx.user.id);
    // The account may have been deleted or logged out by the GM while this request was parked.
    const user = ctx.bank.sessionUser(ctx.cookies.sid);
    if (!user) throw new BankError(401, 'AUTH', 'Not logged in.');
    return ctx.bank.snapshot(user);
  }));

  route('GET', '/api/users', player((ctx) => ({ users: ctx.bank.directoryFor(ctx.user) })));
  route('GET', '/api/users/:id', player((ctx) => ctx.bank.lookup(ctx.params.id)));

  route('POST', '/api/transfer', player((ctx) => {
    const tx = ctx.bank.transfer(ctx.user, ctx.body);
    return { tx: ctx.bank.viewFor(tx, ctx.user.id), me: ctx.bank.snapshot(ctx.user) };
  }));

  route('GET', '/api/history', player((ctx) => {
    const before = Number(ctx.url.searchParams.get('before')) || Infinity;
    return { tx: ctx.bank.history(ctx.user, { before, limit: 50 }) };
  }));

  route('POST', '/api/pin', player((ctx) => {
    ctx.bank.setPin(ctx.user, ctx.body.current, ctx.body.next);
    return ctx.bank.snapshot(ctx.user);
  }));

  // ------------------------------------------------------------ game master

  route('POST', '/api/admin/login', (ctx) => {
    throttle(ctx.bank.checkAdminPassword(ctx.body.password) || hub.checkPassword(ctx.body.password));
    ctx.bank.closeSession(ctx.cookies.gm);
    setCookie(ctx, 'gm', ctx.bank.openSession({ admin: true }), COOKIE_AGE_S, ctx.base);
    return gmState(ctx);
  });

  route('POST', '/api/admin/logout', (ctx) => {
    ctx.bank.closeSession(ctx.cookies.gm);
    setCookie(ctx, 'gm', '', 0, ctx.base);
  });

  route('GET', '/api/admin/state', gm(async (ctx) => {
    await holdUntilChanged(ctx, GM_CHANNEL);
    return gmState(ctx);
  }));

  route('GET', '/api/admin/ledger.csv', gm((ctx) => {
    send(ctx, 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="ledger-${ctx.lobby.slug}.csv"`,
      'Cache-Control': 'no-store',
    }, ctx.bank.ledgerCsv());
  }));

  // Every GM action answers with the fresh state, so the console never shows stale numbers.
  route('POST', '/api/admin/users', gm((ctx) => {
    const result = ctx.bank.adminCreate(ctx.body.accounts, ctx.body.balance);
    return { result, ...gmState(ctx) };
  }));

  route('POST', '/api/admin/users/:id', gm((ctx) => {
    ctx.bank.adminUser(ctx.params.id, ctx.body);
    return gmState(ctx);
  }));

  route('POST', '/api/admin/adjust-all', gm((ctx) => {
    ctx.bank.adminAdjustAll(ctx.body.delta, ctx.body.memo);
    return gmState(ctx);
  }));

  route('POST', '/api/admin/reverse', gm((ctx) => {
    ctx.bank.adminReverse(ctx.body.tx);
    return gmState(ctx);
  }));

  route('POST', '/api/admin/settings', gm((ctx) => {
    ctx.bank.adminSettings(ctx.body);
    return gmState(ctx);
  }));

  route('POST', '/api/admin/password', gm((ctx) => {
    ctx.bank.setAdminPassword(ctx.body.password);
    return gmState(ctx);
  }));

  route('POST', '/api/admin/wipe', gm((ctx) => {
    if (ctx.body.confirm !== 'WIPE') throw new BankError(400, 'NOT_CONFIRMED', 'Type WIPE to confirm.');
    ctx.bank.adminWipe();
    return gmState(ctx);
  }));

  // -------------------------------------------------------------------- hub

  // What the login page needs to know before anyone is logged in.
  hubRoutes.add('GET', '/api/hub/info', () => ({ signupsOpen: hub.settings.signupsOpen, needsInvite: Boolean(hub.settings.inviteCode) }));

  // With a name it is an organizer logging in; without one, the server owner with the master password.
  hubRoutes.add('POST', '/api/hub/login', (ctx) => {
    if (ctx.body.name) return hubLogIn(ctx, hub.loginOrganizer(ctx.body.name, ctx.body.password));
    throttle(hub.checkPassword(ctx.body.password));
    return hubLogIn(ctx, null);
  });

  hubRoutes.add('POST', '/api/hub/register', (ctx) => hubLogIn(ctx, hub.register(ctx.body)));

  hubRoutes.add('POST', '/api/hub/logout', (ctx) => {
    hub.closeSession(ctx.cookies.hub);
    setCookie(ctx, 'hub', '', 0);
  });

  hubRoutes.add('GET', '/api/hub/state', account((ctx) => hubState(ctx.viewer)));

  hubRoutes.add('POST', '/api/hub/lobbies', account((ctx) => {
    const lobby = hub.create(ctx.body, ctx.viewer);
    return { created: lobby.slug, ...hubState(ctx.viewer) };
  }));

  hubRoutes.add('POST', '/api/hub/lobbies/:slug', account((ctx) => {
    const { do: action, ...args } = ctx.body;
    const lobby = hub.manage(ctx.viewer, ctx.params.slug);
    if (action === 'rename') hub.rename(lobby.slug, args.title);
    else if (action === 'password') lobby.bank.setAdminPassword(args.password);
    else if (action === 'default') {
      if (!ctx.viewer.master) throw new BankError(403, 'FORBIDDEN', 'Only the server owner can do that.');
      hub.setDefault(lobby.slug);
    } else if (action === 'delete') {
      if (args.confirm !== lobby.slug) throw new BankError(400, 'NOT_CONFIRMED', `Type ${lobby.slug} to confirm.`);
      hub.remove(lobby.slug);
    } else throw new BankError(400, 'BAD_ACTION', 'Unknown action.');
    return hubState(ctx.viewer);
  }));

  hubRoutes.add('POST', '/api/hub/password', account((ctx) => {
    hub.changePassword(ctx.viewer, ctx.body.current, ctx.body.password);
    return hubState(ctx.viewer);
  }));

  hubRoutes.add('POST', '/api/hub/settings', owner((ctx) => {
    hub.updateSettings(ctx.body);
    return hubState(ctx.viewer);
  }));

  hubRoutes.add('POST', '/api/hub/organizers/:id', owner((ctx) => {
    const password = hub.updateOrganizer(ctx.params.id, ctx.body.do);
    return { password, ...hubState(ctx.viewer) };
  }));

  // ------------------------------------------------------------ static files

  async function loadFile(rel) {
    const file = path.join(PUBLIC_DIR, rel);
    const stat = await fs.promises.stat(file);
    if (!stat.isFile()) throw new Error('not a file');
    const etag = `"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`;
    let entry = files.get(file);
    if (entry?.etag !== etag) {
      const raw = await fs.promises.readFile(file);
      const type = TYPES[path.extname(file)] ?? 'application/octet-stream';
      entry = { etag, type, raw, gz: /^(text|image\/svg)/.test(type) ? zlib.gzipSync(raw) : null };
      files.set(file, entry);
    }
    return entry;
  }

  function sendEntry(ctx, entry, cacheControl) {
    const headers = { 'Content-Type': entry.type, ETag: entry.etag, Vary: 'Accept-Encoding', 'Cache-Control': cacheControl };
    if (ctx.req.headers['if-none-match'] === entry.etag) return send(ctx, 304, headers);
    const gzip = entry.gz && /\bgzip\b/.test(ctx.req.headers['accept-encoding'] ?? '');
    if (gzip) headers['Content-Encoding'] = 'gzip';
    const body = gzip ? entry.gz : entry.raw;
    headers['Content-Length'] = body.length;
    send(ctx, 200, headers, body);
  }

  // App pages carry the lobby's theme from the first paint, so the page never flashes the default colours.
  async function sendPage(ctx, name, theme) {
    const entry = await loadFile(name);
    const html = entry.raw.toString('utf8').replace('<html lang="en">', `<html lang="en" data-theme="${theme}">`);
    send(ctx, 200, { 'Content-Type': entry.type, 'Cache-Control': 'no-cache' }, html);
  }

  async function serve(ctx) {
    const { pathname, search } = ctx.url;
    // Plain file names only: no "..", backslashes, drive letters or other ways out of the public folder.
    const rel = pathname.slice(1);
    if (/^[\w-]+(?:\/[\w-]+)*\.[\w.-]+$/.test(rel) && !rel.includes('..')) {
      const entry = await loadFile(rel).catch(() => null);
      if (entry) return sendEntry(ctx, entry, /^(fonts|vendor)\//.test(rel) ? 'public, max-age=604800' : 'no-cache');
    }
    // The front door: players enter their game's code here, hosts find the way to the hub.
    if (pathname === '/') return sendPage(ctx, 'home.html', 'blackwire');
    if (/^\/admin\/?$/.test(pathname)) return sendPage(ctx, 'hub.html', 'blackwire');
    if (LEGACY.test(pathname) && hub.defaultSlug) return redirect(ctx, `/${hub.defaultSlug}${pathname}${search}`);
    const match = LOBBY_APP.exec(pathname) ?? LOBBY_GM.exec(pathname);
    const lobby = match && hub.get(match[1]);
    if (lobby) return sendPage(ctx, LOBBY_GM.test(pathname) ? 'admin.html' : 'index.html', lobby.bank.settings.theme);
    // A mistyped game address goes back to the front door, which says what went wrong.
    if (match) return redirect(ctx, `/?missing=${encodeURIComponent(match[1])}`);
    send(ctx, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not found');
  }

  // ----------------------------------------------------------------- server

  async function handle(req, res) {
    const ctx = { req, res, params: {}, cookies: parseCookies(req.headers.cookie), cookiesOut: [] };
    try {
      ctx.url = new URL(req.url, 'http://localhost');
      const { pathname } = ctx.url;
      let found = null;
      if (pathname.startsWith('/api/hub/')) {
        found = hubRoutes.find(req.method, pathname);
      } else {
        const inLobby = LOBBY_API.exec(pathname);
        if (inLobby) {
          ctx.lobby = hub.must(inLobby[1]);
          ctx.bank = ctx.lobby.bank;
          ctx.base = `/${ctx.lobby.slug}`;
          found = lobbyRoutes.find(req.method, inLobby[2]);
        }
      }
      if (found) {
        ctx.params = found.params;
        if (req.method === 'POST') ctx.body = await readJson(req);
        const result = await found.handler(ctx);
        // A parked long poll whose phone went away has nobody left to answer.
        if (!res.writableEnded && !res.destroyed) sendJson(ctx, 200, result ?? { ok: true });
        return;
      }
      if (pathname.includes('/api/')) return sendError(ctx, 404, 'NOT_FOUND', 'No such endpoint.');
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(ctx, 405, 'BAD_METHOD', 'Method not allowed.');
      await serve(ctx);
    } catch (err) {
      if (res.headersSent || res.destroyed) return res.destroy();
      if (err instanceof BankError) return sendError(ctx, err.status, err.code, err.message);
      if (err instanceof URIError || err.code === 'ERR_INVALID_URL') return sendError(ctx, 400, 'BAD_REQUEST', 'Malformed request.');
      console.error(err);
      sendError(ctx, 500, 'SERVER', 'The grid glitched. Try again.');
    }
  }

  return http.createServer(handle);
}

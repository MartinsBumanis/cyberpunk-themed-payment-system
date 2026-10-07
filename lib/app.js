import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { BankError, GM_CHANNEL } from './bank.js';

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

// Pages served for app URLs. QR codes carry /pay/<id> and /l/<code> so any phone camera can open them.
const SHELLS = [
  [/^\/(?:(?:pay|l)\/[^/]+)?$/, 'index.html'],
  [/^\/admin\/?$/, 'admin.html'],
];

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

export function createApp(bank, { lanUrls = () => [] } = {}) {
  const routes = [];
  const files = new Map();
  const gmFails = [];

  function route(method, pattern, handler) {
    const keys = [];
    const source = pattern.replace(/:(\w+)/g, (_, key) => {
      keys.push(key);
      return '([^/]+)';
    });
    routes.push({ method, regex: new RegExp(`^${source}$`), keys, handler });
  }

  function setCookie(ctx, name, value, maxAge) {
    const secure = ctx.req.headers['x-forwarded-proto'] === 'https' || ctx.req.socket.encrypted;
    ctx.cookiesOut.push(
      `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`,
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

  const player = (handler) => (ctx) => {
    ctx.user = bank.sessionUser(ctx.cookies.sid);
    if (!ctx.user) throw new BankError(401, 'AUTH', 'Not logged in.');
    bank.markSeen(ctx.user.id);
    return handler(ctx);
  };

  const gm = (handler) => (ctx) => {
    if (!bank.isGm(ctx.cookies.gm)) throw new BankError(401, 'AUTH', 'Game master login required.');
    return handler(ctx);
  };

  const gmState = () => ({ ...bank.adminState(), urls: lanUrls() });

  // Long poll: if the caller is already up to date, hold the request until something changes for them.
  async function holdUntilChanged(ctx, channel) {
    if (ctx.url.searchParams.get('wait') !== bank.revOf(channel)) return;
    const { done, cancel } = bank.wait(channel, POLL_MS);
    ctx.res.once('close', cancel);
    await done;
    ctx.res.off('close', cancel);
  }

  function logIn(ctx, user) {
    bank.closeSession(ctx.cookies.sid);
    setCookie(ctx, 'sid', bank.openSession({ uid: user.id }), COOKIE_AGE_S);
    bank.markSeen(user.id);
    return bank.snapshot(user);
  }

  // ---------------------------------------------------------------- players

  // Everything the app needs to start, in one round trip: the bank's public settings and, if logged in, the account.
  route('GET', '/api/boot', (ctx) => {
    const user = bank.sessionUser(ctx.cookies.sid);
    if (user) bank.markSeen(user.id);
    return { config: bank.publicConfig(), me: user ? bank.snapshot(user) : null };
  });

  route('POST', '/api/signup', (ctx) => logIn(ctx, bank.signup(ctx.body)));
  route('POST', '/api/login', (ctx) => logIn(ctx, bank.loginPin(ctx.body.who, ctx.body.pin)));

  // `peek` lets the app say whose card was scanned before it switches accounts.
  route('POST', '/api/login/code', (ctx) => {
    const user = bank.loginCode(ctx.body.code);
    return ctx.body.peek ? { id: user.id, handle: user.handle } : logIn(ctx, user);
  });

  route('POST', '/api/logout', (ctx) => {
    bank.closeSession(ctx.cookies.sid);
    setCookie(ctx, 'sid', '', 0);
  });

  route('GET', '/api/me', player(async (ctx) => {
    await holdUntilChanged(ctx, ctx.user.id);
    // The account may have been deleted or logged out by the GM while this request was parked.
    const user = bank.sessionUser(ctx.cookies.sid);
    if (!user) throw new BankError(401, 'AUTH', 'Not logged in.');
    return bank.snapshot(user);
  }));

  route('GET', '/api/users', player((ctx) => ({ users: bank.directoryFor(ctx.user) })));
  route('GET', '/api/users/:id', player((ctx) => bank.lookup(ctx.params.id)));

  route('POST', '/api/transfer', player((ctx) => {
    const tx = bank.transfer(ctx.user, ctx.body);
    return { tx: bank.viewFor(tx, ctx.user.id), me: bank.snapshot(ctx.user) };
  }));

  route('GET', '/api/history', player((ctx) => {
    const before = Number(ctx.url.searchParams.get('before')) || Infinity;
    return { tx: bank.history(ctx.user, { before, limit: 50 }) };
  }));

  route('POST', '/api/pin', player((ctx) => {
    bank.setPin(ctx.user, ctx.body.current, ctx.body.next);
    return bank.snapshot(ctx.user);
  }));

  // ------------------------------------------------------------ game master

  route('POST', '/api/admin/login', (ctx) => {
    const now = Date.now();
    while (gmFails.length && gmFails[0] < now - 60_000) gmFails.shift();
    if (gmFails.length >= 8) throw new BankError(429, 'SLOW_DOWN', 'Too many attempts. Wait a minute.');
    if (!bank.checkAdminPassword(ctx.body.password)) {
      gmFails.push(now);
      throw new BankError(401, 'BAD_PASSWORD', 'Wrong password.');
    }
    bank.closeSession(ctx.cookies.gm);
    setCookie(ctx, 'gm', bank.openSession({ admin: true }), COOKIE_AGE_S);
    return gmState();
  });

  route('POST', '/api/admin/logout', (ctx) => {
    bank.closeSession(ctx.cookies.gm);
    setCookie(ctx, 'gm', '', 0);
  });

  route('GET', '/api/admin/state', gm(async (ctx) => {
    await holdUntilChanged(ctx, GM_CHANNEL);
    return gmState();
  }));

  route('GET', '/api/admin/ledger.csv', gm((ctx) => {
    send(ctx, 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="ledger.csv"',
      'Cache-Control': 'no-store',
    }, bank.ledgerCsv());
  }));

  // Every GM action answers with the fresh state, so the console never shows stale numbers.
  route('POST', '/api/admin/users', gm((ctx) => {
    const result = bank.adminCreate(ctx.body.accounts, ctx.body.balance);
    return { result, ...gmState() };
  }));

  route('POST', '/api/admin/users/:id', gm((ctx) => {
    bank.adminUser(ctx.params.id, ctx.body);
    return gmState();
  }));

  route('POST', '/api/admin/adjust-all', gm((ctx) => {
    bank.adminAdjustAll(ctx.body.delta, ctx.body.memo);
    return gmState();
  }));

  route('POST', '/api/admin/reverse', gm((ctx) => {
    bank.adminReverse(ctx.body.tx);
    return gmState();
  }));

  route('POST', '/api/admin/settings', gm((ctx) => {
    bank.adminSettings(ctx.body);
    return gmState();
  }));

  route('POST', '/api/admin/wipe', gm((ctx) => {
    if (ctx.body.confirm !== 'WIPE') throw new BankError(400, 'NOT_CONFIRMED', 'Type WIPE to confirm.');
    bank.adminWipe();
    return gmState();
  }));

  // ------------------------------------------------------------ static files

  async function loadFile(file) {
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

  async function serveStatic(ctx) {
    const { req, url } = ctx;
    const shell = SHELLS.find(([pattern]) => pattern.test(url.pathname));
    const rel = shell ? shell[1] : url.pathname.slice(1);
    let entry = null;
    // Plain names only: no "..", backslashes, drive letters or other ways out of the public folder.
    if (/^[\w-]+(?:[./][\w-]+)*$/.test(rel)) {
      entry = await loadFile(path.join(PUBLIC_DIR, rel)).catch(() => null);
    }
    if (!entry) return send(ctx, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not found');
    const headers = {
      'Content-Type': entry.type,
      ETag: entry.etag,
      Vary: 'Accept-Encoding',
      'Cache-Control': /^(fonts|vendor)\//.test(rel) ? 'public, max-age=604800' : 'no-cache',
    };
    if (req.headers['if-none-match'] === entry.etag) return send(ctx, 304, headers);
    const gzip = entry.gz && /\bgzip\b/.test(req.headers['accept-encoding'] ?? '');
    if (gzip) headers['Content-Encoding'] = 'gzip';
    const body = gzip ? entry.gz : entry.raw;
    headers['Content-Length'] = body.length;
    send(ctx, 200, headers, body);
  }

  // ----------------------------------------------------------------- server

  async function handle(req, res) {
    const ctx = { req, res, params: {}, cookies: parseCookies(req.headers.cookie), cookiesOut: [] };
    try {
      ctx.url = new URL(req.url, 'http://localhost');
      for (const { method, regex, keys, handler } of routes) {
        const match = method === req.method && regex.exec(ctx.url.pathname);
        if (!match) continue;
        keys.forEach((key, i) => {
          ctx.params[key] = decodeURIComponent(match[i + 1]);
        });
        if (method === 'POST') ctx.body = await readJson(req);
        const result = await handler(ctx);
        // A parked long poll whose phone went away has nobody left to answer.
        if (!res.writableEnded && !res.destroyed) sendJson(ctx, 200, result ?? { ok: true });
        return;
      }
      if (ctx.url.pathname.startsWith('/api/')) return sendError(ctx, 404, 'NOT_FOUND', 'No such endpoint.');
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(ctx, 405, 'BAD_METHOD', 'Method not allowed.');
      await serveStatic(ctx);
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

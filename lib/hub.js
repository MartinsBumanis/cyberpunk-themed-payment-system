import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Bank, BankError, THEMES } from './bank.js';

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
// First path segments the server uses itself, so no lobby may take them.
const RESERVED = new Set(['admin', 'api', 'fonts', 'vendor', 'pay', 'l', 'hub', 'static', 'assets']);
const MAX_LOBBIES = 300;
const MAX_ORGANIZERS = 1000;
const LOGIN_TRIES = 5;
const LOGIN_LOCK_MS = 60_000;

const DEFAULT_SETTINGS = {
  signupsOpen: true, // anyone may register an organizer account
  inviteCode: '', // if set, registering needs it
  maxLobbies: 5, // per organizer; the server owner has no limit
};

function fail(status, code, message) {
  throw new BankError(status, code, message);
}

function randomCode(length) {
  return Array.from(crypto.randomBytes(length), (byte) => ALPHABET[byte & 31]).join('');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(password, salt, 32).toString('hex') };
}

function passwordMatches(password, stored) {
  const candidate = crypto.scryptSync(String(password ?? '').slice(0, 200), stored.salt, 32);
  return crypto.timingSafeEqual(candidate, Buffer.from(stored.hash, 'hex'));
}

function checkNewPassword(raw) {
  const password = String(raw ?? '');
  if (password.length < 6 || password.length > 200) fail(400, 'BAD_PASSWORD', 'A password needs at least 6 characters.');
  return password;
}

export function slugify(title) {
  return String(title ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 32)
    .replace(/-+$/, '');
}

function cleanTitle(raw, max = 40) {
  return Array.from(String(raw ?? '').replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim()).slice(0, max).join('').trim();
}

const nameKey = (name) => name.normalize('NFKC').toLowerCase();

// The games on this server and the people who run them.
//
// The server owner signs in with the master password and can do everything. Organizers register their
// own accounts and see and run only the lobbies they created. Each lobby is a separate Bank with its
// own file, so accounts, ledger, settings and GM password never mix between games.
//
// A "viewer" is who a hub session belongs to: { master: true } or { org: <organizer> }.
export class Hub {
  #dir;
  #file;
  #envPassword;
  #storedPassword = null;
  #sessions = new Map(); // token -> { at, org } with org null for the server owner
  #organizers = new Map();
  #byName = new Map();
  #fails = new Map();
  #registrations = [];
  #dirty = false;
  #saveTimer = null;

  lobbies = new Map();
  defaultSlug = null;
  settings = { ...DEFAULT_SETTINGS };

  // Without a directory everything lives in memory, which is what the tests use.
  constructor({ dir = null, password = null } = {}) {
    this.#dir = dir;
    this.#file = dir ? path.join(dir, 'hub.json') : null;
    this.#envPassword = password || null;
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
      this.#migrate();
      this.#load();
    }
    if (!this.#envPassword && !this.#storedPassword) {
      this.#storedPassword = `${randomCode(4)}-${randomCode(4)}`;
      this.#save();
    }
  }

  get password() {
    return this.#envPassword ?? this.#storedPassword;
  }

  get(slug) {
    return this.lobbies.get(String(slug ?? '').toLowerCase()) ?? null;
  }

  must(slug) {
    const lobby = this.get(slug);
    if (!lobby) fail(404, 'NO_LOBBY', 'No such lobby.');
    return lobby;
  }

  // ------------------------------------------------------------- who is who

  viewer(token) {
    const session = typeof token === 'string' ? this.#sessions.get(token) : null;
    if (!session || session.at + SESSION_MS < Date.now()) return null;
    if (!session.org) return { master: true };
    const org = this.#organizers.get(session.org);
    return org && !org.disabled ? { org } : null;
  }

  isMaster(token) {
    return Boolean(this.viewer(token)?.master);
  }

  canManage(viewer, lobby) {
    return Boolean(viewer && lobby && (viewer.master || lobby.owner === viewer.org?.id));
  }

  // The lobby, if this viewer may run it. Others get "no such lobby", so organizers can't probe each other's games.
  manage(viewer, slug) {
    const lobby = this.get(slug);
    if (!this.canManage(viewer, lobby)) fail(404, 'NO_LOBBY', 'No such lobby.');
    return lobby;
  }

  checkPassword(password) {
    const digest = (text) => crypto.createHash('sha256').update(String(text ?? '')).digest();
    return crypto.timingSafeEqual(digest(password), digest(this.password));
  }

  // Few registrations an hour in total, so a script can't fill the server with accounts.
  register({ name, password, invite } = {}) {
    if (!this.settings.signupsOpen) fail(403, 'SIGNUPS_CLOSED', 'Registration is closed on this server. Ask its owner for an account.');
    if (this.settings.inviteCode && nameKey(cleanTitle(invite, 64)) !== nameKey(this.settings.inviteCode)) {
      fail(403, 'BAD_INVITE', 'Wrong invite code.');
    }
    const clean = cleanTitle(name, 24);
    if (Array.from(clean).length < 3) fail(400, 'BAD_NAME', 'A name needs 3 to 24 characters.');
    if (this.#byName.has(nameKey(clean))) fail(409, 'NAME_TAKEN', `"${clean}" is already taken.`);
    const secret = checkNewPassword(password);
    const now = Date.now();
    this.#registrations = this.#registrations.filter((at) => at > now - 3_600_000);
    if (this.#registrations.length >= 30 || this.#organizers.size >= MAX_ORGANIZERS) {
      fail(429, 'SLOW_DOWN', 'Too many new accounts right now. Try again later.');
    }
    this.#registrations.push(now);
    let id;
    do id = randomCode(8);
    while (this.#organizers.has(id));
    const org = { id, name: clean, pass: hashPassword(secret), createdAt: now, disabled: false };
    this.#organizers.set(id, org);
    this.#byName.set(nameKey(clean), org);
    this.#save();
    return org;
  }

  loginOrganizer(name, password) {
    const org = this.#byName.get(nameKey(cleanTitle(name, 24)));
    if (!org) fail(401, 'BAD_LOGIN', 'Unknown name or wrong password.');
    const lock = this.#fails.get(org.id);
    if (lock?.until > Date.now()) {
      fail(429, 'LOCKED', `Too many wrong passwords. Try again in ${Math.ceil((lock.until - Date.now()) / 1000)}s.`);
    }
    if (!passwordMatches(password, org.pass)) {
      const tries = (lock?.tries ?? 0) + 1;
      this.#fails.set(org.id, tries >= LOGIN_TRIES ? { tries: 0, until: Date.now() + LOGIN_LOCK_MS } : { tries, until: 0 });
      fail(401, 'BAD_LOGIN', 'Unknown name or wrong password.');
    }
    this.#fails.delete(org.id);
    if (org.disabled) fail(403, 'DISABLED', 'This account has been disabled by the server owner.');
    return org;
  }

  openSession(org = null) {
    const token = crypto.randomBytes(24).toString('base64url');
    this.#sessions.set(token, { at: Date.now(), org: org?.id ?? null });
    this.#save();
    return token;
  }

  closeSession(token) {
    if (this.#sessions.delete(token)) this.#save();
  }

  changePassword(viewer, current, next) {
    if (viewer.master) return this.setPassword(next);
    if (!passwordMatches(current, viewer.org.pass)) fail(403, 'BAD_PASSWORD', 'Current password is wrong.');
    viewer.org.pass = hashPassword(checkNewPassword(next));
    this.#save();
  }

  setPassword(raw) {
    const password = String(raw ?? '').trim();
    if (password.length < 4) fail(400, 'BAD_PASSWORD', 'The password needs at least 4 characters.');
    this.#envPassword = null;
    this.#storedPassword = password;
    this.#save();
  }

  // ------------------------------------------------------------ the owner

  organizers() {
    const owned = new Map();
    for (const lobby of this.lobbies.values()) {
      if (lobby.owner) owned.set(lobby.owner, (owned.get(lobby.owner) ?? 0) + 1);
    }
    return [...this.#organizers.values()]
      .map(({ id, name, createdAt, disabled }) => ({ id, name, createdAt, disabled, lobbies: owned.get(id) ?? 0 }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // Returns a new password for 'reset', the only way back in for someone who forgot theirs.
  updateOrganizer(id, action) {
    const org = this.#organizers.get(id);
    if (!org) fail(404, 'NO_ORGANIZER', 'No such organizer.');
    let password = null;
    if (action === 'disable' || action === 'enable') org.disabled = action === 'disable';
    else if (action === 'reset') {
      password = `${randomCode(4)}-${randomCode(4)}-${randomCode(4)}`;
      org.pass = hashPassword(password);
      this.#fails.delete(org.id);
    } else if (action === 'delete') {
      for (const lobby of [...this.lobbies.values()]) {
        if (lobby.owner === org.id) this.remove(lobby.slug);
      }
      this.#organizers.delete(org.id);
      this.#byName.delete(nameKey(org.name));
    } else fail(400, 'BAD_ACTION', 'Unknown action.');
    if (action !== 'enable') {
      for (const [token, session] of this.#sessions) {
        if (session.org === org.id) this.#sessions.delete(token);
      }
    }
    this.#save();
    return password;
  }

  updateSettings(patch = {}) {
    const next = { ...this.settings };
    if ('signupsOpen' in patch) next.signupsOpen = Boolean(patch.signupsOpen);
    if ('inviteCode' in patch) next.inviteCode = cleanTitle(patch.inviteCode, 64);
    if ('maxLobbies' in patch) {
      if (!Number.isSafeInteger(patch.maxLobbies) || patch.maxLobbies < 0 || patch.maxLobbies > 100) {
        fail(400, 'BAD_SETTING', 'The lobby limit must be a whole number from 0 to 100.');
      }
      next.maxLobbies = patch.maxLobbies;
    }
    this.settings = next;
    this.#save();
  }

  // ------------------------------------------------------------- lobbies

  list(viewer) {
    return [...this.lobbies.values()]
      .filter((lobby) => this.canManage(viewer, lobby))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(({ slug, title, createdAt, owner, bank }) => ({
        slug,
        title,
        createdAt,
        owner: owner ? this.#organizers.get(owner)?.name ?? '?' : null,
        isDefault: slug === this.defaultSlug,
        bankName: bank.settings.bankName,
        currency: bank.settings.currency,
        theme: bank.settings.theme,
        gmPassword: bank.adminPassword,
        ...bank.summary(),
      }));
  }

  // A new lobby can start from another one's settings, and optionally its cast (fresh balances and cards).
  // Without a viewer (tests, scripts) it belongs to the server owner.
  create({ title, slug, theme, copyFrom, copyCast } = {}, viewer = { master: true }) {
    const org = viewer.org ?? null;
    if (org && [...this.lobbies.values()].filter((lobby) => lobby.owner === org.id).length >= this.settings.maxLobbies) {
      fail(409, 'LIMIT', `You can have up to ${this.settings.maxLobbies} lobbies. Delete one to make room.`);
    }
    if (this.lobbies.size >= MAX_LOBBIES) fail(409, 'LIMIT', 'This server has no room for more lobbies.');
    const name = cleanTitle(title);
    if (!name) fail(400, 'BAD_TITLE', 'Give the lobby a name.');
    const chosen = slugify(slug);
    let final = chosen || slugify(name) || 'game';
    if (!SLUG_RE.test(final) || RESERVED.has(final)) fail(400, 'BAD_SLUG', `"${final}" can't be used as an address.`);
    if (this.lobbies.has(final)) {
      if (chosen) fail(409, 'SLUG_TAKEN', `The address /${final} is already in use.`);
      let n = 2;
      while (this.lobbies.has(`${final.slice(0, 29)}-${n}`)) n++;
      final = `${final.slice(0, 29)}-${n}`;
    }
    if (theme != null && !THEMES.includes(theme)) fail(400, 'BAD_SETTING', 'Unknown theme.');
    const source = copyFrom ? this.manage(viewer, copyFrom) : null;

    const lobby = this.#open(final, name, Date.now(), org?.id ?? null);
    if (source) lobby.bank.adminSettings({ ...source.bank.settings });
    if (theme) lobby.bank.adminSettings({ theme });
    const cast = source && copyCast ? source.bank.handles() : [];
    if (cast.length) lobby.bank.adminCreate(cast.map((handle) => ({ handle })));
    // Only the owner's lobbies become the server's front page, never a stranger's.
    if (!org) this.defaultSlug ??= final;
    this.#save();
    return lobby;
  }

  rename(slug, title) {
    const lobby = this.must(slug);
    const name = cleanTitle(title);
    if (!name) fail(400, 'BAD_TITLE', 'Give the lobby a name.');
    lobby.title = name;
    this.#save();
  }

  setDefault(slug) {
    this.defaultSlug = this.must(slug).slug;
    this.#save();
  }

  // Nothing is destroyed: the lobby's folder moves to data/deleted, so a mistake can be undone by hand.
  remove(slug) {
    const lobby = this.must(slug);
    lobby.bank.flushSync();
    this.lobbies.delete(lobby.slug);
    if (this.defaultSlug === lobby.slug) {
      this.defaultSlug = [...this.lobbies.values()].filter((other) => !other.owner).sort((a, b) => b.createdAt - a.createdAt)[0]?.slug ?? null;
    }
    if (this.#dir) {
      const from = path.join(this.#dir, 'lobbies', lobby.slug);
      const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
      const to = path.join(this.#dir, 'deleted', `${lobby.slug}-${stamp}`);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
    this.#save();
  }

  // ---------------------------------------------------------- persistence

  flushSync() {
    for (const { bank } of this.lobbies.values()) bank.flushSync();
    clearTimeout(this.#saveTimer);
    this.#saveTimer = null;
    if (!this.#file || !this.#dirty) return;
    const tmp = `${this.#file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({
        version: 2,
        password: this.#storedPassword,
        default: this.defaultSlug,
        settings: this.settings,
        organizers: [...this.#organizers.values()],
        lobbies: [...this.lobbies.values()].map(({ slug, title, createdAt, owner }) => ({ slug, title, createdAt, owner })),
        sessions: [...this.#sessions].map(([token, session]) => ({ token, ...session })),
      }));
      fs.renameSync(tmp, this.#file);
      this.#dirty = false;
    } catch (err) {
      console.error(`[hub] could not save ${this.#file}: ${err.message} (retrying)`);
      this.#saveTimer = setTimeout(() => this.flushSync(), 1000);
    }
  }

  #open(slug, title, createdAt, owner = null) {
    const file = this.#dir ? path.join(this.#dir, 'lobbies', slug, 'db.json') : null;
    const lobby = { slug, title, createdAt, owner, bank: new Bank({ file }) };
    this.lobbies.set(slug, lobby);
    return lobby;
  }

  #save() {
    if (!this.#file) return;
    this.#dirty = true;
    this.#saveTimer ??= setTimeout(() => this.flushSync(), 40);
  }

  #load() {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(this.#file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    this.#storedPassword = data.password ?? null;
    this.settings = { ...DEFAULT_SETTINGS, ...data.settings };
    for (const org of data.organizers ?? []) {
      this.#organizers.set(org.id, org);
      this.#byName.set(nameKey(org.name), org);
    }
    for (const { slug, title, createdAt, owner } of data.lobbies ?? []) this.#open(slug, title, createdAt, owner ?? null);
    this.defaultSlug = this.lobbies.has(data.default) ? data.default : null;
    const cutoff = Date.now() - SESSION_MS;
    // Sessions saved before organizers existed have no `org`: they were the owner's.
    for (const { token, at, org = null } of data.sessions ?? []) {
      if (at > cutoff) this.#sessions.set(token, { at, org });
    }
  }

  // Before lobbies existed, the whole bank was data/db.json. It becomes the lobby "main", its old
  // GM password becomes the master password, and its links keep working through the default lobby.
  #migrate() {
    const old = path.join(this.#dir, 'db.json');
    if (fs.existsSync(this.#file) || !fs.existsSync(old)) return;
    const data = JSON.parse(fs.readFileSync(old, 'utf8'));
    const target = path.join(this.#dir, 'lobbies', 'main');
    fs.mkdirSync(target, { recursive: true });
    fs.renameSync(old, path.join(target, 'db.json'));
    const backups = path.join(this.#dir, 'backups');
    if (fs.existsSync(backups)) fs.renameSync(backups, path.join(target, 'backups'));
    fs.writeFileSync(this.#file, JSON.stringify({
      version: 2,
      password: data.adminPassword ?? null,
      default: 'main',
      lobbies: [{ slug: 'main', title: data.settings?.bankName ?? 'Main', createdAt: Date.now(), owner: null }],
      sessions: [],
    }));
  }
}

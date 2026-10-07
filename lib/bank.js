import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// No 0/O/1/I, so codes survive being read aloud or typed off a printed card.
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const MAX_AMOUNT = 1_000_000_000;
const MAX_USERS = 500;
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const PIN_RE = /^\d{4,8}$/;
const PIN_TRIES = 5;
const PIN_LOCK_MS = 60_000;
const ONLINE_MS = 40_000;
const BACKUPS_KEPT = 10;

// Changes on every start, so a revision token from a previous run never matches the current one.
const BOOT = crypto.randomBytes(3).toString('hex');

export const GM_CHANNEL = '*gm';

const DEFAULT_SETTINGS = {
  bankName: 'BLACKWIRE',
  currency: '¥',
  startingBalance: 1000,
  signupsOpen: true,
  joinCode: '',
  directory: true,
};

export class BankError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function fail(status, code, message) {
  throw new BankError(status, code, message);
}

function randomCode(length) {
  return Array.from(crypto.randomBytes(length), (byte) => ALPHABET[byte & 31]).join('');
}

// Characters that draw nothing: zero-width and bidi-override marks, plus the filler letters people use for "empty" names.
const BLANKS = new RegExp(`[\\p{Cf}${String.fromCodePoint(0x115f, 0x1160, 0x2800, 0x3164, 0xffa0)}]`, 'gu');

// Lets spreadsheet apps recognise the CSV export as UTF-8.
const BOM = String.fromCodePoint(0xfeff);

// Without this a handle could look blank, hide extra characters or imitate another one.
function cleanText(value, max) {
  const text = String(value ?? '')
    .normalize('NFC')
    .replace(BLANKS, '')
    .replace(/[\p{Cc}\s]+/gu, ' ')
    .trim();
  return Array.from(text).slice(0, max).join('').trim();
}

const handleKey = (handle) => handle.normalize('NFKC').toLowerCase();

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(pin, salt, 32).toString('hex') };
}

function pinMatches(pin, stored) {
  const candidate = crypto.scryptSync(String(pin ?? '').slice(0, 16), stored.salt, 32);
  return crypto.timingSafeEqual(candidate, Buffer.from(stored.hash, 'hex'));
}

function toAmount(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_AMOUNT ? value : null;
}

function isBalance(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_AMOUNT;
}

export class Bank {
  #file;
  #envPassword;
  #storedPassword = null;
  #byHandle = new Map();
  #byCode = new Map();
  #revs = new Map();
  #epoch = 0;
  #waiters = new Map();
  #pinFails = new Map();
  #seen = new Map();
  #dirty = false;
  #saveTimer = null;

  settings = { ...DEFAULT_SETTINGS };
  users = new Map();
  sessions = new Map();
  tx = [];
  nextTx = 1;

  // Without a file the bank lives in memory only, which is what the tests use.
  constructor({ file = null, adminPassword = null } = {}) {
    this.#file = file;
    this.#envPassword = adminPassword || null;
    if (file) this.#load();
    if (!this.#envPassword && !this.#storedPassword) {
      this.#storedPassword = `${randomCode(4)}-${randomCode(4)}`;
      this.#save();
    }
  }

  get adminPassword() {
    return this.#envPassword ?? this.#storedPassword;
  }

  // ---------------------------------------------------------------- players

  publicConfig() {
    const { bankName, currency, signupsOpen, joinCode } = this.settings;
    return { bankName, currency, signupsOpen, needsJoinCode: Boolean(joinCode) };
  }

  signup({ handle, pin, joinCode } = {}) {
    const { signupsOpen, joinCode: required, startingBalance } = this.settings;
    if (!signupsOpen) fail(403, 'SIGNUPS_CLOSED', 'New accounts are closed. Ask your game master.');
    if (required && handleKey(cleanText(joinCode, 32)) !== handleKey(required)) {
      fail(403, 'BAD_JOIN_CODE', 'Wrong join code.');
    }
    if (!PIN_RE.test(String(pin ?? ''))) fail(400, 'BAD_PIN', 'PIN must be 4 to 8 digits.');
    const user = this.#createUser(handle, startingBalance);
    user.pin = hashPin(String(pin));
    this.#touch(user.id);
    return user;
  }

  loginPin(who, pin) {
    const user = this.#find(who);
    if (!user) fail(401, 'BAD_LOGIN', 'Unknown handle or wrong PIN.');
    const lock = this.#pinFails.get(user.id);
    if (lock?.until > Date.now()) {
      const seconds = Math.ceil((lock.until - Date.now()) / 1000);
      fail(429, 'LOCKED', `Too many wrong PINs. Try again in ${seconds}s.`);
    }
    if (!user.pin) fail(401, 'NO_PIN', 'This account has no PIN. Log in with its access card instead.');
    if (!pinMatches(pin, user.pin)) {
      const tries = (lock?.tries ?? 0) + 1;
      this.#pinFails.set(
        user.id,
        tries >= PIN_TRIES ? { tries: 0, until: Date.now() + PIN_LOCK_MS } : { tries, until: 0 },
      );
      fail(401, 'BAD_LOGIN', 'Unknown handle or wrong PIN.');
    }
    this.#pinFails.delete(user.id);
    return user;
  }

  loginCode(rawCode) {
    const code = String(rawCode ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const user = this.#byCode.get(code);
    if (!user) fail(401, 'BAD_CODE', 'That access code is not valid.');
    return user;
  }

  setPin(user, current, next) {
    if (user.pin && !pinMatches(current, user.pin)) fail(403, 'BAD_PIN', 'Current PIN is wrong.');
    if (!PIN_RE.test(String(next ?? ''))) fail(400, 'BAD_PIN', 'PIN must be 4 to 8 digits.');
    user.pin = hashPin(String(next));
    this.#touch(user.id);
  }

  openSession(subject) {
    const token = crypto.randomBytes(24).toString('base64url');
    this.sessions.set(token, { ...subject, at: Date.now() });
    this.#save();
    return token;
  }

  closeSession(token) {
    if (this.sessions.delete(token)) this.#save();
  }

  sessionUser(token) {
    const session = this.#session(token);
    return (session?.uid && this.users.get(session.uid)) || null;
  }

  isGm(token) {
    return Boolean(this.#session(token)?.admin);
  }

  checkAdminPassword(password) {
    const digest = (text) => crypto.createHash('sha256').update(String(text ?? '')).digest();
    return crypto.timingSafeEqual(digest(password), digest(this.adminPassword));
  }

  markSeen(uid) {
    this.#seen.set(uid, Date.now());
  }

  snapshot(user) {
    const { bankName, currency, directory } = this.settings;
    return {
      rev: this.revOf(user.id),
      user: {
        id: user.id,
        handle: user.handle,
        balance: user.balance,
        frozen: user.frozen,
        hasPin: Boolean(user.pin),
      },
      settings: { bankName, currency, directory },
      tx: this.history(user, { limit: 30 }),
    };
  }

  history(user, { before = Infinity, limit = 50 } = {}) {
    const rows = [];
    for (let i = this.tx.length - 1; i >= 0 && rows.length < limit; i--) {
      const tx = this.tx[i];
      if (tx.id < before && (tx.from === user.id || tx.to === user.id)) rows.push(this.viewFor(tx, user.id));
    }
    return rows;
  }

  viewFor(tx, uid) {
    const incoming = tx.to === uid;
    return {
      id: tx.id,
      at: tx.at,
      kind: tx.kind,
      dir: incoming ? 'in' : 'out',
      amount: tx.amount,
      memo: tx.memo,
      peer: incoming ? this.#party(tx.from, tx.fromName) : this.#party(tx.to, tx.toName),
      // Lets the sender's phone recognise its own payment when the reply to the request got lost.
      ...(tx.key && !incoming ? { key: tx.key } : {}),
    };
  }

  // Pay codes carry an ID, so this must never fall back to matching a handle:
  // otherwise someone could name themselves after another account's ID and collect its payments.
  lookup(rawId) {
    const user = this.users.get(String(rawId ?? '').toUpperCase());
    if (!user) fail(404, 'NO_ACCOUNT', 'No account with that ID.');
    return { id: user.id, handle: user.handle };
  }

  // With the public directory switched off, players only see people they have already traded with.
  directoryFor(user) {
    let listed = [...this.users.values()];
    if (!this.settings.directory) {
      const known = new Set();
      for (const tx of this.tx) {
        if (tx.from === user.id) known.add(tx.to);
        else if (tx.to === user.id) known.add(tx.from);
      }
      listed = listed.filter((other) => known.has(other.id));
    }
    return listed
      .filter((other) => other.id !== user.id)
      .map(({ id, handle }) => ({ id, handle }))
      .sort((a, b) => a.handle.localeCompare(b.handle));
  }

  transfer(sender, { to, amount, memo, key } = {}) {
    if (sender.frozen) fail(403, 'FROZEN', 'This account is frozen. Talk to your game master.');
    // A retry after a dropped connection carries the same key and must not pay twice.
    const idem = typeof key === 'string' && key ? key.slice(0, 64) : null;
    if (idem) {
      const floor = Math.max(0, this.tx.length - 500);
      for (let i = this.tx.length - 1; i >= floor; i--) {
        if (this.tx[i].from === sender.id && this.tx[i].key === idem) return this.tx[i];
      }
    }
    const recipient = this.users.get(String(to ?? '').toUpperCase());
    if (!recipient) fail(404, 'NO_ACCOUNT', 'No account with that ID.');
    if (recipient.id === sender.id) fail(400, 'SELF', "You can't pay yourself.");
    const sum = toAmount(amount);
    if (!sum) fail(400, 'BAD_AMOUNT', 'Enter a whole amount of at least 1.');
    if (sum > sender.balance) fail(409, 'INSUFFICIENT_FUNDS', 'Insufficient funds.');
    sender.balance -= sum;
    recipient.balance += sum;
    const tx = this.#record('transfer', sender, recipient, sum, cleanText(memo, 80), idem ? { key: idem } : {});
    this.#touch(sender.id, recipient.id);
    return tx;
  }

  // ---------------------------------------------------------- game master

  adminState() {
    const now = Date.now();
    const users = [...this.users.values()]
      .map((user) => ({
        id: user.id,
        handle: user.handle,
        balance: user.balance,
        frozen: user.frozen,
        hasPin: Boolean(user.pin),
        code: user.code,
        createdAt: user.createdAt,
        online: now - (this.#seen.get(user.id) ?? 0) < ONLINE_MS,
      }))
      .sort((a, b) => a.handle.localeCompare(b.handle));
    return {
      rev: this.revOf(GM_CHANNEL),
      settings: { ...this.settings },
      users,
      supply: users.reduce((sum, user) => sum + user.balance, 0),
      tx: this.adminLedger(300),
      txCount: this.tx.length,
    };
  }

  adminLedger(limit = Infinity) {
    const rows = [];
    for (let i = this.tx.length - 1; i >= 0 && rows.length < limit; i--) {
      const tx = this.tx[i];
      rows.push({
        id: tx.id,
        at: tx.at,
        kind: tx.kind,
        amount: tx.amount,
        memo: tx.memo,
        from: this.#party(tx.from, tx.fromName),
        to: this.#party(tx.to, tx.toName),
        reversedBy: tx.reversedBy ?? null,
      });
    }
    return rows;
  }

  // Bad lines are reported and skipped so one typo doesn't block a whole pasted cast list.
  adminCreate(accounts, fallbackBalance) {
    if (!Array.isArray(accounts) || !accounts.length) fail(400, 'NOTHING', 'List at least one handle.');
    const created = [];
    const problems = [];
    for (const entry of accounts.slice(0, MAX_USERS)) {
      const balance = entry?.balance ?? fallbackBalance ?? this.settings.startingBalance;
      try {
        if (!isBalance(balance)) fail(400, 'BAD_AMOUNT', 'Starting balance must be a whole number.');
        created.push(this.#createUser(entry?.handle, balance).id);
      } catch (err) {
        if (!(err instanceof BankError)) throw err;
        problems.push({ handle: String(entry?.handle ?? ''), message: err.message });
      }
    }
    if (created.length) this.#touch(...created);
    return { created: created.length, problems };
  }

  adminUser(id, { do: action, ...args } = {}) {
    const user = this.users.get(String(id ?? '').toUpperCase());
    if (!user) fail(404, 'NO_ACCOUNT', 'No account with that ID.');
    switch (action) {
      case 'adjust':
        this.#adjust(user, args.delta, cleanText(args.memo, 80));
        break;
      case 'rename': {
        const handle = this.#checkHandle(args.handle, user);
        this.#byHandle.delete(handleKey(user.handle));
        user.handle = handle;
        this.#byHandle.set(handleKey(handle), user);
        break;
      }
      case 'freeze':
        user.frozen = Boolean(args.frozen);
        break;
      case 'clearPin':
        user.pin = null;
        this.#pinFails.delete(user.id);
        break;
      case 'newCode':
        this.#byCode.delete(user.code);
        do user.code = randomCode(10);
        while (this.#byCode.has(user.code));
        this.#byCode.set(user.code, user);
        break;
      case 'logout':
        this.#dropSessions(user.id);
        break;
      case 'delete':
        this.#dropSessions(user.id);
        this.users.delete(user.id);
        this.#byHandle.delete(handleKey(user.handle));
        this.#byCode.delete(user.code);
        break;
      default:
        fail(400, 'BAD_ACTION', 'Unknown action.');
    }
    // Renames and deletions change how this account appears in other people's history too.
    if (action === 'rename' || action === 'delete') this.#touchEveryone();
    else this.#touch(user.id);
  }

  adminAdjustAll(delta, memo) {
    if (!this.users.size) fail(409, 'NOTHING', 'There are no accounts yet.');
    const note = cleanText(memo, 80);
    for (const user of this.users.values()) this.#adjust(user, delta, note);
    this.#touch(...this.users.keys());
    return this.users.size;
  }

  // Forced: the money comes back even if the receiver already spent it, which can leave them in debt.
  adminReverse(txId) {
    const tx = this.tx.find((entry) => entry.id === txId);
    if (!tx) fail(404, 'NO_TX', 'No such transaction.');
    if (tx.kind === 'reversal') fail(400, 'IS_REVERSAL', "A reversal can't be reversed.");
    if (tx.reversedBy) fail(409, 'ALREADY_REVERSED', 'That transaction was already reversed.');
    const payer = tx.to ? this.users.get(tx.to) : null;
    const payee = tx.from ? this.users.get(tx.from) : null;
    if ((tx.to && !payer) || (tx.from && !payee)) fail(409, 'ACCOUNT_GONE', 'One of the accounts no longer exists.');
    if (payer) payer.balance -= tx.amount;
    if (payee) payee.balance += tx.amount;
    const back = this.#record('reversal', payer, payee, tx.amount, `Reversal of TX ${tx.id}`);
    tx.reversedBy = back.id;
    this.#touch(...[payer?.id, payee?.id].filter(Boolean));
    return back;
  }

  adminSettings(patch = {}) {
    const next = { ...this.settings };
    if ('bankName' in patch) {
      next.bankName = cleanText(patch.bankName, 24);
      if (!next.bankName) fail(400, 'BAD_SETTING', 'The bank needs a name.');
    }
    if ('currency' in patch) {
      next.currency = cleanText(patch.currency, 4);
      if (!next.currency) fail(400, 'BAD_SETTING', 'The currency needs a symbol.');
    }
    if ('startingBalance' in patch) {
      if (!isBalance(patch.startingBalance)) fail(400, 'BAD_SETTING', 'Starting balance must be a whole number.');
      next.startingBalance = patch.startingBalance;
    }
    if ('signupsOpen' in patch) next.signupsOpen = Boolean(patch.signupsOpen);
    if ('directory' in patch) next.directory = Boolean(patch.directory);
    if ('joinCode' in patch) next.joinCode = cleanText(patch.joinCode, 32);
    this.settings = next;
    this.#touchEveryone();
  }

  adminWipe() {
    if (this.#file) this.#backup(this.#serialize(), 'wipe');
    for (const [token, session] of this.sessions) {
      if (!session.admin) this.sessions.delete(token);
    }
    this.users.clear();
    this.#byHandle.clear();
    this.#byCode.clear();
    this.#pinFails.clear();
    this.#seen.clear();
    this.tx = [];
    this.nextTx = 1;
    this.#touchEveryone();
  }

  ledgerCsv() {
    const cell = (value) => {
      let text = String(value ?? '');
      // Keeps a spreadsheet from running a player-written memo as a formula.
      if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
      return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
    };
    const rows = [['tx', 'time', 'kind', 'from_id', 'from', 'to_id', 'to', 'amount', 'memo']];
    for (const tx of this.tx) {
      rows.push([
        tx.id,
        new Date(tx.at).toISOString(),
        tx.kind,
        tx.from ?? '',
        tx.fromName ?? this.settings.bankName,
        tx.to ?? '',
        tx.toName ?? this.settings.bankName,
        tx.amount,
        tx.memo,
      ]);
    }
    return `${BOM}${rows.map((row) => row.map(cell).join(',')).join('\r\n')}\r\n`;
  }

  // ------------------------------------------------------------ live updates

  revOf(channel) {
    return `${BOOT}.${this.#epoch}.${this.#revs.get(channel) ?? 0}`;
  }

  // `done` resolves when the channel changes, after `ms`, or when cancel() is called.
  wait(channel, ms) {
    let cancel;
    const done = new Promise((resolve) => {
      const waiters = this.#waiters.get(channel) ?? new Set();
      this.#waiters.set(channel, waiters);
      const timer = setTimeout(() => cancel(), ms);
      cancel = () => {
        clearTimeout(timer);
        waiters.delete(cancel);
        resolve();
      };
      waiters.add(cancel);
    });
    return { done, cancel };
  }

  #touch(...channels) {
    for (const channel of [...channels, GM_CHANNEL]) {
      this.#revs.set(channel, (this.#revs.get(channel) ?? 0) + 1);
      for (const wake of [...(this.#waiters.get(channel) ?? [])]) wake();
    }
    this.#save();
  }

  #touchEveryone() {
    this.#epoch++;
    for (const waiters of this.#waiters.values()) {
      for (const wake of [...waiters]) wake();
    }
    this.#save();
  }

  // --------------------------------------------------------------- internals

  #session(token) {
    const session = typeof token === 'string' ? this.sessions.get(token) : null;
    return session && session.at + SESSION_MS > Date.now() ? session : null;
  }

  #dropSessions(uid) {
    for (const [token, session] of this.sessions) {
      if (session.uid === uid) this.sessions.delete(token);
    }
  }

  #find(who) {
    const text = cleanText(who, 40);
    return this.#byHandle.get(handleKey(text)) ?? this.users.get(text.replace(/^#/, '').toUpperCase()) ?? null;
  }

  #party(id, name) {
    return id ? { id, name: this.users.get(id)?.handle ?? name } : null;
  }

  #checkHandle(raw, owner = null) {
    const handle = cleanText(raw, 24);
    if (Array.from(handle).length < 2) fail(400, 'BAD_HANDLE', 'A handle needs 2 to 24 characters.');
    const key = handleKey(handle);
    const holder = this.#byHandle.get(key);
    if ((holder && holder !== owner) || key === handleKey(this.settings.bankName)) {
      fail(409, 'HANDLE_TAKEN', `"${handle}" is already taken.`);
    }
    return handle;
  }

  #createUser(rawHandle, balance) {
    const handle = this.#checkHandle(rawHandle);
    if (this.users.size >= MAX_USERS) fail(409, 'FULL', 'The grid is at capacity.');
    let id;
    do id = randomCode(4);
    while (this.users.has(id));
    let code;
    do code = randomCode(10);
    while (this.#byCode.has(code));
    const user = { id, handle, pin: null, balance: 0, code, frozen: false, createdAt: Date.now() };
    this.#index(user);
    if (balance > 0) {
      user.balance = balance;
      this.#record('grant', null, user, balance, 'Account opened');
    }
    return user;
  }

  #index(user) {
    this.users.set(user.id, user);
    this.#byHandle.set(handleKey(user.handle), user);
    this.#byCode.set(user.code, user);
  }

  #adjust(user, delta, memo) {
    if (!Number.isSafeInteger(delta) || !toAmount(Math.abs(delta))) fail(400, 'BAD_AMOUNT', 'Enter a whole amount.');
    user.balance += delta;
    return delta > 0
      ? this.#record('grant', null, user, delta, memo)
      : this.#record('deduct', user, null, -delta, memo);
  }

  // Names are stored with each entry so the ledger still reads properly after an account is deleted.
  #record(kind, from, to, amount, memo, extra = {}) {
    const tx = {
      id: this.nextTx++,
      at: Date.now(),
      kind,
      from: from?.id ?? null,
      fromName: from?.handle ?? null,
      to: to?.id ?? null,
      toName: to?.handle ?? null,
      amount,
      memo,
      ...extra,
    };
    this.tx.push(tx);
    return tx;
  }

  // ------------------------------------------------------------- persistence

  #serialize() {
    return JSON.stringify({
      version: 1,
      settings: this.settings,
      adminPassword: this.#storedPassword,
      nextTx: this.nextTx,
      users: [...this.users.values()],
      sessions: [...this.sessions].map(([token, session]) => ({ token, ...session })),
      tx: this.tx,
    });
  }

  #load() {
    const dir = path.dirname(this.#file);
    fs.mkdirSync(dir, { recursive: true });
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.tmp')) fs.rmSync(path.join(dir, name), { force: true });
    }
    let raw;
    try {
      raw = fs.readFileSync(this.#file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    const data = JSON.parse(raw);
    this.#backup(raw, 'start');
    this.settings = { ...DEFAULT_SETTINGS, ...data.settings };
    this.#storedPassword = data.adminPassword ?? null;
    this.nextTx = data.nextTx ?? 1;
    this.tx = data.tx ?? [];
    for (const user of data.users ?? []) this.#index(user);
    const cutoff = Date.now() - SESSION_MS;
    for (const { token, ...session } of data.sessions ?? []) {
      if (session.at > cutoff && (session.admin || this.users.has(session.uid))) this.sessions.set(token, session);
    }
  }

  #backup(raw, label) {
    const dir = path.join(path.dirname(this.#file), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    fs.writeFileSync(path.join(dir, `db-${stamp}-${label}.json`), raw);
    const stale = fs.readdirSync(dir).filter((name) => name.startsWith('db-')).sort().slice(0, -BACKUPS_KEPT);
    for (const name of stale) fs.rmSync(path.join(dir, name), { force: true });
  }

  // Changes within the same few milliseconds share one write.
  #save() {
    if (!this.#file) return;
    this.#dirty = true;
    this.#saveTimer ??= setTimeout(() => this.flushSync(), 40);
  }

  // Synchronous on purpose: the file is small, and it rules out an older write landing on top of a newer one.
  // Written to a temp file, synced and renamed into place, so a crash never leaves a half-written database.
  flushSync() {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = null;
    if (!this.#file || !this.#dirty) return;
    const tmp = `${this.#file}.tmp`;
    try {
      const fd = fs.openSync(tmp, 'w');
      try {
        fs.writeFileSync(fd, this.#serialize());
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, this.#file);
      this.#dirty = false;
    } catch (err) {
      console.error(`[bank] could not save ${this.#file}: ${err.message} (retrying)`);
      this.#saveTimer = setTimeout(() => this.flushSync(), 1000);
    }
  }
}

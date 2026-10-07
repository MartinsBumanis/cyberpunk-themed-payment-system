import test from 'node:test';
import assert from 'node:assert/strict';
import { Bank } from '../lib/bank.js';
import { createApp } from '../lib/app.js';

async function start() {
  const bank = new Bank({ adminPassword: 'gm-secret' });
  const server = createApp(bank, { lanUrls: () => ['http://192.168.1.50:3000'] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const stop = () => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
  return { bank, base, stop };
}

// A tiny browser: remembers cookies between calls, like one phone would.
function phone(base) {
  const jar = new Map();
  return async function call(pathname, body, headers = {}) {
    const res = await fetch(base + pathname, {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'manual',
      headers: {
        cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; '),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    for (const cookie of res.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const [name, value] = pair.split('=');
      if (value) jar.set(name, value);
      else jar.delete(name);
      call.lastCookie = cookie;
    }
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: res.status, data, text, headers: res.headers };
  };
}

test('players sign up, pay each other, and a parked poll hears about it at once', async () => {
  const { base, stop } = await start();
  try {
    const vee = phone(base);
    const doc = phone(base);
    assert.equal((await vee('/api/me')).status, 401);
    const config = { bankName: 'BLACKWIRE', currency: '¥', signupsOpen: true, needsJoinCode: false };
    assert.deepEqual((await vee('/api/boot')).data, { config, me: null });

    const veeSnap = (await vee('/api/signup', { handle: 'Vee', pin: '1234' })).data;
    assert.match(vee.lastCookie, /^sid=[\w-]{32}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/);
    const docSnap = (await doc('/api/signup', { handle: 'Doc Ripper', pin: '4321' })).data;
    assert.equal((await vee('/api/me')).data.user.handle, 'Vee');
    assert.deepEqual((await vee('/api/boot')).data, { config, me: veeSnap });
    assert.deepEqual((await vee(`/api/users/${docSnap.user.id.toLowerCase()}`)).data, { id: docSnap.user.id, handle: 'Doc Ripper' });
    assert.deepEqual((await vee('/api/users')).data.users, [{ id: docSnap.user.id, handle: 'Doc Ripper' }]);

    // A poll with a stale revision answers immediately; an up-to-date one parks until the payment lands.
    assert.equal((await doc('/api/me?wait=stale')).data.rev, docSnap.rev);
    const started = Date.now();
    const parked = doc(`/api/me?wait=${docSnap.rev}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const paid = await vee('/api/transfer', { to: docSnap.user.id, amount: 400, memo: 'cyberarm', key: 'k1' });
    assert.equal(paid.status, 200);
    assert.equal(paid.data.me.user.balance, 600);
    assert.deepEqual(paid.data.tx.peer, { id: docSnap.user.id, name: 'Doc Ripper' });
    const heard = (await parked).data;
    assert.ok(Date.now() - started < 5000, 'the parked poll returned on the payment, not on its timeout');
    assert.equal(heard.user.balance, 1400);
    assert.notEqual(heard.rev, docSnap.rev);
    assert.deepEqual({ ...heard.tx[0], id: 0, at: 0 }, { id: 0, at: 0, kind: 'transfer', dir: 'in', amount: 400, memo: 'cyberarm', peer: { id: veeSnap.user.id, name: 'Vee' } });

    const again = await vee('/api/transfer', { to: docSnap.user.id, amount: 400, memo: 'cyberarm', key: 'k1' });
    assert.equal(again.data.me.user.balance, 600, 'a retried request does not pay twice');
    const broke = await vee('/api/transfer', { to: docSnap.user.id, amount: 601 });
    assert.equal(broke.status, 409);
    assert.equal(broke.data.error.code, 'INSUFFICIENT_FUNDS');
    assert.equal((await vee('/api/history')).data.tx.length, 2);
    assert.equal((await vee(`/api/history?before=${paid.data.tx.id}`)).data.tx.length, 1);

    await vee('/api/logout', {});
    assert.equal((await vee('/api/me')).status, 401);
    assert.equal((await vee('/api/login', { who: 'vee', pin: '0000' })).status, 401);
    assert.equal((await vee('/api/login', { who: 'vee', pin: '1234' })).data.user.balance, 600);
    assert.equal((await vee('/api/pin', { current: '1234', next: '777777' })).status, 200);
  } finally {
    await stop();
  }
});

test('the GM console is locked behind its password and can run the game', async () => {
  const { bank, base, stop } = await start();
  try {
    const gm = phone(base);
    const vee = phone(base);
    await vee('/api/signup', { handle: 'Vee', pin: '1234' });
    assert.equal((await gm('/api/admin/state')).status, 401);
    assert.equal((await vee('/api/admin/state')).status, 401, 'a player session is not a GM session');
    assert.equal((await vee('/api/admin/users', { accounts: [{ handle: 'Free Money', balance: 999999 }] })).status, 401);
    assert.equal((await gm('/api/admin/login', { password: 'guess' })).status, 401);

    const state = (await gm('/api/admin/login', { password: 'gm-secret' })).data;
    assert.deepEqual(state.urls, ['http://192.168.1.50:3000']);
    assert.equal(state.users.length, 1);
    assert.equal(state.users[0].online, true);
    assert.equal(state.supply, 1000);

    const made = (await gm('/api/admin/users', { accounts: [{ handle: 'Rogue', balance: 5000 }, { handle: 'vee' }], balance: 100 })).data;
    assert.equal(made.result.created, 1);
    assert.equal(made.result.problems.length, 1);
    const rogue = made.users.find((user) => user.handle === 'Rogue');
    assert.equal(rogue.balance, 5000);

    // The access code on a printed card: peek shows whose it is, then it logs a new phone in.
    const card = phone(base);
    assert.deepEqual((await card('/api/login/code', { code: rogue.code, peek: true })).data, { id: rogue.id, handle: 'Rogue' });
    assert.equal((await card('/api/me')).status, 401);
    assert.equal((await card('/api/login/code', { code: rogue.code })).data.user.balance, 5000);

    const veeId = made.users.find((user) => user.handle === 'Vee').id;
    assert.equal((await gm(`/api/admin/users/${veeId}`, { do: 'adjust', delta: -300, memo: 'Fine' })).data.supply, 5700);
    assert.equal((await gm('/api/admin/adjust-all', { delta: 50, memo: 'Payday' })).data.supply, 5800);
    assert.equal((await vee('/api/me')).data.user.balance, 750);
    const fine = (await gm('/api/admin/state')).data.tx.find((tx) => tx.memo === 'Fine');
    assert.equal((await gm('/api/admin/reverse', { tx: fine.id })).data.supply, 6100);
    assert.equal((await gm('/api/admin/settings', { currency: '€$', signupsOpen: false })).data.settings.currency, '€$');
    assert.equal((await vee('/api/boot')).data.config.signupsOpen, false);

    const csv = await gm('/api/admin/ledger.csv');
    assert.match(csv.headers.get('content-type'), /^text\/csv/);
    assert.equal(csv.text.trim().split('\r\n').length, bank.tx.length + 1);

    // A deleted account's phone is thrown back to the login screen.
    await gm(`/api/admin/users/${veeId}`, { do: 'delete' });
    assert.equal((await vee('/api/me')).status, 401);

    assert.equal((await gm('/api/admin/wipe', { confirm: 'yes' })).status, 400);
    assert.equal((await gm('/api/admin/wipe', { confirm: 'WIPE' })).data.users.length, 0);
    await gm('/api/admin/logout', {});
    assert.equal((await gm('/api/admin/state')).status, 401);
  } finally {
    await stop();
  }
});

test('too many wrong GM passwords are slowed down', async () => {
  const { base, stop } = await start();
  try {
    const gm = phone(base);
    for (let i = 0; i < 8; i++) assert.equal((await gm('/api/admin/login', { password: `guess${i}` })).status, 401);
    assert.equal((await gm('/api/admin/login', { password: 'gm-secret' })).status, 429);
  } finally {
    await stop();
  }
});

test('odd requests are turned away cleanly', async () => {
  const { base, stop } = await start();
  try {
    const anyone = phone(base);
    // What a hostile web page could make a visitor's browser send: a form post, not JSON.
    assert.equal((await anyone('/api/signup', 'handle=Evil&pin=1234', { 'content-type': 'application/x-www-form-urlencoded' })).status, 415);
    assert.equal((await anyone('/api/signup', '{ nope')).status, 400);
    assert.equal((await anyone('/api/signup', '[1]')).status, 400);
    assert.equal((await anyone('/api/signup', JSON.stringify({ handle: 'x'.repeat(70_000), pin: '1234' }))).status, 413);
    assert.equal((await anyone('/api/nope')).status, 404);
    assert.equal((await anyone('/api/users/%E0%A4%A')).status, 400);
    assert.equal((await anyone('/api/signup', {})).data.error.code, 'BAD_PIN');
    assert.equal((await fetch(`${base}/`, { method: 'DELETE' })).status, 405);
  } finally {
    await stop();
  }
});

test('pages and assets are served, and nothing outside the public folder is', async () => {
  const { base, stop } = await start();
  try {
    const get = phone(base);
    for (const page of ['/', '/pay/K7Q2', '/pay/K7Q2?a=500&m=Cyberarm', '/l/ABCDEFGHJK']) {
      const res = await get(page);
      assert.equal(res.status, 200, page);
      assert.match(res.headers.get('content-type'), /^text\/html/);
      assert.match(res.text, /src="\/app\.js"/);
      assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
    }
    assert.match((await get('/admin')).text, /src="\/admin\.js"/);

    const css = await get('/style.css');
    assert.equal(css.status, 200);
    assert.equal(css.headers.get('cache-control'), 'no-cache');
    assert.equal((await get('/style.css', undefined, { 'if-none-match': css.headers.get('etag') })).status, 304);
    assert.match((await get('/vendor/qrcode.mjs')).headers.get('cache-control'), /max-age/);
    assert.equal((await get('/fonts/chakra-petch-latin-700-normal.woff2')).headers.get('content-type'), 'font/woff2');

    for (const sneaky of ['/..%2fserver.js', '/%2e%2e/server.js', '/..%5cserver.js', '/vendor/..%2f..%2fpackage.json', '/.gitignore', '/server.js', '/C:%5cWindows%5cwin.ini', '/style.css%00.html', '/nope.css']) {
      assert.equal((await get(sneaky)).status, 404, sneaky);
    }
  } finally {
    await stop();
  }
});

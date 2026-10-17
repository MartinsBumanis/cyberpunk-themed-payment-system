import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bank, BankError } from '../lib/bank.js';
import { Hub, slugify } from '../lib/hub.js';
import { createApp } from '../lib/app.js';

function rejects(fn, code) {
  assert.throws(fn, (err) => err instanceof BankError && err.code === code, `expected ${code}`);
}

async function serve(hub) {
  const server = createApp(hub);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const stop = () => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
  return { origin, stop };
}

// A browser that honours cookie paths, so a login in one lobby is only sent to that lobby.
function browser(origin) {
  const jar = [];
  return async function call(pathname, body) {
    const cookie = jar
      .filter((c) => pathname === c.path || pathname.startsWith(c.path === '/' ? '/' : `${c.path}/`))
      .map((c) => `${c.name}=${c.value}`).join('; ');
    const res = await fetch(origin + pathname, {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'manual',
      headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split('; ');
      const [name, value] = pair.split('=');
      const scope = attrs.find((attr) => attr.startsWith('Path='))?.slice(5) ?? '/';
      const at = jar.findIndex((c) => c.name === name && c.path === scope);
      if (at >= 0) jar.splice(at, 1);
      if (value) jar.push({ name, value, path: scope });
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

test('lobby addresses are made from names and must be free and allowed', () => {
  assert.equal(slugify('  Mārtiņš: Night City, run #2! '), 'martins-night-city-run-2');
  const hub = new Hub({ password: 'pw' });
  assert.equal(hub.create({ title: 'Night City' }).slug, 'night-city');
  assert.equal(hub.create({ title: 'Night City' }).slug, 'night-city-2', 'a name clash picks the next free address');
  rejects(() => hub.create({ title: 'Other', slug: 'night-city' }), 'SLUG_TAKEN');
  rejects(() => hub.create({ title: 'Sneaky', slug: 'admin' }), 'BAD_SLUG');
  rejects(() => hub.create({ title: 'Sneaky', slug: 'api' }), 'BAD_SLUG');
  rejects(() => hub.create({ title: '   ' }), 'BAD_TITLE');
  rejects(() => hub.create({ title: 'Ugly', theme: 'comic-sans' }), 'BAD_SETTING');
  assert.equal(hub.create({ title: '!!!' }).slug, 'game');
  assert.equal(hub.defaultSlug, 'night-city', 'the first lobby becomes the default');
});

test('a new lobby can copy settings and cast from another, and nothing else', () => {
  const hub = new Hub({ password: 'pw' });
  const first = hub.create({ title: 'Run one', theme: 'neon' });
  first.bank.adminSettings({ bankName: 'Night Bank', currency: '€$', startingBalance: 300 });
  const vee = first.bank.signup({ handle: 'Vee', pin: '1234' });
  first.bank.adminCreate([{ handle: 'Doc Ripper', balance: 9000 }]);
  first.bank.transfer(vee, { to: [...first.bank.users.values()].find((u) => u.handle === 'Doc Ripper').id, amount: 50 });

  const second = hub.create({ title: 'Run two', copyFrom: first.slug, copyCast: true, theme: 'toxic' });
  assert.equal(second.bank.settings.bankName, 'Night Bank');
  assert.equal(second.bank.settings.theme, 'toxic', 'an explicit theme wins over the copied one');
  assert.deepEqual(second.bank.handles().sort(), ['Doc Ripper', 'Vee']);
  for (const user of second.bank.users.values()) {
    assert.equal(user.balance, 300, 'the cast starts over with the starting balance');
    assert.equal(user.pin, null);
  }
  assert.notEqual(second.bank.adminPassword, first.bank.adminPassword, 'every lobby gets its own GM password');

  const third = hub.create({ title: 'Run three', copyFrom: first.slug });
  assert.equal(third.bank.users.size, 0);
  rejects(() => hub.create({ title: 'Ghost', copyFrom: 'nope' }), 'NO_LOBBY');
});

test('players in different lobbies never see each other, even on one phone', async () => {
  const hub = new Hub({ password: 'master' });
  hub.create({ title: 'Alpha' });
  hub.create({ title: 'Beta' });
  const { origin, stop } = await serve(hub);
  try {
    const phone = browser(origin);
    const inAlpha = (await phone('/alpha/api/signup', { handle: 'Vee', pin: '1234' })).data;
    const inBeta = (await phone('/beta/api/signup', { handle: 'Vee', pin: '9999' })).data;
    assert.notEqual(inAlpha.user.id, inBeta.user.id);

    // Both logins live side by side, each sent only to its own lobby.
    assert.equal((await phone('/alpha/api/me')).data.user.id, inAlpha.user.id);
    assert.equal((await phone('/beta/api/me')).data.user.id, inBeta.user.id);

    const doc = browser(origin);
    const docAlpha = (await doc('/alpha/api/signup', { handle: 'Doc', pin: '1234' })).data;
    await phone('/alpha/api/transfer', { to: docAlpha.user.id, amount: 100 });
    assert.equal((await phone('/alpha/api/me')).data.user.balance, 900);
    assert.equal((await phone('/beta/api/me')).data.user.balance, 1000);
    assert.equal((await phone(`/beta/api/users/${docAlpha.user.id}`)).status, 404, "another lobby's ID means nothing here");
    assert.equal((await phone('/beta/api/transfer', { to: docAlpha.user.id, amount: 1 })).data.error.code, 'NO_ACCOUNT');
    assert.equal((await phone('/gamma/api/boot')).status, 404);
  } finally {
    await stop();
  }
});

test('the hub needs the master password; a lobby password opens only its lobby', async () => {
  const hub = new Hub({ password: 'master' });
  const alpha = hub.create({ title: 'Alpha' });
  const beta = hub.create({ title: 'Beta' });
  const { origin, stop } = await serve(hub);
  try {
    const gm = browser(origin);
    assert.equal((await gm('/api/hub/state')).status, 401);
    assert.equal((await gm('/alpha/api/admin/login', { password: alpha.bank.adminPassword })).status, 200);
    assert.equal((await gm('/alpha/api/admin/state')).status, 200);
    assert.equal((await gm('/beta/api/admin/state')).status, 401, "alpha's GM can't run beta");
    assert.equal((await gm('/api/hub/state')).status, 401, "a lobby GM isn't the master");

    const boss = browser(origin);
    assert.equal((await boss('/api/hub/login', { password: 'nope' })).status, 401);
    const state = (await boss('/api/hub/login', { password: 'master' })).data;
    assert.deepEqual(state.lobbies.map((lobby) => lobby.slug).sort(), ['alpha', 'beta']);
    assert.equal((await boss('/beta/api/admin/state')).data.hubAccess, true, 'the master opens every console');

    const made = (await boss('/api/hub/lobbies', { title: 'Gamma', theme: 'corpo', copyFrom: 'alpha' })).data;
    assert.equal(made.created, 'gamma');
    await boss('/api/hub/lobbies/beta', { do: 'rename', title: 'Beta, rerun' });
    await boss('/api/hub/lobbies/beta', { do: 'password', password: 'beta-gm' });
    assert.equal((await gm('/beta/api/admin/login', { password: 'beta-gm' })).status, 200);
    await boss('/api/hub/lobbies/gamma', { do: 'default' });
    assert.equal(hub.defaultSlug, 'gamma');

    assert.equal((await boss('/api/hub/lobbies/beta', { do: 'delete', confirm: 'yes' })).status, 400);
    const after = (await boss('/api/hub/lobbies/beta', { do: 'delete', confirm: 'beta' })).data;
    assert.deepEqual(after.lobbies.map((lobby) => lobby.slug).sort(), ['alpha', 'gamma']);
    assert.equal(hub.get('beta'), null);

    await boss('/api/hub/password', { password: 'new-master' });
    assert.equal((await browser(origin)('/api/hub/login', { password: 'new-master' })).status, 200);
    await boss('/api/hub/logout', {});
    assert.equal((await boss('/api/hub/state')).status, 401);
  } finally {
    await stop();
  }
});

test('pages carry their lobby theme, and old links lead to the default lobby', async () => {
  const hub = new Hub({ password: 'master' });
  const alpha = hub.create({ title: 'Alpha', theme: 'neon' });
  hub.create({ title: 'Beta', theme: 'corpo' });
  const { origin, stop } = await serve(hub);
  try {
    const get = browser(origin);
    assert.match((await get('/alpha/')).text, /<html lang="en" data-theme="neon">/);
    assert.match((await get('/beta/pay/K7Q2')).text, /data-theme="corpo"/);
    assert.match((await get('/beta/admin')).text, /src="\/admin\.js"/);
    assert.match((await get('/admin')).text, /src="\/hub\.js"/);
    const lost = await get('/nowhere/');
    assert.equal(lost.status, 302, 'a mistyped game address goes back to the front page');
    assert.equal(lost.headers.get('location'), '/?missing=nowhere');
    assert.equal((await get('/nowhere/admin')).headers.get('location'), '/?missing=nowhere');
    assert.equal((await get('/nope.png')).status, 404);

    // The bare address is a front page for entering a game code, not a way into anyone's game.
    const root = await get('/');
    assert.equal(root.status, 200);
    assert.match(root.text, /src="\/home\.js"/);
    assert.doesNotMatch(root.text, /alpha|beta/i);
    assert.equal((await get('/pay/K7Q2?a=5')).headers.get('location'), '/alpha/pay/K7Q2?a=5');
    assert.equal((await get('/l/ABCDEFGHJK')).headers.get('location'), '/alpha/l/ABCDEFGHJK');

    alpha.bank.adminSettings({ theme: 'toxic' });
    assert.match((await get('/alpha/')).text, /data-theme="toxic"/);
    assert.equal((await get('/alpha/api/boot')).data.config.theme, 'toxic');
    rejects(() => alpha.bank.adminSettings({ theme: '"><script>' }), 'BAD_SETTING');
  } finally {
    await stop();
  }
  const empty = await serve(new Hub({ password: 'pw' }));
  try {
    assert.equal((await browser(empty.origin)('/')).status, 200, 'the front page works before any lobby exists');
  } finally {
    await empty.stop();
  }
});

test('an existing single-bank install becomes the lobby "main" without losing anything', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackwire-hub-'));
  try {
    const old = new Bank({ file: path.join(dir, 'db.json') });
    old.adminSettings({ bankName: 'Afterlife Credit' });
    const vee = old.signup({ handle: 'Vee', pin: '1234' });
    const token = old.openSession({ uid: vee.id });
    const oldPassword = old.adminPassword;
    old.flushSync();
    new Bank({ file: path.join(dir, 'db.json') }); // a restart leaves a backup, which should move along too

    const hub = new Hub({ dir });
    assert.equal(hub.password, oldPassword, 'the old GM password still opens the hub');
    assert.equal(hub.defaultSlug, 'main');
    const main = hub.must('main');
    assert.equal(main.title, 'Afterlife Credit');
    assert.equal(main.bank.adminPassword, oldPassword, "and still opens main's console");
    assert.equal(main.bank.sessionUser(token)?.handle, 'Vee', 'phones stay logged in');
    assert.equal(fs.existsSync(path.join(dir, 'db.json')), false);
    assert.ok(fs.readdirSync(path.join(dir, 'lobbies', 'main', 'backups')).length > 0);

    hub.create({ title: 'Second' });
    hub.flushSync();
    const again = new Hub({ dir });
    assert.deepEqual([...again.lobbies.keys()].sort(), ['main', 'second']);
    assert.equal(again.must('main').bank.loginPin('vee', '1234').handle, 'Vee');

    again.remove('second');
    again.flushSync();
    assert.deepEqual([...new Hub({ dir }).lobbies.keys()], ['main']);
    assert.equal(fs.readdirSync(path.join(dir, 'deleted')).length, 1, 'a deleted lobby is moved aside, not erased');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('organizers register, and each sees and runs only their own lobbies', async () => {
  const hub = new Hub({ password: 'master' });
  const ownerLobby = hub.create({ title: 'House game' });
  const { origin, stop } = await serve(hub);
  try {
    const anon = browser(origin);
    assert.deepEqual((await anon('/api/hub/info')).data, { signupsOpen: true, needsInvite: false });
    assert.equal((await anon('/api/hub/register', { name: 'ab', password: 'secret1' })).data.error.code, 'BAD_NAME');
    assert.equal((await anon('/api/hub/register', { name: 'Judy', password: '123' })).data.error.code, 'BAD_PASSWORD');

    const judy = browser(origin);
    const judyState = (await judy('/api/hub/register', { name: 'Judy', password: 'braindance' })).data;
    assert.deepEqual(judyState.me, { name: 'Judy' });
    assert.deepEqual(judyState.lobbies, [], "the owner's lobbies are not hers to see");
    assert.equal(judyState.organizers, undefined, 'organizers never see the list of organizers');
    assert.equal((await anon('/api/hub/register', { name: 'JUDY', password: 'another1' })).data.error.code, 'NAME_TAKEN');

    const panam = browser(origin);
    await panam('/api/hub/register', { name: 'Panam', password: 'badlands' });

    const made = (await judy('/api/hub/lobbies', { title: 'Clouds', theme: 'neon' })).data;
    assert.deepEqual(made.lobbies.map((lobby) => lobby.slug), ['clouds']);
    assert.equal(hub.defaultSlug, ownerLobby.slug, "a stranger's lobby never becomes the front page");

    // Judy runs her lobby's console without its password; Panam can't touch it or even see it exists.
    assert.equal((await judy('/clouds/api/admin/state')).data.hubAccess, true);
    assert.equal((await panam('/clouds/api/admin/state')).status, 401);
    assert.deepEqual((await panam('/api/hub/state')).data.lobbies, []);
    assert.equal((await panam('/api/hub/lobbies/clouds', { do: 'delete', confirm: 'clouds' })).status, 404);
    assert.equal((await panam('/api/hub/lobbies', { title: 'Copycat', copyFrom: 'clouds' })).status, 404);
    assert.equal((await judy(`/${ownerLobby.slug}/api/admin/state`)).status, 401);
    assert.equal((await judy('/api/hub/lobbies/clouds', { do: 'default' })).status, 403);
    assert.equal((await judy('/api/hub/settings', { signupsOpen: false })).status, 403);

    // The owner sees everything and who made what.
    const boss = browser(origin);
    const all = (await boss('/api/hub/login', { password: 'master' })).data;
    assert.deepEqual(all.lobbies.map((lobby) => [lobby.slug, lobby.owner]).sort(), [['clouds', 'Judy'], ['house-game', null]]);
    assert.deepEqual(all.organizers.map((org) => [org.name, org.lobbies]), [['Judy', 1], ['Panam', 0]]);
    assert.equal((await boss('/clouds/api/admin/state')).status, 200);

    // Organizers log back in by name, and repeated wrong passwords lock the account for a while.
    const again = browser(origin);
    assert.equal((await again('/api/hub/login', { name: 'judy', password: 'braindance' })).status, 200);
    for (let i = 0; i < 5; i++) assert.equal((await again('/api/hub/login', { name: 'Panam', password: 'wrong' })).status, 401);
    assert.equal((await again('/api/hub/login', { name: 'Panam', password: 'badlands' })).status, 429);

    // Changing your own password needs the current one.
    assert.equal((await judy('/api/hub/password', { current: 'nope', password: 'newsecret' })).status, 403);
    assert.equal((await judy('/api/hub/password', { current: 'braindance', password: 'newsecret' })).status, 200);
  } finally {
    await stop();
  }
});

test('the owner sets the sign-up rules and can disable, reset or delete organizers', async () => {
  const hub = new Hub({ password: 'master' });
  const { origin, stop } = await serve(hub);
  try {
    const boss = browser(origin);
    await boss('/api/hub/login', { password: 'master' });
    await boss('/api/hub/settings', { inviteCode: 'Afterlife', maxLobbies: 1 });
    assert.deepEqual((await browser(origin)('/api/hub/info')).data, { signupsOpen: true, needsInvite: true });

    const vik = browser(origin);
    assert.equal((await vik('/api/hub/register', { name: 'Vik', password: 'ripperdoc' })).data.error.code, 'BAD_INVITE');
    assert.equal((await vik('/api/hub/register', { name: 'Vik', password: 'ripperdoc', invite: ' afterlife ' })).status, 200);
    assert.equal((await vik('/api/hub/lobbies', { title: 'Clinic' })).status, 200);
    assert.equal((await vik('/api/hub/lobbies', { title: 'Second clinic' })).data.error.code, 'LIMIT');
    const vikId = (await boss('/api/hub/state')).data.organizers[0].id;

    await boss(`/api/hub/organizers/${vikId}`, { do: 'disable' });
    assert.equal((await vik('/api/hub/state')).status, 401, 'disabling logs them out');
    assert.equal((await vik('/clinic/api/admin/state')).status, 401);
    assert.equal((await browser(origin)('/api/hub/login', { name: 'Vik', password: 'ripperdoc' })).data.error.code, 'DISABLED');
    await boss(`/api/hub/organizers/${vikId}`, { do: 'enable' });

    const { password } = (await boss(`/api/hub/organizers/${vikId}`, { do: 'reset' })).data;
    assert.match(password, /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
    assert.equal((await browser(origin)('/api/hub/login', { name: 'Vik', password: 'ripperdoc' })).status, 401);
    assert.equal((await browser(origin)('/api/hub/login', { name: 'Vik', password })).status, 200);

    await boss('/api/hub/settings', { signupsOpen: false });
    const late = await browser(origin)('/api/hub/register', { name: 'Late', password: 'toolate', invite: 'afterlife' });
    assert.equal(late.data.error.code, 'SIGNUPS_CLOSED');
    assert.equal((await boss('/api/hub/settings', { maxLobbies: -1 })).status, 400);

    await boss(`/api/hub/organizers/${vikId}`, { do: 'delete' });
    assert.equal(hub.get('clinic'), null, 'deleting an organizer removes their lobbies');
    assert.deepEqual((await boss('/api/hub/state')).data.organizers, []);
  } finally {
    await stop();
  }
});

test('organizers, ownership and sign-up rules survive a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackwire-orgs-'));
  try {
    const hub = new Hub({ dir });
    const judy = hub.register({ name: 'Judy', password: 'braindance' });
    hub.create({ title: 'Clouds' }, { org: judy });
    hub.updateSettings({ inviteCode: 'Afterlife', maxLobbies: 3 });
    const token = hub.openSession(judy);
    hub.flushSync();

    const again = new Hub({ dir });
    assert.equal(again.viewer(token)?.org.name, 'Judy');
    assert.equal(again.loginOrganizer('judy', 'braindance').id, judy.id);
    assert.equal(again.must('clouds').owner, judy.id);
    assert.deepEqual(again.settings, { signupsOpen: true, inviteCode: 'Afterlife', maxLobbies: 3 });
    assert.equal(again.defaultSlug, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a login cookie left over from before lobbies never shadows the lobby\'s own', async () => {
  const hub = new Hub({ password: 'master' });
  const main = hub.create({ title: 'Main' });
  hub.create({ title: 'Clouds' });
  // What an upgraded phone carries: a site-wide session from the old version, still valid in "main".
  const vee = main.bank.signup({ handle: 'Vee', pin: '1234' });
  const legacy = main.bank.openSession({ uid: vee.id });
  const { origin, stop } = await serve(hub);
  const call = (pathname, cookie, body) => fetch(origin + pathname, {
    method: body ? 'POST' : 'GET',
    headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  try {
    assert.equal((await call('/main/api/me', `sid=${legacy}`)).status, 200, 'an upgraded phone stays logged in to main');

    // Logging in to another lobby: the browser then sends that lobby's cookie first, the old one after it.
    const signup = await call('/clouds/api/signup', `sid=${legacy}`, { handle: 'Judy', pin: '1234' });
    const fresh = /^sid=([^;]+); Path=\/clouds/.exec(signup.headers.getSetCookie()[0])[1];
    assert.ok(signup.headers.getSetCookie().includes('sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'), 'the old cookie is dropped');
    const me = await (await call('/clouds/api/me', `sid=${fresh}; sid=${legacy}`)).json();
    assert.equal(me.user.handle, 'Judy', 'the lobby\'s own cookie wins over the leftover one');

    // Logging out of main with the old cookie actually logs out.
    const out = await call('/main/api/logout', `sid=${legacy}`, {});
    assert.ok(out.headers.getSetCookie().includes('sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'));
    assert.equal((await call('/main/api/me', `sid=${legacy}`)).status, 401);
  } finally {
    await stop();
  }
});

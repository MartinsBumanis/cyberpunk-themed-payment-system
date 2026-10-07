import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bank, BankError, GM_CHANNEL } from '../lib/bank.js';

function bankWith(...handles) {
  const bank = new Bank();
  return [bank, ...handles.map((handle) => bank.signup({ handle, pin: '1234' }))];
}

function rejects(fn, code) {
  assert.throws(fn, (err) => err instanceof BankError && err.code === code, `expected ${code}`);
}

const supply = (bank) => [...bank.users.values()].reduce((sum, user) => sum + user.balance, 0);

test('signup opens an account with the starting balance', () => {
  const [bank, vee] = bankWith('Vee');
  assert.equal(vee.balance, 1000);
  assert.match(vee.id, /^[2-9A-HJ-NP-Z]{4}$/);
  const snap = bank.snapshot(vee);
  assert.equal(snap.user.hasPin, true);
  assert.deepEqual(snap.tx.map((tx) => [tx.dir, tx.kind, tx.amount, tx.peer]), [['in', 'grant', 1000, null]]);
  assert.equal(JSON.stringify(snap).includes(vee.code), false, 'access code must not leak into the player snapshot');
});

test('signup validates handle, PIN, join code and the signups switch', () => {
  const [bank] = bankWith('Doc Ripper');
  rejects(() => bank.signup({ handle: 'doc ripper', pin: '1234' }), 'HANDLE_TAKEN');
  rejects(() => bank.signup({ handle: '  DOC   RIPPER ', pin: '1234' }), 'HANDLE_TAKEN');
  rejects(() => bank.signup({ handle: 'blackwire', pin: '1234' }), 'HANDLE_TAKEN');
  rejects(() => bank.signup({ handle: 'X', pin: '1234' }), 'BAD_HANDLE');
  rejects(() => bank.signup({ handle: String.fromCodePoint(0x202e, 0x200b, 0x3164), pin: '1234' }), 'BAD_HANDLE');
  rejects(() => bank.signup({ handle: 'Jackie', pin: '12' }), 'BAD_PIN');
  rejects(() => bank.signup({ handle: 'Jackie', pin: 'abcd' }), 'BAD_PIN');

  bank.adminSettings({ joinCode: 'Chrome' });
  rejects(() => bank.signup({ handle: 'Jackie', pin: '1234', joinCode: 'nope' }), 'BAD_JOIN_CODE');
  assert.equal(bank.signup({ handle: 'Jackie', pin: '1234', joinCode: ' chrome ' }).handle, 'Jackie');

  bank.adminSettings({ signupsOpen: false });
  rejects(() => bank.signup({ handle: 'Late', pin: '1234', joinCode: 'chrome' }), 'SIGNUPS_CLOSED');
});

test('a transfer moves money and shows up for both sides', () => {
  const [bank, vee, doc] = bankWith('Vee', 'Doc Ripper');
  const tx = bank.transfer(vee, { to: doc.id.toLowerCase(), amount: 400, memo: '  new   cyberarm ' });
  assert.equal(vee.balance, 600);
  assert.equal(doc.balance, 1400);
  assert.equal(tx.memo, 'new cyberarm');
  assert.deepEqual(bank.viewFor(tx, vee.id).peer, { id: doc.id, name: 'Doc Ripper' });
  assert.equal(bank.snapshot(vee).tx[0].dir, 'out');
  assert.equal(bank.snapshot(doc).tx[0].dir, 'in');
  assert.deepEqual(bank.snapshot(doc).tx[0].peer, { id: vee.id, name: 'Vee' });
});

test('a transfer is refused when it should be', () => {
  const [bank, vee, doc] = bankWith('Vee', 'Doc Ripper');
  rejects(() => bank.transfer(vee, { to: 'ZZZZ', amount: 10 }), 'NO_ACCOUNT');
  rejects(() => bank.transfer(vee, { to: vee.id, amount: 10 }), 'SELF');
  for (const amount of [0, -5, 1.5, '10', NaN, Infinity, 1e12, null, undefined]) {
    rejects(() => bank.transfer(vee, { to: doc.id, amount }), 'BAD_AMOUNT');
  }
  rejects(() => bank.transfer(vee, { to: doc.id, amount: 1001 }), 'INSUFFICIENT_FUNDS');
  assert.equal(vee.balance, 1000);
  assert.equal(doc.balance, 1000);
  assert.equal(bank.tx.length, 2, 'only the two opening credits');
});

test('a frozen account can receive but not send', () => {
  const [bank, vee, doc] = bankWith('Vee', 'Doc Ripper');
  bank.adminUser(vee.id, { do: 'freeze', frozen: true });
  rejects(() => bank.transfer(vee, { to: doc.id, amount: 10 }), 'FROZEN');
  bank.transfer(doc, { to: vee.id, amount: 10 });
  assert.equal(vee.balance, 1010);
  bank.adminUser(vee.id, { do: 'freeze', frozen: false });
  bank.transfer(vee, { to: doc.id, amount: 10 });
  assert.equal(vee.balance, 1000);
});

test('retrying a transfer with the same key pays only once', () => {
  const [bank, vee, doc] = bankWith('Vee', 'Doc Ripper');
  const first = bank.transfer(vee, { to: doc.id, amount: 100, key: 'tap-1' });
  const retry = bank.transfer(vee, { to: doc.id, amount: 100, key: 'tap-1' });
  assert.equal(retry.id, first.id);
  assert.equal(vee.balance, 900);
  assert.equal(bank.viewFor(first, vee.id).key, 'tap-1', 'the sender can recognise their own payment');
  assert.equal('key' in bank.viewFor(first, doc.id), false, 'the receiver never sees the key');
  bank.transfer(vee, { to: doc.id, amount: 100, key: 'tap-2' });
  assert.equal(vee.balance, 800);
  // The key belongs to the sender: someone else reusing it is a separate payment.
  bank.transfer(doc, { to: vee.id, amount: 50, key: 'tap-1' });
  assert.equal(vee.balance, 850);
});

test('PIN login works by handle or ID and locks after repeated misses', () => {
  const [bank, vee] = bankWith('Vee');
  assert.equal(bank.loginPin('vee', '1234'), vee);
  assert.equal(bank.loginPin(`#${vee.id.toLowerCase()}`, '1234'), vee);
  rejects(() => bank.loginPin('nobody', '1234'), 'BAD_LOGIN');
  for (let i = 0; i < 5; i++) rejects(() => bank.loginPin('Vee', '0000'), 'BAD_LOGIN');
  rejects(() => bank.loginPin('Vee', '1234'), 'LOCKED');
});

test('changing the PIN needs the current one', () => {
  const [bank, vee] = bankWith('Vee');
  rejects(() => bank.setPin(vee, '0000', '9999'), 'BAD_PIN');
  rejects(() => bank.setPin(vee, '1234', '99'), 'BAD_PIN');
  bank.setPin(vee, '1234', '987654');
  assert.equal(bank.loginPin('Vee', '987654'), vee);
});

test('GM-made accounts log in with an access code and can set a PIN later', () => {
  const bank = new Bank();
  const result = bank.adminCreate([{ handle: 'Rogue', balance: 5000 }, { handle: 'Rogue' }, { handle: 'Solo' }, { handle: '' }], 250);
  assert.equal(result.created, 2);
  assert.deepEqual(result.problems.map((problem) => problem.handle), ['Rogue', '']);

  const rogue = [...bank.users.values()].find((user) => user.handle === 'Rogue');
  assert.equal(rogue.balance, 5000);
  assert.equal([...bank.users.values()].find((user) => user.handle === 'Solo').balance, 250);

  const spaced = `${rogue.code.slice(0, 5).toLowerCase()}-${rogue.code.slice(5)} `;
  assert.equal(bank.loginCode(spaced), rogue);
  rejects(() => bank.loginCode('AAAAAAAAAA'), 'BAD_CODE');
  rejects(() => bank.loginCode(''), 'BAD_CODE');

  bank.setPin(rogue, undefined, '4321');
  assert.equal(bank.loginPin('rogue', '4321'), rogue);

  const oldCode = rogue.code;
  bank.adminUser(rogue.id, { do: 'newCode' });
  rejects(() => bank.loginCode(oldCode), 'BAD_CODE');
  assert.equal(bank.loginCode(rogue.code), rogue);

  bank.adminUser(rogue.id, { do: 'clearPin' });
  rejects(() => bank.loginPin('rogue', '4321'), 'NO_PIN');
});

test('a pay code resolves by ID only, never by a look-alike handle', () => {
  const [bank, vee, doc] = bankWith('Vee', 'Doc Ripper');
  bank.adminUser(doc.id, { do: 'rename', handle: vee.id });
  assert.equal(bank.lookup(vee.id).handle, 'Vee');
  bank.transfer(doc, { to: vee.id, amount: 5 });
  assert.equal(vee.balance, 1005);
  rejects(() => bank.lookup('Vee'), 'NO_ACCOUNT');
});

test('sessions resolve to their account until closed or kicked', () => {
  const [bank, vee] = bankWith('Vee');
  const token = bank.openSession({ uid: vee.id });
  const gmToken = bank.openSession({ admin: true });
  assert.equal(bank.sessionUser(token), vee);
  assert.equal(bank.sessionUser('nope'), null);
  assert.equal(bank.sessionUser(undefined), null);
  assert.equal(bank.isGm(token), false);
  assert.equal(bank.isGm(gmToken), true);
  assert.equal(bank.sessionUser(gmToken), null);
  bank.adminUser(vee.id, { do: 'logout' });
  assert.equal(bank.sessionUser(token), null);
  assert.equal(bank.isGm(gmToken), true);
});

test('the GM can grant, charge into debt, and reverse', () => {
  const [bank, vee, doc] = bankWith('Vee', 'Doc Ripper');
  bank.adminUser(vee.id, { do: 'adjust', delta: 500, memo: 'Corp payroll' });
  assert.equal(vee.balance, 1500);
  const { dir, kind, amount, memo, peer } = bank.snapshot(vee).tx[0];
  assert.deepEqual({ dir, kind, amount, memo, peer }, { dir: 'in', kind: 'grant', amount: 500, memo: 'Corp payroll', peer: null });
  bank.adminUser(vee.id, { do: 'adjust', delta: -2000, memo: 'Fine' });
  assert.equal(vee.balance, -500);
  rejects(() => bank.transfer(vee, { to: doc.id, amount: 1 }), 'INSUFFICIENT_FUNDS');
  rejects(() => bank.adminUser(vee.id, { do: 'adjust', delta: 0 }), 'BAD_AMOUNT');
  rejects(() => bank.adminUser(vee.id, { do: 'adjust', delta: 1.5 }), 'BAD_AMOUNT');
  rejects(() => bank.adminUser(vee.id, { do: 'nuke' }), 'BAD_ACTION');
  rejects(() => bank.adminUser('ZZZZ', { do: 'freeze', frozen: true }), 'NO_ACCOUNT');

  const paid = bank.transfer(doc, { to: vee.id, amount: 800 });
  bank.transfer(vee, { to: doc.id, amount: 300 });
  assert.equal(vee.balance, 0);
  const back = bank.adminReverse(paid.id);
  assert.equal(back.kind, 'reversal');
  assert.equal(vee.balance, -800, 'reversal is forced even when the money is already spent');
  assert.equal(doc.balance, 1000 - 800 + 300 + 800);
  rejects(() => bank.adminReverse(paid.id), 'ALREADY_REVERSED');
  rejects(() => bank.adminReverse(back.id), 'IS_REVERSAL');
  rejects(() => bank.adminReverse(9999), 'NO_TX');

  const grant = bank.tx.find((tx) => tx.kind === 'grant' && tx.memo === 'Corp payroll');
  bank.adminReverse(grant.id);
  assert.equal(vee.balance, -1300);
});

test('pay-everyone and charge-everyone touch every account', () => {
  const [bank, vee, doc] = bankWith('Vee', 'Doc Ripper');
  bank.adminAdjustAll(250, 'Payday');
  assert.deepEqual([vee.balance, doc.balance], [1250, 1250]);
  bank.adminAdjustAll(-100, 'Rent');
  assert.deepEqual([vee.balance, doc.balance], [1150, 1150]);
  rejects(() => bank.adminAdjustAll(0, ''), 'BAD_AMOUNT');
  rejects(() => new Bank().adminAdjustAll(10, ''), 'NOTHING');
});

test('renames and deletions keep the ledger readable', () => {
  const [bank, vee, doc] = bankWith('Vee', 'Doc Ripper');
  bank.transfer(vee, { to: doc.id, amount: 100 });
  bank.adminUser(doc.id, { do: 'rename', handle: 'Doc Chrome' });
  assert.equal(bank.snapshot(vee).tx[0].peer.name, 'Doc Chrome');
  assert.equal(bank.loginPin('doc chrome', '1234'), doc);
  rejects(() => bank.loginPin('doc ripper', '1234'), 'BAD_LOGIN');
  rejects(() => bank.adminUser(doc.id, { do: 'rename', handle: 'VEE' }), 'HANDLE_TAKEN');
  bank.adminUser(doc.id, { do: 'rename', handle: 'DOC CHROME' });

  const token = bank.openSession({ uid: doc.id });
  bank.adminUser(doc.id, { do: 'delete' });
  assert.equal(bank.sessionUser(token), null);
  assert.equal(bank.snapshot(vee).tx[0].peer.name, 'Doc Ripper', 'falls back to the name at the time of the transfer');
  rejects(() => bank.transfer(vee, { to: doc.id, amount: 1 }), 'NO_ACCOUNT');
  assert.equal(bank.signup({ handle: 'Doc Chrome', pin: '1234' }).handle, 'Doc Chrome');
});

test('with the directory off, players only see people they have traded with', () => {
  const [bank, vee, doc, rogue] = bankWith('Vee', 'Doc Ripper', 'Rogue');
  assert.deepEqual(bank.directoryFor(vee).map((user) => user.handle), ['Doc Ripper', 'Rogue']);
  bank.adminSettings({ directory: false });
  assert.deepEqual(bank.directoryFor(vee), []);
  bank.transfer(rogue, { to: vee.id, amount: 1 });
  assert.deepEqual(bank.directoryFor(vee), [{ id: rogue.id, handle: 'Rogue' }]);
  assert.deepEqual(bank.directoryFor(doc), []);
});

test('settings are validated', () => {
  const bank = new Bank();
  bank.adminSettings({ bankName: '  Night  Bank ', currency: '€$', startingBalance: 0 });
  assert.deepEqual(bank.publicConfig(), { bankName: 'Night Bank', currency: '€$', signupsOpen: true, needsJoinCode: false });
  assert.equal(bank.signup({ handle: 'Broke', pin: '1234' }).balance, 0);
  rejects(() => bank.adminSettings({ bankName: ' ' }), 'BAD_SETTING');
  rejects(() => bank.adminSettings({ currency: '' }), 'BAD_SETTING');
  rejects(() => bank.adminSettings({ startingBalance: -1 }), 'BAD_SETTING');
  rejects(() => bank.adminSettings({ startingBalance: '500' }), 'BAD_SETTING');
  assert.equal(bank.settings.bankName, 'Night Bank', 'a rejected change leaves settings untouched');
});

test('waiters wake when their account changes, and revisions move', async () => {
  const [bank, vee, doc, rogue] = bankWith('Vee', 'Doc Ripper', 'Rogue');
  const before = { vee: bank.revOf(vee.id), doc: bank.revOf(doc.id), rogue: bank.revOf(rogue.id), gm: bank.revOf(GM_CHANNEL) };
  let woke = '';
  const docWait = bank.wait(doc.id, 60_000);
  const rogueWait = bank.wait(rogue.id, 60_000);
  docWait.done.then(() => { woke += 'doc'; });
  rogueWait.done.then(() => { woke += 'rogue'; });

  bank.transfer(vee, { to: doc.id, amount: 1 });
  await docWait.done;
  assert.equal(woke, 'doc');
  assert.notEqual(bank.revOf(vee.id), before.vee);
  assert.notEqual(bank.revOf(doc.id), before.doc);
  assert.notEqual(bank.revOf(GM_CHANNEL), before.gm);
  assert.equal(bank.revOf(rogue.id), before.rogue, 'bystanders are not disturbed');

  bank.adminSettings({ currency: 'CR' });
  await rogueWait.done;
  assert.notEqual(bank.revOf(rogue.id), before.rogue, 'a settings change reaches everyone');

  const timed = bank.wait(vee.id, 5);
  await timed.done;
  const cancelled = bank.wait(vee.id, 60_000);
  cancelled.cancel();
  await cancelled.done;
});

test('transfers never create or destroy money', () => {
  const [bank, ...users] = bankWith('Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo');
  const start = supply(bank);
  let seed = 7;
  const next = (n) => (seed = (seed * 48271) % 2147483647) % n;
  let done = 0;
  for (let i = 0; i < 2000; i++) {
    const from = users[next(users.length)];
    const to = users[next(users.length)];
    try {
      bank.transfer(from, { to: to.id, amount: next(900) });
      done++;
    } catch (err) {
      assert.ok(err instanceof BankError);
    }
    assert.ok(from.balance >= 0);
  }
  assert.ok(done > 100, `only ${done} transfers went through`);
  assert.equal(supply(bank), start);
  for (const user of users) {
    const net = bank.tx.reduce((sum, tx) => sum + (tx.to === user.id ? tx.amount : 0) - (tx.from === user.id ? tx.amount : 0), 0);
    assert.equal(user.balance, net, 'a balance always equals the sum of its ledger entries');
  }
});

test('the CSV export cannot smuggle formulas or break columns', () => {
  const [bank, vee, doc] = bankWith('Vee', 'Doc, "the" Ripper');
  bank.transfer(vee, { to: doc.id, amount: 5, memo: '=HYPERLINK("http://x")' });
  const csv = bank.ledgerCsv();
  assert.equal(csv.codePointAt(0), 0xfeff, 'starts with a byte-order mark so Excel reads it as UTF-8');
  const lines = csv.slice(1).trim().split('\r\n');
  assert.equal(lines[0], 'tx,time,kind,from_id,from,to_id,to,amount,memo');
  assert.ok(lines[3].includes(',"Doc, ""the"" Ripper",5,"\'=HYPERLINK(""http://x"")"'), lines[3]);
});

test('everything survives a restart, and a wipe leaves a backup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackwire-'));
  const file = path.join(dir, 'db.json');
  try {
    const first = new Bank({ file });
    const password = first.adminPassword;
    assert.match(password, /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
    first.adminSettings({ bankName: 'Night Bank' });
    const vee = first.signup({ handle: 'Vee', pin: '1234' });
    const doc = first.signup({ handle: 'Doc Ripper', pin: '1234' });
    first.transfer(vee, { to: doc.id, amount: 250, memo: 'chrome', key: 'k1' });
    const token = first.openSession({ uid: vee.id });
    const gmToken = first.openSession({ admin: true });
    first.flushSync();

    const second = new Bank({ file });
    assert.equal(second.adminPassword, password);
    assert.equal(second.settings.bankName, 'Night Bank');
    const veeAgain = second.sessionUser(token);
    assert.equal(veeAgain.balance, 750);
    assert.equal(second.isGm(gmToken), true);
    assert.equal(second.loginPin('doc ripper', '1234').balance, 1250);
    assert.equal(second.loginCode(vee.code).id, vee.id);
    assert.equal(second.snapshot(veeAgain).tx[0].memo, 'chrome');
    assert.equal(second.transfer(veeAgain, { to: doc.id, amount: 250, key: 'k1' }).id, 3, 'idempotency keys survive too');
    assert.equal(second.transfer(veeAgain, { to: doc.id, amount: 1 }).id, 4);

    second.adminWipe();
    second.flushSync();
    assert.equal(second.users.size, 0);
    assert.equal(second.sessionUser(token), null);
    assert.equal(second.isGm(gmToken), true);
    const backups = fs.readdirSync(path.join(dir, 'backups'));
    assert.ok(backups.some((name) => name.endsWith('-start.json')));
    const wiped = backups.find((name) => name.endsWith('-wipe.json'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'backups', wiped), 'utf8')).users.length, 2);

    assert.equal(new Bank({ file, adminPassword: 'from-env' }).adminPassword, 'from-env');

    fs.writeFileSync(file, '{ broken');
    assert.throws(() => new Bank({ file }), SyntaxError);
    assert.equal(fs.readFileSync(file, 'utf8'), '{ broken', 'a damaged file is left alone for the GM to inspect');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

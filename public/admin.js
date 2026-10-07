import { h, icon, api, money, clock, qrSvg, toast, ask, store } from '/ui.js';

const root = document.getElementById('gm');
const watchers = new Set(); // open dialogs that show live numbers
let S = null; // latest state from the server
let view = null;
let paintHeader = () => {};
let pollAbort = null;
let wakePoll = null;

const KIND = { grant: 'Credit', deduct: 'Charge', reversal: 'Reversal' };
const cur = () => S.settings.currency;
const prettyCode = (code) => `${code.slice(0, 5)}-${code.slice(5)}`;
const wholeNumber = (text) => Number(String(text).replace(/\D/g, '')) || 0;
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

// ------------------------------------------------------------------- state

function adopt(state) {
  S = state;
  document.title = `${S.settings.bankName} · GM`;
  paintHeader();
  view?.update();
  for (const update of [...watchers]) update();
}

// Runs a GM action. Every action answers with the fresh state, so the screen updates in one step.
async function act(path, body) {
  try {
    const state = await api(path, body);
    adopt(state);
    return state;
  } catch (err) {
    if (err.status === 401) lock();
    else toast(err.message, 'err');
    return null;
  }
}

function lock() {
  S = null;
  view = null;
  pollAbort?.abort();
  watchers.clear();
  for (const layer of document.querySelectorAll('.overlay, .print-view')) layer.remove();
  document.body.classList.remove('printing');
  Login();
}

// Same parked request as the player app: it returns the moment anything in the bank changes.
async function pollLoop() {
  let delay = 1000;
  for (;;) {
    if (!S || document.hidden) {
      await new Promise((resolve) => {
        wakePoll = resolve;
      });
      continue;
    }
    pollAbort = new AbortController();
    try {
      // After an outage, ask without parking: an immediate answer is what proves the server is back.
      const wait = document.body.classList.contains('offline') ? '' : `?wait=${encodeURIComponent(S.rev)}`;
      const state = await api(`/api/admin/state${wait}`, undefined, { signal: pollAbort.signal });
      document.body.classList.remove('offline');
      delay = 1000;
      if (S) adopt(state);
    } catch (err) {
      if (err.name === 'AbortError') continue;
      if (err.status === 401) {
        if (S) lock();
        continue;
      }
      document.body.classList.add('offline');
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 8000);
    }
  }
}

// The address written into join, login and pay codes. On the server's own machine this page runs on
// "localhost", which phones can't open, so the machine's network address is the default there.
function playerBase() {
  const saved = store.get('gm.base');
  if (saved) return saved;
  const onServer = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  return onServer && S.urls.length ? S.urls[0] : location.origin;
}

function cleanBase(text) {
  const trimmed = text.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

// ----------------------------------------------------------------- pieces

function Dialog(title, ...content) {
  const dialog = { close, onClose: null };
  const overlay = h('div', { class: 'overlay', onclick: (event) => event.target === overlay && close() },
    h('div', { class: 'panel dialog wide' },
      h('div', { class: 'split' },
        h('h2', null, title),
        h('button', { class: 'icon-btn', type: 'button', onclick: close, 'aria-label': 'Close' }, icon('close'))),
      ...content));
  document.body.append(overlay);
  return dialog;

  function close() {
    overlay.remove();
    dialog.onClose?.();
  }
}

function Labeled(label, control, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'label' }, label), control, hint && h('small', null, hint));
}

function Toggle(label, hint, on) {
  const box = h('input', { type: 'checkbox', checked: on });
  return { box, el: h('label', { class: 'switch' }, box, h('i'), h('span', null, h('b', null, label), h('small', null, hint))) };
}

function Stat(label, value) {
  return h('div', { class: 'stat' }, h('span', { class: 'label' }, label), h('b', null, value));
}

// On-screen preview of something to print. While it is open, printing the page prints only the sheet.
function Sheet(kind, nodes, tip) {
  const close = () => {
    sheet.remove();
    document.body.classList.remove('printing');
  };
  const sheet = h('div', { class: 'print-view' },
    h('div', { class: 'print-tools' },
      h('button', { class: 'btn primary', type: 'button', onclick: () => window.print() }, 'Print'),
      h('button', { class: 'btn', type: 'button', onclick: close }, 'Close'),
      h('span', { class: 'hint' }, tip)),
    h('div', { class: `paper ${kind}` }, nodes));
  document.body.classList.add('printing');
  document.body.append(sheet);
}

function AccessCard(user) {
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('b', null, S.settings.bankName), h('span', null, 'Access card')),
    qrSvg(`${playerBase()}/l/${user.code}`),
    h('div', { class: 'card-body' },
      h('div', { class: 'card-name' }, user.handle),
      h('div', { class: 'card-meta' }, `ID ${user.id}`),
      h('div', { class: 'card-meta' }, `Code ${prettyCode(user.code)}`)),
    h('div', { class: 'card-tip' }, 'Scan with your phone camera to log in. This card is your key: keep it to yourself.'));
}

function Sign(top, link, name, meta) {
  return h('div', { class: 'sign' },
    h('div', { class: 'sign-top' }, top),
    qrSvg(link),
    h('div', { class: 'sign-name' }, name),
    h('div', { class: 'sign-meta' }, meta));
}

const PaySign = (user) => Sign('Scan to pay', `${playerBase()}/pay/${user.id}`, user.handle, `${S.settings.bankName} · ID ${user.id}`);
const JoinPoster = () => Sign(S.settings.bankName, playerBase(), 'Scan to jack in', playerBase());

// --------------------------------------------------------------- dialogs

function JoinCode() {
  const { signupsOpen, joinCode } = S.settings;
  Dialog('Join code',
    h('p', { class: 'hint' }, signupsOpen
      ? `Players scan this with their phone camera and create their identity${joinCode ? ` (join code: ${joinCode})` : ''}.`
      : 'Sign-ups are closed, so this only helps players who already have an account or an access card.'),
    h('div', { class: 'qr-big' }, qrSvg(playerBase())),
    h('p', { class: 'address' }, playerBase()),
    h('button', {
      class: 'btn',
      type: 'button',
      onclick: () => Sheet('signs', [JoinPoster()], 'One poster per page.'),
    }, 'Print as poster'));
}

// "Name" or "Name, 5000" per line; tabs and semicolons work too, so a pasted spreadsheet column is fine.
function parseLines(text) {
  return text.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const match = line.match(/^(.*?)\s*[,;\t]\s*(\d[\d\s.,']*)$/);
    return match ? { handle: match[1], balance: wholeNumber(match[2]) } : { handle: line };
  });
}

function NewAccounts() {
  const list = h('textarea', {
    class: 'input area',
    rows: 8,
    spellcheck: false,
    'aria-label': 'Handles',
    placeholder: 'Doc Ripper, 5000\nJackie Wells\nRogue',
  });
  const balance = h('input', { class: 'input', inputMode: 'numeric', value: String(S.settings.startingBalance) });
  const report = h('div', { class: 'stack', hidden: true });
  const create = h('button', { class: 'btn primary', type: 'button', onclick: submit }, 'Create accounts');
  const dialog = Dialog('New accounts',
    h('p', { class: 'hint' }, 'One handle per line. Add a comma and a number to give that account its own starting balance. Each account gets an access card to log in with.'),
    list,
    Labeled('Starting balance for the rest', balance),
    report,
    create);
  list.focus();

  async function submit() {
    const accounts = parseLines(list.value);
    if (!accounts.length) return toast('List at least one handle.', 'err');
    create.disabled = true;
    const state = await act('/api/admin/users', { accounts, balance: wholeNumber(balance.value) });
    create.disabled = false;
    if (!state) return;
    const { created, problems } = state.result;
    if (!problems.length) {
      dialog.close();
      return toast(`${plural(created, 'account')} created.`);
    }
    // Keep only the lines that failed, so they can be fixed and sent again.
    const failed = new Set(problems.map((problem) => problem.handle));
    list.value = accounts
      .filter((account) => failed.has(account.handle))
      .map((account) => (account.balance == null ? account.handle : `${account.handle}, ${account.balance}`))
      .join('\n');
    report.hidden = false;
    report.replaceChildren(
      h('p', { class: 'notice' }, `${plural(created, 'account')} created. These lines were skipped:`),
      ...problems.map((problem) => h('p', { class: 'error' }, `${problem.handle || '(blank)'}: ${problem.message}`)));
  }
}

function AdjustAll() {
  const sum = h('input', { class: 'input', inputMode: 'numeric', placeholder: 'Amount per account', 'aria-label': 'Amount per account' });
  const note = h('input', { class: 'input', maxLength: 80, placeholder: 'Note the players see, e.g. Payday', 'aria-label': 'Note' });
  const go = async (sign) => {
    const amount = wholeNumber(sum.value);
    if (!amount) return toast('Enter an amount first.', 'err');
    const ok = await ask({
      title: sign > 0 ? 'Pay everyone?' : 'Charge everyone?',
      text: `${money(amount, cur())} ${sign > 0 ? 'to' : 'from'} each of ${plural(S.users.length, 'account')}. Charges can push accounts into debt.`,
      confirm: sign > 0 ? 'Pay all' : 'Charge all',
      danger: sign < 0,
    });
    if (ok && await act('/api/admin/adjust-all', { delta: sign * amount, memo: note.value })) {
      dialog.close();
      toast(sign > 0 ? 'Everyone was paid.' : 'Everyone was charged.');
    }
  };
  const dialog = Dialog('Pay or charge everyone',
    h('p', { class: 'hint' }, 'For paydays, rent, taxes and other events that hit every account at once.'),
    sum,
    note,
    h('div', { class: 'pair' },
      h('button', { class: 'btn danger', type: 'button', onclick: () => go(-1) }, 'Charge all'),
      h('button', { class: 'btn primary', type: 'button', onclick: () => go(1) }, 'Pay all')));
  sum.focus();
}

function Manage(id) {
  const account = () => S.users.find((user) => user.id === id);
  const send = (body) => act(`/api/admin/users/${id}`, body);

  const name = h('div', { class: 'manage-name' });
  const balance = h('div', { class: 'manage-balance' });
  const tags = h('div', { class: 'manage-tags' });
  const sum = h('input', { class: 'input', inputMode: 'numeric', placeholder: 'Amount', 'aria-label': 'Amount' });
  const note = h('input', { class: 'input', maxLength: 80, placeholder: 'Note the player sees (optional)', 'aria-label': 'Note' });
  const handle = h('input', { class: 'input', maxLength: 24, value: account().handle, 'aria-label': 'Handle' });
  const accessCode = h('div', { class: 'code-qr' });
  const accessText = h('div', { class: 'code-text' });
  const payCode = h('div', { class: 'code-qr' });
  const freeze = h('button', { class: 'btn', type: 'button', onclick: () => send({ do: 'freeze', frozen: !account().frozen }) });
  const clearPin = h('button', {
    class: 'btn',
    type: 'button',
    onclick: async () => {
      if (await send({ do: 'clearPin' })) toast('PIN cleared. They log in with the access card and can set a new one.');
    },
  }, 'Clear PIN');

  const adjust = async (sign) => {
    const amount = wholeNumber(sum.value);
    if (!amount) return toast('Enter an amount first.', 'err');
    if (await send({ do: 'adjust', delta: sign * amount, memo: note.value })) {
      sum.value = '';
      note.value = '';
    }
  };

  const confirmThen = async (question, body, done) => {
    if (await ask(question) && await send(body)) done?.();
  };

  const dialog = Dialog('Manage account',
    h('div', { class: 'manage-head' }, h('div', null, name, tags), balance),

    h('h3', null, 'Balance'),
    h('div', { class: 'manage-row' }, sum, note),
    h('div', { class: 'pair' },
      h('button', { class: 'btn danger', type: 'button', onclick: () => adjust(-1) }, 'Remove funds'),
      h('button', { class: 'btn primary', type: 'button', onclick: () => adjust(1) }, 'Add funds')),

    h('h3', null, 'Handle'),
    h('form', {
      class: 'inline',
      onsubmit: async (event) => {
        event.preventDefault();
        if (await send({ do: 'rename', handle: handle.value })) toast('Renamed.');
      },
    }, handle, h('button', { class: 'btn', type: 'submit' }, 'Rename')),

    h('h3', null, 'Codes'),
    h('div', { class: 'codes' },
      h('div', { class: 'code-box' },
        h('span', { class: 'label' }, 'Access card · logs in'),
        accessCode,
        accessText,
        h('button', {
          class: 'btn small',
          type: 'button',
          onclick: () => Sheet('cards', [AccessCard(account())], 'Cut out and hand to the player.'),
        }, 'Print card')),
      h('div', { class: 'code-box' },
        h('span', { class: 'label' }, 'Pay code · receives money'),
        payCode,
        h('div', { class: 'code-text' }, `ID ${id}`),
        h('button', {
          class: 'btn small',
          type: 'button',
          onclick: () => Sheet('signs', [PaySign(account())], 'A sign for a shop counter or a clinic door.'),
        }, 'Print pay sign'))),

    h('h3', null, 'Controls'),
    h('div', { class: 'manage-actions' },
      freeze,
      clearPin,
      h('button', {
        class: 'btn',
        type: 'button',
        onclick: () => confirmThen({
          title: 'Issue a new access code?',
          text: 'The current card stops working. Phones that are already logged in stay logged in.',
          confirm: 'New code',
        }, { do: 'newCode' }, () => toast('New access code issued.')),
      }, 'New access code'),
      h('button', {
        class: 'btn',
        type: 'button',
        onclick: () => confirmThen({
          title: 'Log out all devices?',
          text: 'Every phone using this account has to log in again.',
          confirm: 'Log out',
        }, { do: 'logout' }, () => toast('All devices logged out.')),
      }, 'Log out devices'),
      h('button', {
        class: 'btn danger',
        type: 'button',
        onclick: () => confirmThen({
          title: `Delete ${account().handle}?`,
          text: 'The account and its balance are removed for good. Past transactions stay in the ledger.',
          confirm: 'Delete',
          danger: true,
        }, { do: 'delete' }),
      }, 'Delete account')));

  watchers.add(update);
  dialog.onClose = () => watchers.delete(update);
  update();

  function update() {
    const user = account();
    if (!user) return dialog.close();
    name.textContent = user.handle;
    balance.textContent = money(user.balance, cur());
    balance.classList.toggle('neg', user.balance < 0);
    tags.replaceChildren(...[
      h('span', { class: 'tag' }, `ID ${user.id}`),
      h('span', { class: `tag ${user.online ? 'live' : 'off'}` }, user.online ? 'Online' : 'Offline'),
      h('span', { class: 'tag off' }, user.hasPin ? 'PIN set' : 'No PIN'),
      user.frozen && h('span', { class: 'tag bad' }, 'Frozen'),
    ].filter(Boolean));
    freeze.textContent = user.frozen ? 'Unfreeze' : 'Freeze';
    clearPin.disabled = !user.hasPin;
    showCode(accessCode, `${playerBase()}/l/${user.code}`);
    showCode(payCode, `${playerBase()}/pay/${user.id}`);
    accessText.textContent = prettyCode(user.code);
  }

  // Redrawn only when the link changes, so live balance updates don't make the codes flicker.
  function showCode(box, link) {
    if (box.dataset.link === link) return;
    box.dataset.link = link;
    box.replaceChildren(qrSvg(link));
  }
}

function Wipe() {
  const word = h('input', {
    class: 'input',
    autocomplete: 'off',
    autocapitalize: 'characters',
    spellcheck: false,
    placeholder: 'Type WIPE',
    'aria-label': 'Type WIPE to confirm',
  });
  const dialog = Dialog('Wipe everything',
    h('p', { class: 'error' }, 'Deletes every account, balance and transaction and logs all players out. Settings are kept, and a backup of the current data is saved in the server’s data/backups folder first.'),
    word,
    h('button', {
      class: 'btn danger',
      type: 'button',
      onclick: async () => {
        if (await act('/api/admin/wipe', { confirm: word.value.trim().toUpperCase() })) {
          dialog.close();
          toast('The bank is empty.');
        }
      },
    }, 'Wipe the bank'));
  word.focus();
}

// ------------------------------------------------------------------- views

function Accounts() {
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Filter by name or ID', 'aria-label': 'Filter accounts', oninput: update });
  const rows = h('tbody');
  const empty = h('p', { class: 'hint', hidden: true });
  const el = h('div', { class: 'stack' },
    h('div', { class: 'toolbar' },
      search,
      h('button', { class: 'btn primary', type: 'button', onclick: NewAccounts }, 'New accounts'),
      h('button', { class: 'btn', type: 'button', onclick: AdjustAll }, 'Pay or charge all'),
      h('button', { class: 'btn', type: 'button', onclick: printCards }, 'Print access cards')),
    h('div', { class: 'table-wrap' },
      h('table', { class: 'grid' },
        h('thead', null, h('tr', null, ['', 'Handle', 'ID', 'Balance', 'Login', ''].map((title) => h('th', null, title)))),
        rows)),
    empty);
  update();
  return { el, update };

  function shown() {
    const query = search.value.trim().toLowerCase().replace(/^#/, '');
    return S.users.filter((user) => !query || user.handle.toLowerCase().includes(query) || user.id.toLowerCase().includes(query));
  }

  function printCards() {
    const list = shown();
    if (!list.length) return toast('There are no accounts to print.', 'err');
    Sheet('cards', list.map(AccessCard), `${plural(list.length, 'card')}. Cut along the borders. Filter the list first to print only some.`);
  }

  function update() {
    const list = shown();
    rows.replaceChildren(...list.map(Row));
    empty.hidden = list.length > 0;
    empty.textContent = S.users.length
      ? 'No account matches that filter.'
      : 'No accounts yet. Create them here, or show players the join code and let them sign up.';
  }

  function Row(user) {
    return h('tr', { class: 'clickable', onclick: () => Manage(user.id) },
      h('td', null, h('i', { class: `dot ${user.online ? 'on' : ''}`, title: user.online ? 'App open right now' : 'Not connected' })),
      h('td', { class: 'name' }, user.handle, user.frozen && h('span', { class: 'tag bad' }, 'Frozen')),
      h('td', { class: 'mono' }, user.id),
      h('td', { class: `num ${user.balance < 0 ? 'neg' : ''}` }, money(user.balance, cur())),
      h('td', { class: 'mono dim' }, user.hasPin ? 'PIN set' : 'Card only'),
      h('td', { class: 'end' }, h('button', { class: 'btn small', type: 'button' }, 'Manage')));
  }
}

function Ledger() {
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Filter by name, ID or note', 'aria-label': 'Filter transactions', oninput: update });
  const rows = h('tbody');
  const foot = h('p', { class: 'hint' });
  const el = h('div', { class: 'stack' },
    h('div', { class: 'toolbar' },
      search,
      h('a', { class: 'btn', href: '/api/admin/ledger.csv', download: 'ledger.csv' }, 'Export CSV')),
    h('div', { class: 'table-wrap' },
      h('table', { class: 'grid' },
        h('thead', null, h('tr', null, ['TX', 'Time', 'From', 'To', 'Amount', 'Note', ''].map((title) => h('th', null, title)))),
        rows)),
    foot);
  update();
  return { el, update };

  function update() {
    const query = search.value.trim().toLowerCase();
    const bank = S.settings.bankName;
    const list = S.tx.filter((tx) => !query || [tx.from?.name ?? bank, tx.to?.name ?? bank, tx.from?.id, tx.to?.id, tx.memo]
      .some((value) => value && value.toLowerCase().includes(query)));
    rows.replaceChildren(...list.map(Row));
    foot.textContent = S.txCount > S.tx.length
      ? `Showing the latest ${S.tx.length} of ${S.txCount} transactions. Export the CSV for the full history.`
      : list.length ? '' : S.txCount ? 'Nothing matches that filter.' : 'No transactions yet.';
  }

  function party(who) {
    return who ? [who.name, h('span', { class: 'mono dim' }, ` ${who.id}`)] : h('span', { class: 'dim' }, S.settings.bankName);
  }

  async function reverse(tx) {
    const ok = await ask({
      title: `Reverse TX ${tx.id}?`,
      text: `${money(tx.amount, cur())} goes back from ${tx.to?.name ?? S.settings.bankName} to ${tx.from?.name ?? S.settings.bankName}, even if it was already spent.`,
      confirm: 'Reverse',
      danger: true,
    });
    if (ok && await act('/api/admin/reverse', { tx: tx.id })) toast('Transaction reversed.');
  }

  function Row(tx) {
    return h('tr', { class: tx.reversedBy ? 'void' : '' },
      h('td', { class: 'mono dim' }, String(tx.id).padStart(4, '0')),
      h('td', { class: 'mono dim' }, clock(tx.at)),
      h('td', null, party(tx.from)),
      h('td', null, party(tx.to)),
      h('td', { class: 'num' }, money(tx.amount, cur())),
      h('td', { class: 'memo' }, KIND[tx.kind] && h('span', { class: 'tag off' }, KIND[tx.kind]), tx.memo),
      h('td', { class: 'end' }, tx.reversedBy
        ? h('span', { class: 'mono dim' }, 'Reversed')
        : tx.kind !== 'reversal' && h('button', { class: 'btn small', type: 'button', onclick: () => reverse(tx) }, 'Reverse')));
  }
}

// Not refreshed by live updates: a poll must never overwrite what the GM is typing.
function Settings() {
  const now = S.settings;
  const bankName = h('input', { class: 'input', maxLength: 24, value: now.bankName, required: true });
  const currency = h('input', { class: 'input', maxLength: 4, value: now.currency, required: true });
  const startingBalance = h('input', { class: 'input', inputMode: 'numeric', value: String(now.startingBalance) });
  const joinCode = h('input', { class: 'input', maxLength: 32, value: now.joinCode, placeholder: 'None', autocomplete: 'off', spellcheck: false });
  const signupsOpen = Toggle('Players can sign up themselves', 'Off: only accounts you create exist, and players log in with their access card.', now.signupsOpen);
  const directory = Toggle('Public directory', 'Off: players only see people they have already traded with, and pay everyone else by scanning or typing an ID.', now.directory);

  const el = h('div', { class: 'stack settings' },
    h('form', {
      class: 'stack',
      onsubmit: async (event) => {
        event.preventDefault();
        const saved = await act('/api/admin/settings', {
          bankName: bankName.value,
          currency: currency.value,
          startingBalance: wholeNumber(startingBalance.value),
          joinCode: joinCode.value,
          signupsOpen: signupsOpen.box.checked,
          directory: directory.box.checked,
        });
        if (saved) toast('Settings saved.');
      },
    },
      h('div', { class: 'pair' },
        Labeled('Bank name', bankName, 'Shown on every screen.'),
        Labeled('Currency symbol', currency, 'Up to 4 characters, e.g. ¥, €$, CR.')),
      h('div', { class: 'pair' },
        Labeled('Starting balance', startingBalance, 'Given to players who sign up themselves.'),
        Labeled('Join code', joinCode, 'Optional word players must enter to sign up.')),
      signupsOpen.el,
      directory.el,
      h('button', { class: 'btn primary', type: 'submit' }, 'Save settings')),
    h('div', { class: 'section-head' }, h('h2', null, 'Danger zone')),
    h('p', { class: 'hint' }, 'Start over after a test run. A backup is kept on the server.'),
    h('button', { class: 'btn danger', type: 'button', onclick: Wipe }, 'Wipe everything'));
  return { el, update() {} };
}

const VIEWS = {
  accounts: { label: 'Accounts', make: Accounts },
  ledger: { label: 'Ledger', make: Ledger },
  settings: { label: 'Settings', make: Settings },
};

// ----------------------------------------------------------------- screens

function Login() {
  const password = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', required: true });
  const error = h('p', { class: 'error', role: 'alert', hidden: true });
  root.replaceChildren(h('form', {
    class: 'gm-login stack',
    onsubmit: async (event) => {
      event.preventDefault();
      error.hidden = true;
      try {
        S = await api('/api/admin/login', { password: password.value });
        Console();
        wakePoll?.();
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
      }
    },
  },
    h('div', { class: 'brand-mark', style: '--chars: 10' }, 'GM console'),
    h('div', { class: 'hazard' }),
    Labeled('Password', password, 'Printed in the terminal window where the server was started.'),
    error,
    h('button', { class: 'btn primary big', type: 'submit' }, 'Unlock')));
  password.focus();
}

function Console() {
  const brand = h('div', { class: 'gm-brand' });
  const stats = h('div', { class: 'gm-stats' });
  const bases = h('datalist', { id: 'gm-bases' });
  const base = h('input', {
    class: 'input',
    spellcheck: false,
    autocomplete: 'off',
    autocapitalize: 'off',
    'aria-label': 'Player address',
    onchange: () => {
      store.set('gm.base', cleanBase(base.value));
      adopt(S);
    },
  });
  base.setAttribute('list', bases.id);
  const unreachable = h('p', { class: 'notice bad', hidden: true }, 'Phones can’t open “localhost”. Enter this machine’s network address here, or the public address if you use a tunnel.');
  const tabs = h('div', { class: 'tabs' });
  const body = h('div');

  const open = (name) => {
    store.set('gm.tab', name);
    view = VIEWS[name].make();
    body.replaceChildren(view.el);
    tabs.replaceChildren(...Object.entries(VIEWS).map(([key, { label }]) => h('button', {
      class: `tab ${key === name ? 'on' : ''}`,
      type: 'button',
      onclick: () => open(key),
    }, label)));
  };

  paintHeader = () => {
    brand.replaceChildren(S.settings.bankName, h('small', null, 'GM console'));
    stats.replaceChildren(
      Stat('Accounts', S.users.length),
      Stat('Online', S.users.filter((user) => user.online).length),
      Stat('In circulation', money(S.supply, cur())),
      Stat('Transfers', S.txCount));
    if (document.activeElement !== base) base.value = playerBase();
    bases.replaceChildren(...[...new Set([...S.urls, location.origin])].map((value) => h('option', { value })));
    unreachable.hidden = !/\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(playerBase());
  };

  root.replaceChildren(
    h('header', { class: 'gm-head' },
      brand,
      h('button', {
        class: 'btn small',
        type: 'button',
        onclick: async () => {
          await api('/api/admin/logout', {}).catch(() => {});
          lock();
        },
      }, 'Lock')),
    stats,
    h('section', { class: 'gm-join' },
      h('span', { class: 'label' }, 'Players join at'),
      base,
      h('button', { class: 'btn small', type: 'button', onclick: JoinCode }, 'Show join code')),
    bases,
    unreachable,
    tabs,
    body);

  const wanted = store.get('gm.tab');
  open(VIEWS[wanted] ? wanted : 'accounts');
  adopt(S);
}

async function boot() {
  try {
    S = await api('/api/admin/state');
    Console();
  } catch (err) {
    if (err.status === 401) Login();
    else {
      root.replaceChildren(h('div', { class: 'boot' },
        h('p', null, err.message),
        h('button', { class: 'btn', type: 'button', onclick: () => location.reload() }, 'Retry')));
      return;
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pollAbort?.abort();
    else wakePoll?.();
  });
  pollLoop();
}

boot();

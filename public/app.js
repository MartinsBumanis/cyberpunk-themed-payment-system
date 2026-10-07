import { h, icon, api, digits, money, clock, qrSvg, toast, ask, sfx, buzz, store } from '/ui.js';

const root = document.getElementById('app');
const state = { config: null, me: null };
const trail = [];
let screen = null;
let pollAbort = null;
let wakePoll = null;

// ------------------------------------------------------------------ routing

// QR codes carry plain paths (/pay/<id>, /l/<code>) so any camera app can open them;
// inside the app every screen is a hash route.
function adoptDeepLink() {
  const pay = location.pathname.match(/^\/pay\/([^/]+)/);
  const card = location.pathname.match(/^\/l\/([^/]+)/);
  if (pay) history.replaceState(null, '', `/#/pay/${pay[1]}${location.search}`);
  else if (card) history.replaceState(null, '', '/');
  return card ? card[1] : null;
}

function currentRoute() {
  const [pathPart, queryPart = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const [name = '', ...args] = pathPart.split('/');
  return { name, args, query: new URLSearchParams(queryPart) };
}

function navigate(hash, replace = false) {
  if (!replace) {
    location.hash = hash;
    return;
  }
  history.replaceState(null, '', hash);
  trail[trail.length - 1] = hash;
  render();
}

function onRoute() {
  const hash = location.hash || '#/';
  if (trail[trail.length - 2] === hash) trail.pop();
  else if (trail[trail.length - 1] !== hash) trail.push(hash);
  render();
}

// A payment link opened straight from the camera has no earlier screen, so "back" means home.
function back() {
  if (trail.length > 1) history.back();
  else navigate('#/', true);
}

function render() {
  screen?.destroy?.();
  for (const sheet of document.querySelectorAll('.sheet-wrap')) sheet.remove();
  const route = currentRoute();
  screen = state.me ? (SCREENS[route.name] ?? Home)(route) : Auth(route);
  root.replaceChildren(screen.el);
  scrollTo(0, 0);
}

// ------------------------------------------------------------ session state

function enter(snap) {
  state.me = snap;
  store.set('handle', snap.user.handle);
  document.title = snap.settings.bankName;
  noteIncoming(snap);
  render();
  wakePoll?.();
}

async function leave() {
  state.me = null;
  pollAbort?.abort();
  for (const overlay of document.querySelectorAll('.overlay')) overlay.remove();
  // Sign-ups may have been opened or closed since this phone last saw the login screen,
  // and another tab of this browser may have logged in as someone else in the meantime.
  const boot = await api('/api/boot').catch(() => null);
  if (boot) state.config = boot.config;
  if (boot?.me) return enter(boot.me);
  document.title = state.config.bankName;
  render();
}

function applySnapshot(snap) {
  const before = state.me;
  state.me = snap;
  document.title = snap.settings.bankName;
  noteIncoming(snap);
  const reskinned = JSON.stringify(before.settings) !== JSON.stringify(snap.settings) || before.user.handle !== snap.user.handle;
  if (reskinned) render();
  else screen?.onData?.();
}

// Announces money that arrived since this phone last looked, including while it was asleep.
// The first snapshot on a device only sets the baseline.
function noteIncoming(snap) {
  const key = `seen:${snap.user.id}`;
  const seen = store.get(key);
  const newest = snap.tx[0]?.id ?? 0;
  if (seen != null) {
    const fresh = snap.tx.filter((tx) => tx.dir === 'in' && tx.id > Number(seen));
    if (fresh.length) Incoming(fresh);
  }
  if (seen == null || newest > Number(seen)) store.set(key, String(newest));
}

// One request stays parked on the server and returns the moment the balance changes.
// It is dropped while the tab is hidden so background tabs don't hog connections.
async function pollLoop() {
  let delay = 1000;
  for (;;) {
    if (!state.me || document.hidden) {
      await new Promise((resolve) => {
        wakePoll = resolve;
      });
      continue;
    }
    pollAbort = new AbortController();
    try {
      // After an outage, ask without parking: an immediate answer is what proves the link is back.
      const wait = document.body.classList.contains('offline') ? '' : `?wait=${encodeURIComponent(state.me.rev)}`;
      const snap = await api(`/api/me${wait}`, undefined, { signal: pollAbort.signal });
      document.body.classList.remove('offline');
      delay = 1000;
      if (state.me) applySnapshot(snap);
    } catch (err) {
      if (err.name === 'AbortError') continue;
      if (err.status === 401) {
        if (state.me) await leave();
        continue;
      }
      document.body.classList.add('offline');
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 8000);
    }
  }
}

async function useAccessCode(code) {
  try {
    if (state.me) {
      const owner = await api('/api/login/code', { code, peek: true });
      if (owner.id === state.me.user.id) return toast(`Already logged in as ${owner.handle}.`);
      const ok = await ask({
        title: 'Switch account?',
        text: `This access card belongs to ${owner.handle}. You are logged in as ${state.me.user.handle}.`,
        confirm: 'Switch',
      });
      if (!ok) return;
      pollAbort?.abort();
    }
    enter(await api('/api/login/code', { code }));
  } catch (err) {
    toast(err.message, 'err');
  }
}

// ------------------------------------------------------------------ helpers

function toAmount(text) {
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= 1 && value <= 1e9 ? value : 0;
}

// Accepts a pay link, an access-card link, or a bare 4-character ID. The host is ignored on purpose:
// a code printed for one address must still scan when the server is reached through another.
function parseCode(text) {
  const raw = String(text).trim();
  try {
    const url = new URL(raw);
    const pay = url.pathname.match(/^\/pay\/([A-Za-z0-9]{4})\/?$/);
    if (pay) return { id: pay[1].toUpperCase(), amount: toAmount(url.searchParams.get('a')), memo: url.searchParams.get('m') ?? '' };
    const card = url.pathname.match(/^\/l\/([A-Za-z0-9-]{10,12})\/?$/);
    if (card) return { card: card[1] };
  } catch {
    // not a link: maybe a bare ID
  }
  const bare = raw.replace(/^#/, '');
  return /^[A-Za-z0-9]{4}$/.test(bare) ? { id: bare.toUpperCase(), amount: 0, memo: '' } : null;
}

function payQuery(amount, memo) {
  const query = new URLSearchParams();
  if (amount) query.set('a', amount);
  if (memo) query.set('m', memo);
  const text = query.toString();
  return text ? `?${text}` : '';
}

function randomKey() {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function frame(title, ...body) {
  return h('div', { class: 'screen' },
    h('header', { class: 'bar' },
      h('button', { class: 'icon-btn', onclick: back, 'aria-label': 'Back' }, icon('back')),
      h('h1', null, title)),
    ...body);
}

function Field(label, props, hint) {
  const input = h('input', { class: 'input', ...props });
  const el = h('label', { class: 'field' }, h('span', { class: 'label' }, label), input, hint && h('small', null, hint));
  return { input, el };
}

const corners = () => ['tl', 'tr', 'bl', 'br'].map((at) => h('i', { class: `corner ${at}` }));

function Amount(el, value, currency) {
  el.replaceChildren(h('span', { class: 'cur' }, currency), digits(value));
  el.classList.toggle('neg', value < 0);
  if (value < 0) el.prepend('−');
  // Long numbers step down a size so they never spill out of the panel.
  const { length } = el.textContent;
  el.dataset.size = length > 14 ? 'xs' : length > 11 ? 's' : length > 8 ? 'm' : 'l';
}

function Keypad(onKey) {
  return h('div', { class: 'keypad' },
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', 'del'].map((key) => h('button', {
      class: 'key',
      type: 'button',
      'aria-label': key === 'del' ? 'Delete' : key,
      onclick: () => {
        buzz(8);
        onKey(key);
      },
    }, key === 'del' ? icon('del', 26) : key)));
}

function pressKey(typed, key) {
  if (key === 'del') return typed.slice(0, -1);
  const next = (typed + key).replace(/^0+/, '');
  return next.length > 9 ? typed : next;
}

function TxRow(tx) {
  const { currency, bankName } = state.me.settings;
  const incoming = tx.dir === 'in';
  const fallback = { grant: 'Credit', deduct: 'Charge', reversal: 'Reversal' }[tx.kind];
  return h('div', { class: `tx ${tx.dir}` },
    h('div', { class: 'tx-icon' }, icon(incoming ? 'receive' : 'send', 18)),
    h('div', { class: 'tx-main' },
      h('div', { class: 'tx-who' }, tx.peer?.name ?? bankName),
      h('div', { class: 'tx-note' }, [clock(tx.at), tx.memo || fallback].filter(Boolean).join(' · '))),
    h('div', { class: 'tx-amount' }, `${incoming ? '+' : '−'}${money(tx.amount, currency)}`));
}

// ------------------------------------------------------------------ screens

function Auth(route) {
  const { config } = state;
  const el = h('div', { class: 'screen auth' });
  let mode = store.get('handle') || !config.signupsOpen ? 'login' : 'signup';
  paint();
  return { el };

  function paint() {
    const error = h('p', { class: 'error', role: 'alert', hidden: true });
    const handle = Field(mode === 'signup' ? 'Handle' : 'Handle or ID', {
      name: 'username',
      autocomplete: 'username',
      autocapitalize: 'off',
      spellcheck: false,
      maxLength: 24,
      required: true,
      value: mode === 'login' ? store.get('handle') ?? '' : '',
    }, mode === 'signup' && 'Your street name. Other players see it.');
    const pin = Field(mode === 'signup' ? 'Choose a PIN' : 'PIN', {
      type: 'password',
      name: 'pin',
      inputMode: 'numeric',
      pattern: '[0-9]*',
      autocomplete: mode === 'signup' ? 'new-password' : 'current-password',
      maxLength: 8,
      required: true,
    }, mode === 'signup' && '4 to 8 digits. You need it to log back in.');
    const join = Field('Join code', {
      autocapitalize: 'off',
      autocomplete: 'off',
      spellcheck: false,
      maxLength: 32,
      required: true,
    }, 'Given out by your game master.');
    const code = Field('Access code', {
      autocapitalize: 'characters',
      autocomplete: 'off',
      spellcheck: false,
      maxLength: 16,
      placeholder: 'XXXXX-XXXXX',
      required: true,
    }, 'Printed on the card your game master gave you.');
    const submit = h('button', { class: 'btn primary big', type: 'submit' }, mode === 'signup' ? 'Create identity' : 'Jack in');

    const send = () => {
      if (mode === 'card') return api('/api/login/code', { code: code.input.value });
      if (mode === 'signup') return api('/api/signup', { handle: handle.input.value, pin: pin.input.value, joinCode: join.input.value });
      return api('/api/login', { who: handle.input.value, pin: pin.input.value });
    };

    const form = h('form', {
      class: 'stack',
      onsubmit: async (event) => {
        event.preventDefault();
        error.hidden = true;
        submit.disabled = true;
        try {
          enter(await send());
        } catch (err) {
          error.textContent = err.message;
          error.hidden = false;
          submit.disabled = false;
          sfx('err');
        }
      },
    },
      mode === 'card' ? code.el : [handle.el, pin.el, mode === 'signup' && config.needsJoinCode && join.el],
      error,
      submit);

    const tab = (name, label) => h('button', {
      class: `tab ${mode === name ? 'on' : ''}`,
      type: 'button',
      onclick: () => {
        mode = name;
        paint();
      },
    }, label);

    el.replaceChildren(...[
      h('div', { class: 'brand' },
        h('div', { class: 'brand-mark glitch', 'data-text': config.bankName, style: `--chars: ${Math.max(6, Array.from(config.bankName).length)}` }, config.bankName),
        h('div', { class: 'brand-tag' }, 'Money moves. Nobody asks.')),
      h('div', { class: 'hazard' }),
      route.name === 'pay' && h('p', { class: 'notice' }, 'Log in to finish your transfer.'),
      h('div', { class: 'tabs' },
        tab('login', 'Log in'),
        config.signupsOpen && tab('signup', 'Sign up'),
        tab('card', 'Access card')),
      form,
      mode === 'login' && !config.signupsOpen && h('p', { class: 'hint' }, 'New identities are issued by your game master.'),
    ].filter(Boolean));
  }
}

function Home() {
  const amount = h('div', { class: 'balance-amount' });
  const frozen = h('p', { class: 'notice bad', hidden: true }, 'Account frozen. Outgoing transfers are blocked.');
  const activity = h('div', { class: 'tx-list' });
  const { user, settings } = state.me;
  let shown = user.balance;

  const el = h('div', { class: 'screen home' },
    h('header', { class: 'top' },
      h('div', { class: 'top-brand', style: `--chars: ${Array.from(settings.bankName).length}` }, settings.bankName),
      h('a', { class: 'me-chip', href: '#/me', 'aria-label': 'Account' }, icon('user', 16), h('span', null, user.handle))),
    h('section', { class: 'panel balance' },
      h('div', { class: 'split' }, h('span', { class: 'label' }, 'Balance'), h('span', { class: 'tag' }, `ID ${user.id}`)),
      amount,
      h('div', { class: 'link-state' }, h('i'), h('span', { class: 'on' }, 'Link secure'), h('span', { class: 'off' }, 'Link lost · reconnecting'))),
    frozen,
    h('a', { class: 'btn primary big', href: '#/scan' }, icon('scan', 26), 'Scan to pay'),
    h('div', { class: 'pair' },
      h('a', { class: 'btn', href: '#/send' }, icon('send'), 'Send'),
      h('a', { class: 'btn', href: '#/receive' }, icon('receive'), 'Receive')),
    h('div', { class: 'section-head' }, h('h2', null, 'Activity'), h('a', { href: '#/history' }, 'All')),
    activity);

  Amount(amount, shown, settings.currency);
  paint();
  return { el, onData: paint };

  function paint() {
    const { user: now, tx } = state.me;
    frozen.hidden = !now.frozen;
    activity.replaceChildren(...(tx.length
      ? tx.slice(0, 8).map(TxRow)
      : [h('p', { class: 'hint' }, 'Nothing yet. Scan a pay code to make your first transfer.')]));
    if (now.balance === shown) return;
    amount.classList.remove('up', 'down');
    void amount.offsetWidth; // restarts the flash animation
    amount.classList.add(now.balance > shown ? 'up' : 'down');
    count(shown, now.balance);
    shown = now.balance;
  }

  function count(from, to) {
    const began = performance.now();
    const run = (amount.run = {});
    const instant = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const step = (now) => {
      if (amount.run !== run) return;
      const t = instant ? 1 : Math.min(1, (now - began) / 600);
      Amount(amount, Math.round(from + (to - from) * (1 - (1 - t) ** 3)), settings.currency);
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}

// Live camera needs a secure origin (https or localhost). Without one the phone's own camera app still works,
// because pay codes are ordinary links, and a still photo can be decoded here as a fallback.
function Scanner(onText) {
  const video = h('video');
  const hint = h('p', { class: 'hint center' }, 'Starting camera…');
  const torch = h('button', { class: 'icon-btn torch', type: 'button', hidden: true, 'aria-label': 'Flashlight' }, icon('flash'));
  const view = h('div', { class: 'viewfinder' }, video, h('div', { class: 'reticle' }, corners()), torch);
  const photo = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true, onchange: fromPhoto });
  const why = h('p', { class: 'hint' });
  const fallback = h('div', { class: 'stack', hidden: true },
    why,
    h('button', { class: 'btn primary big', type: 'button', onclick: () => photo.click() }, icon('camera', 24), 'Photograph the code'));
  const el = h('div', { class: 'stack' }, view, hint, fallback, photo);
  const loadEngine = () => import('/vendor/qr-scanner.min.js').then((module) => module.default);
  let live = null;
  let closed = false;
  let last = { text: '', at: 0 };

  start();
  return {
    el,
    destroy() {
      closed = true;
      live?.destroy();
    },
  };

  async function start() {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      return noCamera('Live scanning needs a secure (https) connection. Your phone’s own camera app works too: point it at a pay code and the payment opens here.');
    }
    try {
      const QrScanner = await loadEngine();
      if (closed) return;
      live = new QrScanner(video, (result) => report(result.data), {
        preferredCamera: 'environment',
        maxScansPerSecond: 12,
        returnDetailedScanResult: true,
      });
      await live.start();
      if (closed) return;
      hint.textContent = 'Point at a pay code';
      if (await live.hasFlash()) {
        torch.hidden = false;
        torch.onclick = () => live.toggleFlash();
      }
    } catch {
      noCamera('The camera is not available. Allow camera access for this site and reopen this screen, or use a photo instead.');
    }
  }

  function noCamera(reason) {
    view.hidden = true;
    hint.hidden = true;
    fallback.hidden = false;
    why.textContent = reason;
  }

  // onText returns a complaint to keep scanning, or nothing when the code was accepted.
  function report(text) {
    const now = Date.now();
    if (closed || (text === last.text && now - last.at < 2500)) return;
    last = { text, at: now };
    const complaint = onText(text);
    if (!complaint) return buzz(30);
    toast(complaint, 'err');
    buzz(60);
  }

  async function fromPhoto() {
    const file = photo.files[0];
    photo.value = '';
    if (!file) return;
    try {
      const QrScanner = await loadEngine();
      const result = await QrScanner.scanImage(await shrink(file), { returnDetailedScanResult: true });
      last = { text: '', at: 0 };
      report(result.data);
    } catch {
      toast('No code found in that photo. Fill the frame with the code and try again.', 'err');
    }
  }

  // Phone photos are huge; decoding a 1400px copy is much faster and just as reliable.
  async function shrink(file) {
    if (!window.createImageBitmap) return file;
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1400 / Math.max(bitmap.width, bitmap.height));
    const canvas = h('canvas', { width: Math.round(bitmap.width * scale), height: Math.round(bitmap.height * scale) });
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas;
  }
}

function Scan() {
  const scanner = Scanner((text) => {
    const code = parseCode(text);
    if (!code) return 'That is not a pay code.';
    if (code.card) {
      navigate('#/', true);
      useAccessCode(code.card);
    } else if (code.id === state.me.user.id) {
      return 'That is your own code.';
    } else {
      navigate(`#/pay/${code.id}${payQuery(code.amount, code.memo)}`, true);
    }
    return null;
  });
  const manual = h('input', {
    class: 'input',
    placeholder: 'Or type an ID',
    maxLength: 5,
    autocapitalize: 'characters',
    autocomplete: 'off',
    spellcheck: false,
    'aria-label': 'Account ID',
  });
  const el = frame('Scan to pay',
    scanner.el,
    h('form', {
      class: 'inline',
      onsubmit: (event) => {
        event.preventDefault();
        const code = parseCode(manual.value);
        if (!code?.id) toast('An ID is 4 letters or digits.', 'err');
        else if (code.id === state.me.user.id) toast('That is your own ID.', 'err');
        else navigate(`#/pay/${code.id}`, true);
      },
    }, manual, h('button', { class: 'btn', type: 'submit' }, 'Go')),
    h('a', { class: 'link', href: '#/send' }, 'Pick someone from the list'));
  return { el, destroy: scanner.destroy };
}

function Send() {
  const list = h('div', { class: 'people' });
  const search = h('input', {
    class: 'input',
    type: 'search',
    placeholder: 'Search name or ID',
    autocapitalize: 'off',
    autocomplete: 'off',
    spellcheck: false,
    'aria-label': 'Search',
    oninput: paint,
  });
  let people = null;
  let probe = { id: null, person: null }; // a typed ID that is not in the list, and who it turned out to be
  api('/api/users').then((data) => {
    people = data.users;
    paint();
  }, (err) => list.replaceChildren(h('p', { class: 'error' }, err.message)));
  paint();
  return { el: frame('Send', search, list) };

  function paint() {
    if (!people) return list.replaceChildren(h('p', { class: 'hint' }, 'Loading…'));
    const { user, settings } = state.me;
    const query = search.value.trim().toLowerCase().replace(/^#/, '');
    // People you traded with most recently come first.
    const recent = [...new Set(state.me.tx.map((tx) => tx.peer?.id).filter(Boolean))];
    const rank = (person) => (recent.indexOf(person.id) + 1) || Infinity;
    const shown = people
      .filter((person) => !query || person.handle.toLowerCase().includes(query) || person.id.toLowerCase().includes(query))
      .sort((a, b) => (rank(a) === rank(b) ? a.handle.localeCompare(b.handle) : rank(a) - rank(b)));

    // With a private directory the list is incomplete, so a complete ID typed here is looked up directly.
    const typedId = !settings.directory && parseCode(query)?.id;
    const unlisted = typedId && typedId !== user.id && !people.some((person) => person.id === typedId) ? typedId : null;
    if (unlisted && probe.id !== unlisted) {
      probe = { id: unlisted, person: null };
      api(`/api/users/${unlisted}`).then((person) => {
        if (probe.id !== unlisted) return;
        probe.person = person;
        paint();
      }, () => {});
    }
    const found = unlisted && probe.id === unlisted && probe.person;

    const empty = !shown.length && !found && h('p', { class: 'hint' },
      query ? 'Nobody matches. Scan their code or type their 4-character ID.'
        : settings.directory ? 'Nobody else is on the grid yet.'
          : 'The directory is private. Scan a code or type a 4-character ID; people you trade with show up here.');
    list.replaceChildren(...[...shown.map(Person), found && Person(found), empty].filter(Boolean));
  }

  function Person({ id, handle }) {
    return h('a', { class: 'person', href: `#/pay/${id}` },
      h('span', { class: 'avatar' }, Array.from(handle)[0].toUpperCase()),
      h('span', { class: 'person-name' }, handle),
      h('span', { class: 'tag' }, id));
  }
}

function Pay({ args, query }) {
  const id = String(args[0] ?? '').toUpperCase();
  const fixed = toAmount(query.get('a'));
  const key = randomKey();
  let typed = fixed ? String(fixed) : '';
  let payee = null;
  let busy = false;
  let paid = false;

  const who = h('div', { class: 'payee-name' }, 'Looking up…');
  const amount = h('div', { class: 'amount' });
  const after = h('div', { class: 'after' });
  const memo = h('input', {
    class: 'input',
    placeholder: 'Add a note (optional)',
    maxLength: 80,
    value: (query.get('m') ?? '').slice(0, 80),
    enterKeyHint: 'done',
    'aria-label': 'Note',
  });
  const error = h('p', { class: 'error', role: 'alert', hidden: true });
  const send = h('button', { class: 'btn primary big', type: 'button', onclick: submit });

  const el = frame('Transfer',
    h('section', { class: 'panel payee' },
      h('div', { class: 'split' }, h('span', { class: 'label' }, 'To'), h('span', { class: 'tag' }, `ID ${id}`)),
      who),
    h('div', { class: 'amount-block' },
      fixed ? h('span', { class: 'label' }, 'Requested amount') : null,
      amount,
      after),
    memo,
    fixed ? null : Keypad((pressed) => {
      typed = pressKey(typed, pressed);
      paint();
    }),
    error,
    send);

  if (id === state.me.user.id) {
    who.textContent = state.me.user.handle;
    fault('This is your own code. Show it to whoever is paying you.');
  } else {
    api(`/api/users/${encodeURIComponent(id)}`).then((user) => {
      payee = user;
      who.textContent = user.handle;
      paint();
    }, (err) => {
      who.textContent = 'Unknown account';
      fault(err.status === 404 ? 'No account matches this code.' : err.message);
    });
  }
  paint();
  return {
    el,
    onData() {
      settle();
      paint();
    },
  };

  function fault(message) {
    error.textContent = message;
    error.hidden = false;
  }

  // Shows the receipt once. A payment can also be confirmed by a later snapshot: on a bad connection
  // the request may get through while its reply is lost.
  function settle(known) {
    const landed = known ?? state.me.tx.find((tx) => tx.key === key);
    if (paid || !landed) return;
    paid = true;
    busy = true;
    error.hidden = true;
    Receipt(landed);
  }

  function paint() {
    const { user, settings } = state.me;
    const sum = Number(typed || 0);
    const short = sum > user.balance;
    Amount(amount, sum, settings.currency);
    amount.classList.toggle('empty', !sum);
    after.classList.toggle('bad', short || user.frozen);
    after.textContent = user.frozen ? 'Your account is frozen'
      : short ? `Insufficient funds · you have ${money(user.balance, settings.currency)}`
        : `Balance after · ${money(user.balance - sum, settings.currency)}`;
    send.disabled = busy || !payee || !sum || short || user.frozen;
    send.replaceChildren(busy ? 'Sending…' : sum ? `Send ${money(sum, settings.currency)}` : 'Enter an amount');
  }

  // The same key goes with every retry of this payment, so a dropped connection can't charge twice.
  // On success `busy` stays set: the receipt covers this screen until the player leaves it.
  async function submit() {
    if (busy) return;
    busy = true;
    error.hidden = true;
    paint();
    try {
      const { tx, me } = await api('/api/transfer', { to: id, amount: Number(typed), memo: memo.value, key });
      applySnapshot(me);
      settle(tx);
    } catch (err) {
      if (paid) return;
      busy = false;
      fault(err.message);
      sfx('err');
      buzz([40, 60, 40]);
      paint();
    }
  }
}

function Receive() {
  const { user, settings } = state.me;
  const code = h('div', { class: 'qr-card' });
  const request = h('div', { class: 'stack' });
  let asked = { amount: 0, memo: '' };
  let wake = null;
  let gone = false;

  // Scanlines over the code would only make it harder to read, and the screen should not dim mid-payment.
  document.body.classList.add('plain');
  navigator.wakeLock?.request('screen').then((lock) => {
    if (gone) lock.release();
    else wake = lock;
  }, () => {});

  const el = frame('Receive',
    h('div', { class: 'qr-wrap' }, corners(), code),
    h('div', { class: 'payee-line' }, h('b', null, user.handle), h('span', { class: 'tag' }, `ID ${user.id}`)),
    request);
  paint();
  return {
    el,
    destroy() {
      gone = true;
      wake?.release();
      document.body.classList.remove('plain');
    },
  };

  function paint() {
    code.replaceChildren(qrSvg(`${location.origin}/pay/${user.id}${payQuery(asked.amount, asked.memo)}`));
    request.replaceChildren(...(asked.amount || asked.memo
      ? [
        h('div', { class: 'panel asking' },
          h('span', { class: 'label' }, 'Requesting'),
          h('div', { class: 'asking-sum' }, asked.amount ? money(asked.amount, settings.currency) : 'Any amount'),
          asked.memo && h('div', { class: 'asking-memo' }, asked.memo)),
        h('div', { class: 'pair' },
          h('button', { class: 'btn', type: 'button', onclick: () => apply({ amount: 0, memo: '' }) }, 'Clear'),
          h('button', { class: 'btn', type: 'button', onclick: edit }, 'Change')),
      ]
      : [
        h('p', { class: 'hint center' }, 'The payer scans this with their camera and chooses the amount.'),
        h('button', { class: 'btn', type: 'button', onclick: edit }, 'Request a set amount'),
      ]));
  }

  function apply(next) {
    asked = next;
    paint();
  }

  function edit() {
    let typed = asked.amount ? String(asked.amount) : '';
    const sum = h('div', { class: 'amount' });
    const note = h('input', {
      class: 'input',
      placeholder: 'What for? (optional)',
      maxLength: 60,
      value: asked.memo,
      enterKeyHint: 'done',
      'aria-label': 'What for',
    });
    const show = () => {
      Amount(sum, Number(typed || 0), settings.currency);
      sum.classList.toggle('empty', !typed);
    };
    const sheet = h('div', { class: 'overlay sheet-wrap', onclick: (event) => event.target === sheet && sheet.remove() },
      h('div', { class: 'sheet stack' },
        h('h2', null, 'Request an amount'),
        sum,
        note,
        Keypad((pressed) => {
          typed = pressKey(typed, pressed);
          show();
        }),
        h('div', { class: 'pair' },
          h('button', { class: 'btn', type: 'button', onclick: () => sheet.remove() }, 'Cancel'),
          h('button', {
            class: 'btn primary',
            type: 'button',
            onclick: () => {
              sheet.remove();
              apply({ amount: Number(typed || 0), memo: note.value.trim() });
            },
          }, 'Show code'))));
    show();
    document.body.append(sheet);
  }
}

function History() {
  const list = h('div', { class: 'tx-list' });
  const older = h('button', { class: 'btn', type: 'button', onclick: loadOlder }, 'Load older');
  let rows = state.me.tx.slice();
  let more = rows.length >= 30;
  paint();
  return {
    el: frame('Activity', list, older),
    onData() {
      const newest = rows[0]?.id ?? 0;
      rows = [...state.me.tx.filter((tx) => tx.id > newest), ...rows];
      paint();
    },
  };

  function paint() {
    list.replaceChildren(...(rows.length ? rows.map(TxRow) : [h('p', { class: 'hint' }, 'No transfers yet.')]));
    older.hidden = !more;
  }

  async function loadOlder() {
    older.disabled = true;
    try {
      const { tx } = await api(`/api/history?before=${rows[rows.length - 1].id}`);
      rows.push(...tx);
      more = tx.length >= 50;
      paint();
    } catch (err) {
      toast(err.message, 'err');
    }
    older.disabled = false;
  }
}

function Profile() {
  const { user } = state.me;
  const pinProps = { type: 'password', inputMode: 'numeric', pattern: '[0-9]*', maxLength: 8, required: true };
  const current = Field('Current PIN', { ...pinProps, autocomplete: 'current-password' });
  const next = Field(user.hasPin ? 'New PIN' : 'Choose a PIN', { ...pinProps, autocomplete: 'new-password' }, '4 to 8 digits.');
  const error = h('p', { class: 'error', role: 'alert', hidden: true });
  const save = h('button', { class: 'btn', type: 'submit' }, user.hasPin ? 'Change PIN' : 'Set PIN');
  const sound = h('button', { class: 'btn', type: 'button', onclick: toggleSound });
  labelSound();

  const el = frame('Account',
    h('section', { class: 'panel payee' },
      h('div', { class: 'split' }, h('span', { class: 'label' }, 'Logged in as'), h('span', { class: 'tag' }, `ID ${user.id}`)),
      h('div', { class: 'payee-name' }, user.handle)),
    h('div', { class: 'section-head' }, h('h2', null, 'PIN')),
    !user.hasPin && h('p', { class: 'hint' }, 'This account has no PIN yet. Set one so you can log in from another phone without your access card.'),
    h('form', {
      class: 'stack',
      onsubmit: async (event) => {
        event.preventDefault();
        error.hidden = true;
        save.disabled = true;
        try {
          applySnapshot(await api('/api/pin', { current: current.input.value, next: next.input.value }));
          toast('PIN saved.');
          render();
        } catch (err) {
          error.textContent = err.message;
          error.hidden = false;
          save.disabled = false;
        }
      },
    }, user.hasPin && current.el, next.el, error, save),
    h('div', { class: 'section-head' }, h('h2', null, 'This phone')),
    sound,
    h('button', {
      class: 'btn danger',
      type: 'button',
      onclick: async () => {
        await api('/api/logout', {}).catch(() => {});
        leave();
      },
    }, icon('out'), 'Log out'));
  return { el };

  function labelSound() {
    sound.textContent = `Sound · ${store.get('mute') === '1' ? 'off' : 'on'}`;
  }

  function toggleSound() {
    store.set('mute', store.get('mute') === '1' ? '0' : '1');
    labelSound();
    sfx('in');
  }
}

const SCREENS = { '': Home, scan: Scan, send: Send, pay: Pay, receive: Receive, history: History, me: Profile };

// ----------------------------------------------------------------- overlays

function Result({ tone, title, sum, lines, meta, button, onClose }) {
  const close = () => {
    clearTimeout(timer);
    overlay.remove();
    onClose?.();
  };
  const overlay = h('div', { class: `overlay result ${tone}`, role: 'alertdialog' },
    h('div', { class: 'result-body' },
      h('div', { class: 'result-mark' }, icon(tone === 'got' ? 'receive' : 'check', 52)),
      h('div', { class: 'result-title glitch', 'data-text': title }, title),
      h('div', { class: 'result-sum' }, sum),
      lines.filter(Boolean).map((line) => h('div', { class: 'result-line' }, line)),
      h('div', { class: 'result-meta' }, meta)),
    h('button', { class: 'btn primary big', type: 'button', onclick: close }, button));
  // Incoming notices step aside on their own so a vendor's code is ready for the next customer.
  const timer = tone === 'got' ? setTimeout(close, 9000) : null;
  document.body.append(overlay);
  return overlay;
}

function Receipt(tx) {
  sfx('out');
  buzz([20, 40, 80]);
  Result({
    tone: 'sent',
    title: 'Transfer complete',
    sum: money(tx.amount, state.me.settings.currency),
    lines: [['to ', h('b', null, tx.peer.name)], tx.memo && `“${tx.memo}”`],
    meta: `TX ${String(tx.id).padStart(6, '0')} · ${clock(tx.at)}`,
    button: 'Done',
    onClose: () => navigate('#/', true),
  });
}

let incomingOverlay = null;

function Incoming(fresh) {
  const { currency, bankName } = state.me.settings;
  const [latest] = fresh;
  const total = fresh.reduce((sum, tx) => sum + tx.amount, 0);
  sfx('in');
  buzz([30, 50, 30, 50, 120]);
  incomingOverlay?.remove();
  incomingOverlay = Result({
    tone: 'got',
    title: 'Funds received',
    sum: `+${money(total, currency)}`,
    lines: fresh.length > 1
      ? [`${fresh.length} transfers`]
      : [['from ', h('b', null, latest.peer?.name ?? bankName)], latest.memo && `“${latest.memo}”`],
    meta: `TX ${String(latest.id).padStart(6, '0')} · ${clock(latest.at)}`,
    button: 'OK',
  });
}

// --------------------------------------------------------------------- boot

async function boot() {
  const card = adoptDeepLink();
  trail.push(location.hash || '#/');
  try {
    Object.assign(state, await api('/api/boot'));
  } catch (err) {
    root.replaceChildren(h('div', { class: 'boot' },
      h('p', null, err.message),
      h('button', { class: 'btn', type: 'button', onclick: () => location.reload() }, 'Retry')));
    return;
  }
  document.title = (state.me?.settings ?? state.config).bankName;
  if (state.me) noteIncoming(state.me);
  render();
  addEventListener('hashchange', onRoute);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pollAbort?.abort();
    else wakePoll?.();
  });
  pollLoop();
  if (card) useAccessCode(card);
}

boot();

import { h, icon, api, money, toast, ask, ThemePicker, THEME_INFO } from '/ui.js';

const root = document.getElementById('gm');
let S = null; // latest hub state from the server
let refresher = null;

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const isOwner = () => Boolean(S?.me.master);

// Mirrors the server's rule, so the address preview matches what will be created.
function slugify(text) {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 32).replace(/-+$/, '');
}

async function act(path, body) {
  try {
    S = await api(path, body);
    Hub();
    return S;
  } catch (err) {
    if (err.status === 401) Login();
    else toast(err.message, 'err');
    return null;
  }
}

function Labeled(label, control, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'label' }, label), control, hint && h('small', null, hint));
}

function Toggle(label, hint, on) {
  const box = h('input', { type: 'checkbox', checked: on });
  return { box, el: h('label', { class: 'switch' }, box, h('i'), h('span', null, h('b', null, label), h('small', null, hint))) };
}

function Dialog(title, ...content) {
  const overlay = h('div', { class: 'overlay', onclick: (event) => event.target === overlay && close() },
    h('div', { class: 'panel dialog wide' },
      h('div', { class: 'split' },
        h('h2', null, title),
        h('button', { class: 'icon-btn', type: 'button', onclick: () => close(), 'aria-label': 'Close' }, icon('close'))),
      ...content));
  const close = () => overlay.remove();
  document.body.append(overlay);
  return { close };
}

function Section(title) {
  return h('div', { class: 'section-head' }, h('h2', null, title));
}

// ----------------------------------------------------------------- dialogs

function NewLobby() {
  const title = h('input', { class: 'input', maxLength: 40, required: true, placeholder: 'e.g. Night City, run 2' });
  const slug = h('input', { class: 'input', maxLength: 32, spellcheck: false, autocapitalize: 'off', placeholder: 'made from the name' });
  const preview = h('small', null);
  const source = h('select', { class: 'input' },
    h('option', { value: '' }, 'Start empty'),
    S.lobbies.map((lobby) => h('option', { value: lobby.slug }, `Copy settings from ${lobby.title}`)));
  const castBox = h('input', { type: 'checkbox' });
  const cast = h('label', { class: 'switch', hidden: true }, castBox, h('i'),
    h('span', null, h('b', null, 'Also copy the cast'), h('small', null, 'Same handles with fresh balances, PINs and access cards.')));
  const theme = ThemePicker(S.themes, 'blackwire');
  const create = h('button', { class: 'btn primary', type: 'submit' }, 'Create lobby');

  const showPreview = () => {
    preview.textContent = `Players will use ${location.origin}/${slugify(slug.value) || slugify(title.value) || '…'}`;
  };
  title.addEventListener('input', showPreview);
  slug.addEventListener('input', showPreview);
  source.addEventListener('change', () => {
    cast.hidden = !source.value;
  });
  showPreview();

  const dialog = Dialog('New lobby',
    h('form', {
      class: 'stack',
      onsubmit: async (event) => {
        event.preventDefault();
        create.disabled = true;
        const done = await act('/api/hub/lobbies', {
          title: title.value,
          slug: slug.value,
          theme: theme.value,
          copyFrom: source.value || null,
          copyCast: castBox.checked,
        });
        create.disabled = false;
        if (!done) return;
        dialog.close();
        toast(`Lobby /${done.created} created.`);
      },
    },
      Labeled('Name', title, 'For you: players see the bank name set inside the lobby.'),
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Address'), slug, preview),
      S.lobbies.length > 0 && Labeled('Start from', source),
      cast,
      h('span', { class: 'label' }, 'Theme'),
      theme.el,
      create));
  title.focus();
}

function Rename(lobby) {
  const title = h('input', { class: 'input', maxLength: 40, value: lobby.title, required: true });
  const dialog = Dialog('Rename lobby',
    h('p', { class: 'hint' }, `The address /${lobby.slug} stays the same, so printed codes keep working.`),
    h('form', {
      class: 'inline',
      onsubmit: async (event) => {
        event.preventDefault();
        if (await act(`/api/hub/lobbies/${lobby.slug}`, { do: 'rename', title: title.value })) dialog.close();
      },
    }, title, h('button', { class: 'btn primary', type: 'submit' }, 'Save')));
  title.focus();
}

function Delete(lobby) {
  const word = h('input', { class: 'input', autocomplete: 'off', spellcheck: false, autocapitalize: 'off', placeholder: lobby.slug });
  const dialog = Dialog(`Delete ${lobby.title}?`,
    h('p', { class: 'error' }, `Removes the lobby with its ${plural(lobby.accounts, 'account')} and ${plural(lobby.txCount, 'transaction')}, and logs its players out. The server keeps a copy, so the owner can restore it if needed.`),
    h('p', { class: 'hint' }, `Type ${lobby.slug} to confirm.`),
    word,
    h('button', {
      class: 'btn danger',
      type: 'button',
      onclick: async () => {
        if (await act(`/api/hub/lobbies/${lobby.slug}`, { do: 'delete', confirm: word.value.trim() })) {
          dialog.close();
          toast('Lobby deleted.');
        }
      },
    }, 'Delete lobby'));
  word.focus();
}

// Shows a freshly reset password once; it is not stored anywhere readable.
function ShowPassword(name, password) {
  Dialog(`New password for ${name}`,
    h('p', { class: 'hint' }, 'Send it to them privately. They can change it after logging in. It will not be shown again.'),
    h('p', { class: 'address' }, password));
}

// ------------------------------------------------------------------- views

function LobbyCard(lobby) {
  const secret = h('span', { class: 'mono' }, '••••••••');
  let shown = false;
  const reveal = h('button', {
    class: 'link',
    type: 'button',
    onclick: () => {
      shown = !shown;
      secret.textContent = shown ? lobby.gmPassword : '••••••••';
      reveal.textContent = shown ? 'Hide' : 'Show';
    },
  }, 'Show');
  const [themeName] = THEME_INFO[lobby.theme] ?? [lobby.theme];

  return h('section', { class: 'panel lobby' },
    h('div', { class: 'lobby-top' },
      h('span', { class: 'swatch', 'data-theme': lobby.theme, title: themeName }, h('i'), h('i'), h('i')),
      h('div', { class: 'lobby-name' },
        h('b', null, lobby.title),
        h('a', { class: 'mono', href: `/${lobby.slug}/`, target: '_blank', rel: 'noopener' }, `/${lobby.slug}`)),
      lobby.isDefault && h('span', { class: 'tag live', title: 'Links printed before lobbies existed lead here' }, 'Default')),
    h('div', { class: 'lobby-stats' },
      h('span', null, h('b', null, lobby.accounts), ' accounts'),
      h('span', null, h('b', null, lobby.online), ' online'),
      h('span', null, h('b', null, money(lobby.supply, lobby.currency)), ' in play'),
      h('span', null, h('b', null, lobby.txCount), ' transfers')),
    h('div', { class: 'lobby-meta' },
      h('span', { class: 'dim' }, [
        lobby.bankName,
        themeName,
        isOwner() && (lobby.owner ? `by ${lobby.owner}` : 'yours'),
        `created ${new Date(lobby.createdAt).toLocaleDateString()}`,
      ].filter(Boolean).join(' · ')),
      h('span', null, h('span', { class: 'label' }, 'GM password '), secret, ' ', reveal)),
    h('div', { class: 'lobby-actions' },
      h('a', { class: 'btn primary small', href: `/${lobby.slug}/admin` }, 'Open console'),
      isOwner() && !lobby.isDefault && h('button', {
        class: 'btn small',
        type: 'button',
        onclick: () => act(`/api/hub/lobbies/${lobby.slug}`, { do: 'default' }),
      }, 'Make default'),
      h('button', { class: 'btn small', type: 'button', onclick: () => Rename(lobby) }, 'Rename'),
      h('button', { class: 'btn small danger', type: 'button', onclick: () => Delete(lobby) }, 'Delete')));
}

function Organizers() {
  if (!S.organizers.length) return h('p', { class: 'hint' }, 'Nobody has registered yet.');
  const action = async (org, what) => {
    const questions = {
      reset: { title: `Reset ${org.name}'s password?`, text: 'They are logged out and get a new password from you.', confirm: 'Reset' },
      delete: {
        title: `Delete ${org.name}?`,
        text: `Their account and ${plural(org.lobbies, 'lobby')} are removed and every player in those lobbies is logged out. The server keeps a copy of the lobbies.`,
        confirm: 'Delete',
        danger: true,
      },
    };
    if (questions[what] && !await ask(questions[what])) return;
    const done = await act(`/api/hub/organizers/${org.id}`, { do: what });
    if (done?.password) ShowPassword(org.name, done.password);
  };
  return h('div', { class: 'table-wrap' },
    h('table', { class: 'grid' },
      h('thead', null, h('tr', null, ['Organizer', 'Lobbies', 'Joined', ''].map((title) => h('th', null, title)))),
      h('tbody', null, S.organizers.map((org) => h('tr', { class: org.disabled ? 'void' : '' },
        h('td', { class: 'name' }, org.name, org.disabled && h('span', { class: 'tag bad' }, 'Disabled')),
        h('td', { class: 'mono' }, org.lobbies),
        h('td', { class: 'mono dim' }, new Date(org.createdAt).toLocaleDateString()),
        h('td', { class: 'end' },
          h('button', { class: 'btn small', type: 'button', onclick: () => action(org, org.disabled ? 'enable' : 'disable') }, org.disabled ? 'Enable' : 'Disable'),
          ' ',
          h('button', { class: 'btn small', type: 'button', onclick: () => action(org, 'reset') }, 'Reset password'),
          ' ',
          h('button', { class: 'btn small danger', type: 'button', onclick: () => action(org, 'delete') }, 'Delete')))))));
}

function SignupRules() {
  const open = Toggle('Anyone can register', 'Off: no new organizer accounts. Existing ones keep working.', S.settings.signupsOpen);
  const invite = h('input', { class: 'input', maxLength: 64, value: S.settings.inviteCode, placeholder: 'None', autocomplete: 'off', spellcheck: false });
  const limit = h('input', { class: 'input', inputMode: 'numeric', value: String(S.settings.maxLobbies) });
  return h('form', {
    class: 'stack settings',
    onsubmit: async (event) => {
      event.preventDefault();
      const saved = await act('/api/hub/settings', {
        signupsOpen: open.box.checked,
        inviteCode: invite.value,
        maxLobbies: Number(limit.value.replace(/\D/g, '') || 0),
      });
      if (saved) toast('Saved.');
    },
  },
    open.el,
    h('div', { class: 'pair' },
      Labeled('Invite code', invite, 'Optional: only people you give it to can register.'),
      Labeled('Lobbies per organizer', limit, 'Your own lobbies have no limit.')),
    h('button', { class: 'btn', type: 'submit' }, 'Save'));
}

function PasswordForm() {
  const current = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', placeholder: 'Current password', 'aria-label': 'Current password' });
  const next = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'New password', 'aria-label': 'New password' });
  return h('form', {
    class: 'stack settings',
    onsubmit: async (event) => {
      event.preventDefault();
      if (await act('/api/hub/password', { current: current.value, password: next.value })) toast('Password changed.');
    },
  },
    h('div', { class: isOwner() ? '' : 'pair' }, !isOwner() && current, next),
    h('button', { class: 'btn', type: 'submit' }, 'Change password'));
}

function Hub() {
  const owner = isOwner();
  const full = !owner && S.lobbies.length >= S.limit;
  root.replaceChildren(...[
    h('header', { class: 'gm-head' },
      h('div', { class: 'gm-brand' }, owner ? 'Lobby hub' : 'My lobbies', h('small', null, owner ? 'Server owner' : S.me.name)),
      h('div', { class: 'gm-head-actions' },
        h('button', { class: 'btn primary small', type: 'button', disabled: full, onclick: NewLobby }, 'New lobby'),
        h('button', {
          class: 'btn small',
          type: 'button',
          onclick: async () => {
            await api('/api/hub/logout', {}).catch(() => {});
            Login();
          },
        }, 'Log out'))),
    h('p', { class: 'hint' }, owner
      ? 'Every lobby on this server, including those made by organizers. Each lobby is a separate game with its own address, players, money, settings, theme and GM password.'
      : `Each lobby is a separate game with its own address, players, money, settings, theme and GM password. You can have up to ${S.limit}.`),
    h('div', { class: 'lobbies' }, S.lobbies.length
      ? S.lobbies.map(LobbyCard)
      : h('p', { class: 'hint' }, 'No lobbies yet. Create one for each game you run.')),
    owner && Section('Organizers'),
    owner && h('p', { class: 'hint' }, 'People who registered to run their own games. They only ever see their own lobbies.'),
    owner && Organizers(),
    owner && Section('Registration'),
    owner && SignupRules(),
    Section(owner ? 'Master password' : 'Your password'),
    h('p', { class: 'hint' }, owner
      ? 'Opens this hub and every lobby’s console.'
      : 'Forgot it? The server owner can reset it for you.'),
    PasswordForm(),
  ].filter(Boolean));

  // The numbers on the cards (online, transfers) refresh while the page is in view, unless a dialog is open.
  clearInterval(refresher);
  refresher = setInterval(async () => {
    if (document.hidden || !S || document.querySelector('.overlay')) return;
    if (document.activeElement?.matches('input, select, textarea')) return;
    try {
      S = await api('/api/hub/state');
      Hub();
    } catch (err) {
      if (err.status === 401) Login();
    }
  }, 10_000);
}

async function Login(mode = 'login') {
  S = null;
  clearInterval(refresher);
  for (const layer of document.querySelectorAll('.overlay')) layer.remove();
  const info = await api('/api/hub/info').catch(() => ({ signupsOpen: false, needsInvite: false }));
  if (mode === 'register' && !info.signupsOpen) mode = 'login';

  const name = h('input', { class: 'input', autocomplete: 'username', autocapitalize: 'off', spellcheck: false, maxLength: 24, required: true });
  const password = h('input', {
    class: 'input',
    type: 'password',
    autocomplete: mode === 'register' ? 'new-password' : 'current-password',
    required: true,
  });
  const invite = h('input', { class: 'input', autocomplete: 'off', spellcheck: false, maxLength: 64, required: true });
  const error = h('p', { class: 'error', role: 'alert', hidden: true });
  const submit = h('button', { class: 'btn primary big', type: 'submit' },
    { login: 'Log in', register: 'Create account', owner: 'Unlock' }[mode]);
  const tab = (key, label) => h('button', { class: `tab ${mode === key ? 'on' : ''}`, type: 'button', onclick: () => Login(key) }, label);

  root.replaceChildren(h('form', {
    class: 'gm-login stack',
    onsubmit: async (event) => {
      event.preventDefault();
      error.hidden = true;
      submit.disabled = true;
      try {
        S = mode === 'register'
          ? await api('/api/hub/register', { name: name.value, password: password.value, invite: invite.value })
          : await api('/api/hub/login', { name: mode === 'owner' ? '' : name.value, password: password.value });
        Hub();
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
        submit.disabled = false;
      }
    },
  }, ...[
    h('div', { class: 'brand-mark', style: '--chars: 10' }, 'Game hub'),
    h('div', { class: 'hazard' }),
    h('p', { class: 'hint' }, 'Run your own payment game: create lobbies, hand out codes, watch the money move.'),
    mode !== 'owner' && h('div', { class: 'tabs' }, tab('login', 'Log in'), info.signupsOpen && tab('register', 'Register')),
    mode !== 'owner' && Labeled('Name', name, mode === 'register' && '3 to 24 characters. Shown only to the server owner.'),
    Labeled(mode === 'owner' ? 'Master password' : 'Password', password,
      mode === 'register' ? 'At least 6 characters. There is no e-mail reset: if you forget it, ask the server owner.'
        : mode === 'owner' ? 'Printed in the terminal window where the server was started.' : null),
    mode === 'register' && info.needsInvite && Labeled('Invite code', invite, 'Given out by the server owner.'),
    error,
    submit,
    mode === 'login' && !info.signupsOpen && h('p', { class: 'hint' }, 'Registration is closed. Ask the server owner for an account.'),
    h('button', { class: 'link', type: 'button', onclick: () => Login(mode === 'owner' ? 'login' : 'owner') },
      mode === 'owner' ? 'Organizer login' : 'Server owner'),
  ].filter(Boolean)));
  (mode === 'owner' ? password : name).focus();
}

async function boot() {
  try {
    S = await api('/api/hub/state');
    Hub();
  } catch (err) {
    if (err.status === 401) return Login();
    root.replaceChildren(h('div', { class: 'boot' },
      h('p', null, err.message),
      h('button', { class: 'btn', type: 'button', onclick: () => location.reload() }, 'Retry')));
  }
}

boot();

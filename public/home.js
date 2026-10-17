import { h, api, recentLobbies, forgetLobby } from '/ui.js';

// The front door at "/": players type their game's code (or come back to one they opened before),
// and people who want to host find the way to the game hub.

const root = document.getElementById('app');

// The same rule the server uses for lobby addresses, so "Night City" finds /night-city.
function slugify(text) {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 32).replace(/-+$/, '');
}

// Accepts a code, a name, or a whole pasted link such as https://credits.example/night-city/pay/K7Q2.
function codeFrom(text) {
  const raw = text.trim();
  try {
    return slugify(new URL(raw).pathname.split('/')[1] ?? '');
  } catch {
    return slugify(raw.replace(/^\/+/, '').split('/')[0]);
  }
}

function Home() {
  const missing = new URLSearchParams(location.search).get('missing');
  if (missing) {
    forgetLobby(missing);
    history.replaceState(null, '', '/');
  }

  const code = h('input', {
    class: 'input',
    placeholder: 'e.g. night-city',
    autocapitalize: 'off',
    autocomplete: 'off',
    spellcheck: false,
    maxLength: 200,
    required: true,
    'aria-label': 'Game code',
  });
  const error = h('p', { class: 'error', role: 'alert', hidden: !missing },
    missing ? `There is no game called “${missing}” here. Check the code with your game master.` : '');
  const go = h('button', { class: 'btn primary big', type: 'submit' }, 'Enter game');

  const enter = async (slug) => {
    error.hidden = true;
    if (!slug) {
      error.textContent = 'Type the game code your game master gave you.';
      error.hidden = false;
      return;
    }
    go.disabled = true;
    try {
      await api(`/${slug}/api/boot`);
      location.href = `/${slug}/`;
    } catch (err) {
      go.disabled = false;
      if (err.status === 404) {
        forgetLobby(slug);
        error.textContent = `There is no game called “${slug}” here. Check the code with your game master.`;
        paintRecent();
      } else {
        error.textContent = err.message;
      }
      error.hidden = false;
    }
  };

  const recent = h('div', { class: 'stack' });
  const paintRecent = () => {
    const list = recentLobbies();
    recent.replaceChildren(...(list.length
      ? [
        h('div', { class: 'section-head' }, h('h2', null, 'On this phone')),
        h('div', { class: 'people' }, list.map(({ slug, name }) => h('a', { class: 'person', href: `/${slug}/` },
          h('span', { class: 'avatar' }, Array.from(name || slug)[0].toUpperCase()),
          h('span', { class: 'person-name' }, name || slug),
          h('span', { class: 'tag' }, slug)))),
      ]
      : []));
  };
  paintRecent();

  root.replaceChildren(h('div', { class: 'screen auth' },
    h('div', { class: 'brand' },
      h('div', { class: 'brand-mark glitch', 'data-text': 'Credits', style: '--chars: 7' }, 'Credits'),
      h('div', { class: 'brand-tag' }, 'Phone money for role-play.')),
    h('div', { class: 'hazard' }),
    h('a', { class: 'host-link', href: '/admin' }, 'Run your own role-play? ', h('b', null, 'Make a credits lobby')),
    h('form', {
      class: 'stack',
      onsubmit: (event) => {
        event.preventDefault();
        enter(codeFrom(code.value));
      },
    },
      h('label', { class: 'field' },
        h('span', { class: 'label' }, 'Game code'),
        code,
        h('small', null, 'Your game master gives you this. Scanning their join code with your camera takes you straight in.')),
      error,
      go),
    recent));
  if (!recentLobbies().length) code.focus();
}

Home();

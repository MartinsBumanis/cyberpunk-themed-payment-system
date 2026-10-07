// DOM, network and formatting helpers shared by the player app and the GM console.
import qrcode from '/vendor/qrcode.mjs';

const SVG_NS = 'http://www.w3.org/2000/svg';

// Strings passed as children become text nodes, never markup, so player-chosen names and memos can't inject HTML.
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key in el) el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  el.append(...children.flat(Infinity).filter((child) => child != null && child !== false));
  return el;
}

const ICONS = {
  scan: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5M7 12h10"/>',
  send: '<path d="M6 18 18 6M9 6h9v9"/>',
  receive: '<path d="M18 6 6 18M15 18H6V9"/>',
  back: '<path d="M14 5l-7 7 7 7"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="M4 12.5 9.5 18 20 7"/>',
  user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20v-1.5c0-2.3 3-3.5 7-3.5s7 1.2 7 3.5V20"/>',
  del: '<path d="M9 6h11v12H9l-5-6zM12.5 9.5l4 5M16.5 9.5l-4 5"/>',
  flash: '<path d="M13 3 6 13h5l-1 8 7-10h-5z"/>',
  camera: '<path d="M4 8h3.5L9 6h6l1.5 2H20v11H4z"/><circle cx="12" cy="13" r="3"/>',
  out: '<path d="M10 4H5v16h5M14 8l4 4-4 4M18 12H9"/>',
};

export function icon(name, size = 22) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  const attrs = {
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 2,
    'stroke-linecap': 'square',
    'aria-hidden': 'true',
  };
  for (const [key, value] of Object.entries(attrs)) svg.setAttribute(key, value);
  svg.innerHTML = ICONS[name];
  return svg;
}

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// GET when `body` is undefined, otherwise a JSON POST. Status 0 means the server could not be reached.
export async function api(path, body, { signal } = {}) {
  const init = body === undefined
    ? { signal }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal };
  let res;
  try {
    res = await fetch(path, init);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK', 'No link to the grid. Check your connection and try again.');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, data?.error?.code ?? 'ERROR', data?.error?.message ?? `Request failed (${res.status}).`);
  }
  return data;
}

export const digits = (amount) => Math.abs(amount).toLocaleString('en-US');

export function money(amount, symbol) {
  return `${amount < 0 ? '−' : ''}${symbol}${digits(amount)}`;
}

export function clock(at) {
  const date = new Date(at);
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${date.toLocaleDateString([], { day: '2-digit', month: 'short' })} ${time}`;
}

// Black on white with a quiet zone, whatever the page theme: scanners need the contrast.
export function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  let path = '';
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (!qr.isDark(row, col)) continue;
      let run = 1;
      while (col + run < size && qr.isDark(row, col + run)) run++;
      path += `M${col} ${row}h${run}v1h-${run}z`;
      col += run - 1;
    }
  }
  const quiet = 4;
  const full = size + quiet * 2;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `${-quiet} ${-quiet} ${full} ${full}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'QR code');
  svg.setAttribute('class', 'qr');
  svg.innerHTML = `<rect x="${-quiet}" y="${-quiet}" width="${full}" height="${full}" fill="#fff"/><path d="${path}" fill="#000"/>`;
  return svg;
}

let toastBox = null;

export function toast(text, kind = 'info') {
  toastBox ??= document.body.appendChild(h('div', { class: 'toasts', role: 'status' }));
  const el = h('div', { class: `toast ${kind}` }, text);
  toastBox.append(el);
  setTimeout(() => el.remove(), 3600);
}

// In-page confirmation. Resolves true only when the confirm button is pressed.
export function ask({ title, text, confirm = 'Confirm', cancel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const close = (answer) => {
      overlay.remove();
      resolve(answer);
    };
    const overlay = h('div', { class: 'overlay', onclick: (event) => event.target === overlay && close(false) },
      h('div', { class: 'panel dialog', role: 'alertdialog' },
        h('h2', null, title),
        text && h('p', null, text),
        h('div', { class: 'pair' },
          h('button', { class: 'btn', onclick: () => close(false) }, cancel),
          h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => close(true) }, confirm))));
    document.body.append(overlay);
  });
}

// localStorage can be blocked (private mode, strict settings); fall back to memory so the app still works.
const memory = new Map();

export const store = {
  get(key) {
    try {
      return localStorage.getItem(key) ?? memory.get(key) ?? null;
    } catch {
      return memory.get(key) ?? null;
    }
  },
  set(key, value) {
    memory.set(key, value);
    try {
      localStorage.setItem(key, value);
    } catch {
      // kept in memory only
    }
  },
};

const TONES = {
  in: [[784, 0], [1175, 0.08], [1568, 0.16]],
  out: [[880, 0], [587, 0.1]],
  err: [[150, 0], [110, 0.14]],
};

let audio = null;

function audioContext() {
  const Ctor = window.AudioContext ?? window.webkitAudioContext;
  if (!audio && Ctor) audio = new Ctor();
  if (audio?.state === 'suspended') audio.resume().catch(() => {});
  return audio;
}

export function sfx(kind) {
  if (store.get('mute') === '1') return;
  try {
    const ctx = audioContext();
    if (!ctx) return;
    for (const [frequency, delay] of TONES[kind]) {
      const start = ctx.currentTime + delay;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.1, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.17);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.18);
    }
  } catch {
    // no audio on this device: stay silent
  }
}

// Browsers only let sound start from a tap. Unlocking on the first one lets later incoming-payment chimes play.
addEventListener('pointerdown', () => {
  try {
    audioContext();
  } catch {
    // no audio on this device
  }
}, { once: true });

export function buzz(pattern) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // no vibration on this device
  }
}

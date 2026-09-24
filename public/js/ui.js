/* ==========================================================================
   ui.js — DOM-хелперы, тосты, модалки, конфетти, SVG-элементы
   ========================================================================== */

/** Мини-hyperscript: h('div.card#id', {onClick, style}, 'текст', [элементы]) */
function h(tag, attrs, ...kids) {
  let tagName = 'div';
  const classes = [];
  let id = null;

  const m = String(tag || 'div').match(/^([a-zA-Z0-9-]*)((?:[.#][^.#]*)*)$/);
  if (m) {
    tagName = m[1] || 'div';
    if (m[2]) {
      m[2].split(/(?=[.#])/).forEach((part) => {
        if (part.startsWith('.')) classes.push(part.slice(1));
        else if (part.startsWith('#')) id = part.slice(1);
      });
    }
  }

  const el = document.createElement(tagName);
  if (classes.length) el.className = classes.join(' ');
  if (id) el.id = id;

  if (attrs && typeof attrs === 'object' && !(attrs instanceof Node) && !Array.isArray(attrs)) {
    Object.entries(attrs).forEach(([k, v]) => {
      if (v == null || v === false) return;
      if (k === 'class' || k === 'className') el.className = `${el.className} ${v}`.trim();
      if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'selected') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    });
  } else if (attrs != null) {
    kids.unshift(attrs);
  }

  append(el, kids);
  return el;
}

function append(el, kids) {
  kids.forEach((kid) => {
    if (kid == null || kid === false || kid === '') return;
    if (Array.isArray(kid)) return append(el, kid);
    if (kid instanceof Node) return el.appendChild(kid);
    el.appendChild(document.createTextNode(String(kid)));
  });
}

function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
function mount(node, ...kids) { clear(node); append(node, kids); return node; }

/* ------------------------------------------------------------------- toast */

const _recentToasts = new Map();

function toast(text, type = '') {
  const key = `${type}|${text}`;
  const now = Date.now();
  // не показываем одинаковые сообщения подряд
  if (_recentToasts.has(key) && now - _recentToasts.get(key) < 5000) return;
  _recentToasts.set(key, now);
  if (_recentToasts.size > 40) _recentToasts.clear();

  const host = document.getElementById('toast-host');
  const el = h(`div.toast${type ? `.${type}` : ''}`, text);
  host.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s, transform .25s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(10px)';
    setTimeout(() => el.remove(), 260);
  }, type === 'err' ? 6000 : 3200);
}

/* ------------------------------------------------------------------- modal */

/** Закрыть любую открытую модалку (например, при переходе на другой экран). */
function closeModal() {
  const host = document.getElementById('modal-host');
  if (!host) return;
  host.hidden = true;
  clear(host);
  host.onclick = null;
}


function modal({ title, body, actions = [], wide = false, onClose = null }) {
  const host = document.getElementById('modal-host');
  host.hidden = false;

  const close = () => {
    host.hidden = true;
    clear(host);
    if (onClose) onClose();
  };

  const card = h('div.modal.fade-in', { style: wide ? { width: 'min(880px, 100%)' } : null },
    h('div.modal-head',
      h('h3', title || ''),
      h('button.icon-btn', { onClick: close, title: 'Закрыть' }, '✕')),
    h('div.modal-body', typeof body === 'function' ? body(close) : body),
    actions.length
      ? h('div.btn-row', { style: { marginTop: '16px', justifyContent: 'flex-end' } },
        actions.map((a) => h(`button.btn${a.style ? `.${a.style}` : ''}${a.small ? '.sm' : ''}`, {
          onClick: () => a.onClick ? a.onClick(close) : close(),
        }, a.label)))
      : null);

  host.onclick = (e) => { if (e.target === host) close(); };
  mount(host, card);
  return { close, card };
}

function confirmDialog(title, text, confirmLabel = 'Да', danger = false) {
  return new Promise((resolve) => {
    const m = modal({
      title,
      body: h('p.muted', text),
      actions: [
        { label: 'Отмена', style: 'ghost', onClick: (close) => { close(); resolve(false); } },
        { label: confirmLabel, style: danger ? 'red' : '', onClick: (close) => { close(); resolve(true); } },
      ],
      onClose: () => resolve(false),
    });
    return m;
  });
}

/* ---------------------------------------------------------------- confetti */

function confetti(count = 40) {
  const host = document.getElementById('confetti-host');
  const colors = ['#58cc02', '#1cb0f6', '#ffc800', '#ff9600', '#ce82ff', '#ff4b4b'];
  for (let i = 0; i < count; i += 1) {
    const el = h('i');
    el.style.left = `${Math.random() * 100}%`;
    el.style.top = `${-10 - Math.random() * 20}%`;
    el.style.background = colors[i % colors.length];
    el.style.animationDelay = `${Math.random() * 0.5}s`;
    el.style.animationDuration = `${1.6 + Math.random()}s`;
    host.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }
}

/* --------------------------------------------------------------- svg pieces */

/** Зубчатый круг (стиль Duolingo) — используется под текущим узлом. */
function zigzag(size, fill, rings = 18, inner = 0.87) {
  const c = size / 2;
  const pts = [];
  for (let i = 0; i < rings * 2; i += 1) {
    const a = (Math.PI * 2 * i) / (rings * 2) - Math.PI / 2;
    const r = (i % 2 === 0 ? 1 : inner) * c;
    pts.push(`${(c + r * Math.cos(a)).toFixed(2)},${(c + r * Math.sin(a)).toFixed(2)}`);
  }
  return `<svg viewBox="0 0 ${size} ${size}" width="100%" height="100%"><polygon points="${pts.join(' ')}" fill="${fill}"/></svg>`;
}

function ring(pct, { size = 92, stroke = 9, color = '#58cc02', track = '#3c4d55', label = null } = {}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const val = Math.max(0, Math.min(1, pct || 0));
  const wrap = h('div.ring', { style: { width: `${size}px`, height: `${size}px` } });
  wrap.innerHTML = `
    <svg width="${size}" height="${size}">
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${track}" stroke-width="${stroke}" />
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}"
        stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - val)}" />
    </svg>`;
  wrap.appendChild(h('div.ring-label', label != null ? label : `${Math.round(val * 100)}%`));
  return wrap;
}

function stars(n, total = 3) {
  const wrap = h('span', { style: { letterSpacing: '1px' } });
  for (let i = 0; i < total; i += 1) {
    wrap.appendChild(h('span', { style: { color: i < n ? '#ffc800' : '#4a5f69' } }, '★'));
  }
  return wrap;
}

function pbar(value, { thin = false, color = '' } = {}) {
  return h(`div.pbar${thin ? '.thin' : ''}`,
    h(`i${color ? `.${color}` : ''}`, { style: { width: `${Math.round(Math.max(0, Math.min(1, value || 0)) * 100)}%` } }));
}

const MASCOTS = ['🐸', '🐼', '🦉', '🦊', '🐧', '🐨'];

function mascot(i = 0) {
  return h('div.mascot', MASCOTS[i % MASCOTS.length]);
}

/* ------------------------------------------------------------------ прочее */

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch { return '—'; }
}

function fmtMinutes(min) {
  const m = Math.round(min || 0);
  if (m < 60) return `${m} мин`;
  const hh = Math.floor(m / 60);
  return `${hh} ч ${m % 60} мин`;
}

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

const LEVEL_TITLES = ['Новичок', 'Ученик', 'Практик', 'Знаток', 'Уверенный', 'Мастер', 'Эксперт'];

/** Экран загрузки с бегущими подсказками. */
function loader(text, steps = []) {
  const wrap = h('div.loader-screen.fade-in',
    h('div', h('div', { style: { fontSize: '56px' } }, '🧠')),
    h('div.spin.dark', { style: { width: '26px', height: '26px', borderWidth: '4px' } }),
    h('h2', text),
    steps.length ? h('div.muted.small', { id: 'loader-step' }, steps[0]) : null);
  let i = 0;
  const timer = setInterval(() => {
    const el = wrap.querySelector('#loader-step');
    if (!el) return clearInterval(timer);
    i = (i + 1) % steps.length;
    el.textContent = steps[i];
  }, 2400);
  wrap._stop = () => clearInterval(timer);
  setTimeout(() => clearInterval(timer), 180000);
  return wrap;
}

function statCard(value, label, color = '') {
  return h('div.card.stat', { style: color ? { borderColor: color } : null },
    h('div.v', { style: color ? { color } : null }, value),
    h('div.k', label));
}

// Shared helpers for the dashboard and the viewer: DOM builder, icons, toasts, dialogs, menus,
// the JSON API wrapper and the instance-management calls (some of which the relay may not
// implement yet: those answer 404 "not found" / 501 and get a friendly "coming soon" toast).

export const $ = (id) => document.getElementById(id);

export function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
export function storageSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
}

/** el('div', { class: 'x', onclick }, ...children). Strings are always inserted as text. */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style' && typeof v === 'object') for (const [p, val] of Object.entries(v)) {
      if (p.startsWith('--')) node.style.setProperty(p, val);
      else node.style[p] = val;
    }
    else if (k in node && typeof v !== 'string' && k !== 'list') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

// ---------------------------------------------------------------- icons

const ICONS = {
  phone: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10.5 18.5h3"/>',
  pc: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m10.9 12.1 8.6-8.6M16 7l2.5 2.5M14 9l2 2"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6"/>',
  shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6z"/><path d="m9 12 2 2 4-4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  play: '<path d="M7 4.5v15l12.5-7.5z"/>',
  power: '<path d="M12 3v8"/><path d="M6.4 6.6a8 8 0 1 0 11.2 0"/>',
  more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
  restart: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 4v4.5H8"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  upload: '<path d="M12 15V4M7 9l5-5 5 5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  apk: '<path d="M7 10h10v8a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2z"/><path d="M7 10a5 5 0 0 1 10 0M9.5 5.5 8 3.5M14.5 5.5 16 3.5"/><path d="M12 13v4M10.5 15.5 12 17l1.5-1.5"/>',
  apps: '<rect x="4" y="4" width="6" height="6" rx="1.5"/><rect x="14" y="4" width="6" height="6" rx="1.5"/><rect x="4" y="14" width="6" height="6" rx="1.5"/><rect x="14" y="14" width="6" height="6" rx="1.5"/>',
  back: '<path d="M16 5 7 12l9 7z"/>',
  home: '<circle cx="12" cy="12" r="7"/>',
  recent: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  volDown: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M17 12h4"/>',
  volUp: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M17 12h4M19 10v4"/>',
  rotate: '<rect x="4" y="9" width="11" height="11" rx="2"/><path d="M13 3.5a7 7 0 0 1 7 7"/><path d="m17.5 8.5 2.5 2 2-2.5"/>',
  keyboard: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  clipboard: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1M9 10h6M9 14h4"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  fullscreen: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  exitFullscreen: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
  stats: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  chevronLeft: '<path d="m15 5-7 7 7 7"/>',
  chevronRight: '<path d="m9 5 7 7-7 7"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8"/><path d="M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16"/><path d="M20 20v-4h-4"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  alert: '<path d="M12 3 2.5 20h19z"/><path d="M12 10v4M12 17h.01"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5"/><path d="M4 18v1a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  select: '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  signal: '<path d="M4 20v-3M9 20v-7M14 20V9M19 20V4"/>',
  sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
};

export function icon(name, cls = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', `i ${cls}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name] ?? '';
  return svg;
}

/** Replaces every <i data-icon="name"> placeholder in static HTML with the SVG icon. */
export function hydrateIcons(root = document) {
  for (const ph of root.querySelectorAll('i[data-icon]')) ph.replaceWith(icon(ph.dataset.icon, ph.className));
}

// ---------------------------------------------------------------- toasts

let toastBox = null;
export function toast(text, kind = 'info', ms = 2800) {
  if (!toastBox) toastBox = el('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
  // A modal <dialog> sits in the top layer; host the toasts inside it so they stay visible.
  const host = [...document.querySelectorAll('dialog[open]')].pop() ?? document.body;
  if (toastBox.parentNode !== host) host.append(toastBox);
  const ico = kind === 'ok' ? 'check' : kind === 'error' ? 'alert' : 'info';
  const t = el('div', { class: `toast ${kind}` }, icon(ico), el('span', {}, text));
  toastBox.append(t);
  while (toastBox.children.length > 3) toastBox.firstChild.remove();
  setTimeout(() => t.remove(), ms);
}

export const SOON = 'Tính năng đang phát triển';

// ---------------------------------------------------------------- API

export class ApiError extends Error {
  constructor(status, message, { unbuilt = false } = {}) {
    super(message);
    this.status = status;
    this.unbuilt = unbuilt;
  }
}

let onUnauthorized = () => { location.href = './'; };
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

/**
 * JSON API call. Throws ApiError; `unbuilt` is true when the relay has no such route yet
 * (generic 404 "not found" or 501). With `quiet` false (default) errors are also toasted.
 */
export async function api(method, url, body, { quiet = false } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    if (!quiet) toast('Không kết nối được server.', 'error');
    throw new ApiError(0, 'network');
  }
  if (res.status === 401 && !url.startsWith('/api/login')) {
    onUnauthorized();
    throw new ApiError(401, 'unauthorized');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const unbuilt = res.status === 501 || (res.status === 404 && (data.error === 'not found' || !data.error));
    const message = unbuilt ? SOON : data.error ?? `Lỗi HTTP ${res.status}`;
    if (!quiet) toast(message, unbuilt ? 'info' : 'error', 4000);
    throw new ApiError(res.status, message, { unbuilt });
  }
  return data;
}

export function fmtTime(ms) {
  if (!ms) return 'chưa';
  const diff = Date.now() - ms;
  if (diff < 60e3) return 'vừa xong';
  if (diff < 3600e3) return `${Math.floor(diff / 60e3)} phút trước`;
  if (diff < 86400e3) return `${Math.floor(diff / 3600e3)} giờ trước`;
  return new Date(ms).toLocaleDateString('vi-VN');
}

// ---------------------------------------------------------------- devices / instances

/** 'live' (streamable), 'noadb' (running, ADB off) or 'off'. */
export function deviceState(d) {
  if (d.id && d.adb) return 'live';
  if (d.running) return 'noadb';
  return 'off';
}
export const STATE_LABEL = { live: 'Đang chạy', noadb: 'Chưa bật ADB', off: 'Đã tắt' };
export const STATE_CHIP = { live: 'ok', noadb: 'warn', off: '' };
export const deviceKey = (d) => `${d.machine}:${d.index ?? d.id ?? d.name}`;
export const isInstance = (d) => d.machine != null && d.index !== null && d.index !== undefined;
export const instPath = (d) => `/api/machines/${d.machine}/instances/${d.index}`;
export const viewerUrl = (d) => `viewer.html?device=${encodeURIComponent(d.id)}${isInstance(d) ? `&m=${d.machine}&i=${d.index}` : ''}`;

const ACTION_LABEL = { launch: 'Đang bật', quit: 'Đang tắt', reboot: 'Đang khởi động lại' };
export async function instanceAction(d, action, { quiet = false } = {}) {
  await api('POST', `${instPath(d)}/${action}`, undefined, { quiet });
  if (!quiet) toast(`${ACTION_LABEL[action] ?? action} "${d.name}"…`, 'ok');
}

let screenshotsUnavailableUntil = 0;
/** Object URL of a fresh JPEG screenshot, or null (also when the relay has no such route yet). */
export async function fetchScreenshot(d) {
  if (!isInstance(d) || Date.now() < screenshotsUnavailableUntil) return null;
  try {
    const res = await fetch(`${instPath(d)}/screenshot`, { cache: 'no-store' });
    const type = res.headers.get('Content-Type') ?? '';
    if (res.status === 404 || res.status === 501) {
      if (!type.startsWith('image/')) screenshotsUnavailableUntil = Date.now() + 5 * 60e3;
      return null;
    }
    if (!res.ok || !type.startsWith('image/')) return null;
    return URL.createObjectURL(await res.blob());
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- dialogs

/**
 * Opens a modal <dialog>. `actions`: [{ label, value, kind, icon, submit }]. Resolves with the
 * clicked action's value (or `onSubmit`'s return value), null when dismissed.
 */
export function modal({ title, text, iconName, danger = false, body = [], actions = [], onSubmit, onOpen, wide = false }) {
  return new Promise((resolve) => {
    const form = el('form', { method: 'dialog' });
    const dlg = el('dialog', { class: 'modal', 'aria-label': title, style: wide ? { width: 'min(560px, calc(100vw - 24px))' } : undefined }, form);
    let result = null;
    const close = (v) => {
      result = v;
      dlg.close();
    };
    // Native append() would turn a null part into the text "null"; drop the missing parts.
    const parts = [
      el(
        'div',
        { class: 'modal-head' },
        iconName && el('div', { class: `modal-icon${danger ? ' danger' : ''}` }, icon(iconName)),
        el('div', { style: { flex: '1', minWidth: '0' } }, el('h3', {}, title), text && el('p', {}, text)),
        el('button', { type: 'button', class: 'btn ghost icon sm', 'aria-label': 'Đóng', onclick: () => close(null) }, icon('x')),
      ),
      body.length ? el('div', { class: 'modal-body' }, body) : null,
      actions.length
        ? el(
            'div',
            { class: 'modal-foot' },
            actions.map((a) =>
              el(
                'button',
                {
                  type: a.submit ? 'submit' : 'button',
                  class: `btn ${a.kind ?? ''}`,
                  onclick: a.submit ? undefined : () => close(a.value),
                  dataset: a.id ? { id: a.id } : undefined,
                },
                a.icon && icon(a.icon),
                a.label,
              ),
            ),
          )
        : null,
    ];
    form.append(...parts.filter(Boolean));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!onSubmit) return close(true);
      const btn = form.querySelector('button[type=submit]');
      if (btn) btn.disabled = true;
      try {
        const v = await onSubmit(form);
        if (v !== undefined) close(v);
      } finally {
        if (btn) btn.disabled = false;
      }
    });
    dlg.addEventListener('close', () => {
      dlg.remove();
      resolve(result);
    });
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) close(null); // backdrop
    });
    document.body.append(dlg);
    dlg.showModal();
    onOpen?.(dlg, close);
    const first = dlg.querySelector('input:not([type=hidden]), select, textarea');
    if (first) first.focus();
  });
}

export function confirmDialog({ title, text, confirm = 'Đồng ý', danger = false, iconName }) {
  return modal({
    title,
    text,
    danger,
    iconName: iconName ?? (danger ? 'alert' : 'info'),
    actions: [
      { label: 'Huỷ', value: false, kind: 'ghost' },
      { label: confirm, value: true, kind: danger ? 'danger solid' : 'primary' },
    ],
  }).then(Boolean);
}

export function promptDialog({ title, text, label, value = '', placeholder = '', confirm = 'Lưu', iconName = 'edit', type = 'text', minLength, maxLength = 60 }) {
  const input = el('input', { class: 'input', type, value, placeholder, required: true, maxlength: String(maxLength), minlength: minLength ? String(minLength) : undefined, autocomplete: type === 'password' ? 'new-password' : 'off' });
  return modal({
    title,
    text,
    iconName,
    body: [el('label', { class: 'field' }, el('span', {}, label), input)],
    actions: [
      { label: 'Huỷ', value: null, kind: 'ghost' },
      { label: confirm, kind: 'primary', submit: true },
    ],
    onSubmit: () => input.value.trim(),
  });
}

// ---------------------------------------------------------------- popup menu

let closeOpenMenu = null;
/**
 * Pop-up menu next to `anchor` (bottom sheet on narrow screens).
 * items: [{ label, icon, onClick, danger, disabled, hint } | '-' | { title }]
 */
export function openMenu(anchor, items, { sheetTitle } = {}) {
  closeOpenMenu?.();
  const narrow = window.matchMedia('(max-width: 600px)').matches;
  const scrim = el('div', { class: `menu-scrim${narrow ? ' sheet' : ''}` });
  const menu = el('div', { class: `menu${narrow ? ' sheet' : ''}`, role: 'menu' });
  if (narrow && sheetTitle) menu.append(el('div', { class: 'menu-title' }, sheetTitle));
  for (const it of items) {
    if (!it) continue;
    if (it === '-') menu.append(el('hr'));
    else if (it.title) menu.append(el('div', { class: 'menu-title' }, it.title));
    else
      menu.append(
        el(
          'button',
          {
            type: 'button',
            role: 'menuitem',
            class: it.danger ? 'danger' : '',
            disabled: it.disabled || undefined,
            onclick: () => {
              close();
              it.onClick?.();
            },
          },
          it.icon && icon(it.icon),
          el('span', {}, it.label),
          it.hint && el('span', { class: 'hint' }, it.hint),
        ),
      );
  }
  const onKey = (e) => {
    const buttons = [...menu.querySelectorAll('button:not(:disabled)')];
    const i = buttons.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      buttons[(i + 1) % buttons.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      buttons[(i - 1 + buttons.length) % buttons.length]?.focus();
    } else if (e.key === 'Tab') {
      close();
    }
  };
  function close() {
    scrim.remove();
    menu.remove();
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', close);
    closeOpenMenu = null;
    anchor?.setAttribute?.('aria-expanded', 'false');
    if (document.activeElement === document.body || !document.activeElement) anchor?.focus?.({ preventScroll: true });
  }
  scrim.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    close();
  });
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', close);
  document.body.append(scrim, menu);
  anchor?.setAttribute?.('aria-expanded', 'true');
  if (!narrow) {
    const r = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    let left = r.right - mw;
    if (left < 8) left = Math.min(r.left, window.innerWidth - mw - 8);
    let top = r.bottom + 6;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
    menu.style.left = `${Math.max(8, left)}px`;
    menu.style.top = `${top}px`;
  }
  menu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
  closeOpenMenu = close;
  return close;
}

// ---------------------------------------------------------------- APK install

const JOB_LABEL = {
  uploading: 'Đang tải lên server',
  downloading: 'Đang chuyển tới PC',
  installing: 'Đang cài đặt',
  done: 'Đã cài xong',
  error: 'Lỗi',
};

/** Upload dialog with drag & drop, upload progress, then job polling. */
export function openApkDialog(d) {
  if (!isInstance(d)) return toast('Máy này không hỗ trợ cài APK từ web.', 'error');
  const fileInput = el('input', { type: 'file', accept: '.apk,application/vnd.android.package-archive', hidden: true });
  const zoneText = el('strong', {}, 'Chọn file .apk');
  const zone = el(
    'div',
    { class: 'dropzone', tabindex: '0', role: 'button', 'aria-label': 'Chọn file APK' },
    icon('upload'),
    zoneText,
    el('div', {}, 'hoặc kéo thả vào đây'),
  );
  const bar = el('div', {});
  const progress = el('div', { class: 'progress', hidden: true }, bar);
  const status = el('div', { class: 'muted', 'aria-live': 'polite' });
  let file = null;
  let busy = false;

  const pick = (f) => {
    if (!f) return;
    if (!/\.apk$/i.test(f.name)) return toast('Chỉ nhận file .apk', 'error');
    file = f;
    zoneText.textContent = `${f.name} · ${(f.size / 1048576).toFixed(1)} MB`;
  };
  zone.addEventListener('click', () => !busy && fileInput.click());
  zone.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && !busy) {
      e.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener('change', () => pick(fileInput.files[0]));
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    pick(e.dataTransfer.files[0]);
  });

  const setProgress = (p, text) => {
    progress.hidden = false;
    progress.classList.toggle('indeterminate', p === null);
    bar.style.width = p === null ? '' : `${Math.round(p * 100)}%`;
    status.textContent = text;
  };

  const upload = () =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${instPath(d)}/apk`);
      xhr.setRequestHeader('Content-Type', 'application/vnd.android.package-archive');
      xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) setProgress(e.loaded / e.total, `Đang tải lên… ${Math.round((e.loaded / e.total) * 100)}%`);
      };
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
        if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
        const unbuilt = xhr.status === 501 || (xhr.status === 404 && (!data.error || data.error === 'not found'));
        reject(new ApiError(xhr.status, unbuilt ? SOON : data.error ?? `Lỗi HTTP ${xhr.status}`, { unbuilt }));
      };
      xhr.onerror = () => reject(new ApiError(0, 'Mất kết nối khi tải lên.'));
      xhr.send(file);
    });

  return modal({
    title: 'Cài ứng dụng (APK)',
    text: `Cài lên "${d.name}"${d.agent ? ` · ${d.agent}` : ''}`,
    iconName: 'apk',
    body: [zone, fileInput, progress, status],
    actions: [
      { label: 'Đóng', value: null, kind: 'ghost' },
      { label: 'Cài đặt', kind: 'primary', submit: true, icon: 'upload' },
    ],
    onSubmit: async (form) => {
      if (busy) return undefined;
      if (!file) {
        toast('Hãy chọn file .apk trước.', 'error');
        return undefined;
      }
      busy = true;
      const submitBtn = form.querySelector('button[type=submit]');
      try {
        setProgress(0, 'Đang tải lên… 0%');
        const { job } = await upload();
        if (!job) {
          setProgress(1, JOB_LABEL.done);
          toast('Đã gửi file APK.', 'ok');
          return undefined;
        }
        for (;;) {
          await new Promise((r) => setTimeout(r, 1000));
          if (!form.isConnected) return undefined;
          const j = await api('GET', `/api/jobs/${encodeURIComponent(job)}`, undefined, { quiet: true });
          const label = JOB_LABEL[j.state] ?? j.state;
          const p = typeof j.progress === 'number' ? j.progress : null;
          setProgress(j.state === 'done' ? 1 : p, `${label}${j.message ? ` · ${j.message}` : ''}${p !== null && j.state !== 'done' ? ` · ${Math.round(p * 100)}%` : ''}`);
          if (j.state === 'done') {
            toast(`Đã cài ${file.name}`, 'ok');
            submitBtn.textContent = 'Cài file khác';
            file = null;
            zoneText.textContent = 'Chọn file .apk';
            return undefined;
          }
          if (j.state === 'error') throw new ApiError(500, j.message || 'Cài đặt thất bại');
        }
      } catch (err) {
        progress.hidden = true;
        status.textContent = '';
        toast(err.message, err.unbuilt ? 'info' : 'error', 4000);
        return undefined;
      } finally {
        busy = false;
      }
    },
  });
}

// ---------------------------------------------------------------- installed apps

export async function openAppsDialog(d) {
  if (!isInstance(d)) return toast('Máy này không hỗ trợ quản lý ứng dụng từ web.', 'error');
  let apps;
  try {
    ({ apps } = await api('GET', `${instPath(d)}/apps`));
  } catch {
    return;
  }
  const search = el('input', { class: 'input', type: 'search', placeholder: 'Tìm ứng dụng…', 'aria-label': 'Tìm ứng dụng' });
  const list = el('div', { class: 'app-list' });
  const appAction = async (a, action) => {
    const base = `${instPath(d)}/apps/${encodeURIComponent(a.package)}`;
    if (action === 'uninstall') {
      if (!(await confirmDialog({ title: `Gỡ "${a.label || a.package}"?`, text: 'Ứng dụng và dữ liệu của nó sẽ bị xoá khỏi máy ảo.', confirm: 'Gỡ cài đặt', danger: true }))) return;
      await api('DELETE', base);
      apps = apps.filter((x) => x !== a);
      render();
      toast('Đã gỡ ứng dụng.', 'ok');
    } else {
      await api('POST', `${base}/${action}`);
      toast(action === 'launch' ? `Đã mở ${a.label || a.package}` : `Đã dừng ${a.label || a.package}`, 'ok');
    }
  };
  const render = () => {
    const q = search.value.trim().toLowerCase();
    const shown = apps.filter((a) => !q || `${a.label} ${a.package}`.toLowerCase().includes(q));
    list.replaceChildren(
      ...(shown.length
        ? shown.map((a) =>
            el(
              'div',
              { class: 'app-row' },
              el('div', { class: 'app-ico', 'aria-hidden': 'true' }, (a.label || a.package).trim().charAt(0).toUpperCase()),
              el('div', { class: 'app-name' }, el('div', {}, a.label || a.package), a.label ? el('small', {}, a.package) : null),
              el('button', { type: 'button', class: 'btn sm', title: 'Mở', 'aria-label': `Mở ${a.label || a.package}`, onclick: () => appAction(a, 'launch').catch(() => {}) }, icon('play')),
              el('button', { type: 'button', class: 'btn sm icon', title: 'Dừng', 'aria-label': `Dừng ${a.label || a.package}`, onclick: () => appAction(a, 'stop').catch(() => {}) }, icon('stop')),
              el('button', { type: 'button', class: 'btn sm icon danger', title: 'Gỡ cài đặt', 'aria-label': `Gỡ ${a.label || a.package}`, onclick: () => appAction(a, 'uninstall').catch(() => {}) }, icon('trash')),
            ),
          )
        : [el('div', { class: 'muted', style: { padding: '12px 4px' } }, q ? 'Không có ứng dụng khớp.' : 'Chưa có ứng dụng nào được cài thêm.')]),
    );
  };
  search.addEventListener('input', render);
  render();
  return modal({
    title: 'Ứng dụng đã cài',
    text: `${d.name} · ${apps.length} ứng dụng`,
    iconName: 'apps',
    wide: true,
    body: [search, list],
    actions: [
      { label: 'Cài APK mới', kind: '', icon: 'upload', value: 'apk' },
      { label: 'Đóng', kind: 'primary', value: null },
    ],
  }).then((v) => {
    if (v === 'apk') openApkDialog(d);
  });
}

// ---------------------------------------------------------------- theme

export function currentTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}
export function toggleTheme() {
  const next = currentTheme() === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  storageSet('ldr-theme', next);
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', next === 'light' ? '#f3f5fa' : '#0b0e15');
  return next;
}

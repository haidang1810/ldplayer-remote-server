// Dashboard: login/register, app shell with hash routes (#phones, #pcs, #keys, #account, #admin),
// the phone-card grid with instance actions, PCs, API keys, password and user administration.
import {
  $, el, icon, hydrateIcons, toast, api, fmtTime, storageGet, storageSet, setUnauthorizedHandler,
  deviceState, deviceKey, isInstance, instPath, viewerUrl, instanceAction, fetchScreenshot,
  STATE_LABEL, STATE_CHIP, modal, confirmDialog, promptDialog, openMenu, openApkDialog, openAppsDialog,
  currentTheme, toggleTheme, SOON,
} from './common.js';

const state = {
  me: null,
  allowRegister: true,
  devices: [],
  agents: [],
  machines: [],
  devicesLoaded: false,
  devicesError: false,
  filter: { q: '', pc: storageGet('ldr-filter-pc') ?? '', state: '' },
  selectMode: false,
  selected: new Set(),
  pending: new Map(), // device key → { action, at }
  thumbs: new Map(), // device key → object URL
  users: [],
  userFilter: null,
  keysLoaded: false,
};

const timers = {};
const views = [...document.querySelectorAll('.view')];
const ROUTE_TITLES = { phones: 'Điện thoại', pcs: 'Máy tính (PC)', keys: 'API key', account: 'Tài khoản', admin: 'Quản trị' };

// ================================================================ auth

let authMode = 'login';

function setAuthMode(mode) {
  authMode = mode === 'register' && state.allowRegister ? 'register' : 'login';
  const reg = authMode === 'register';
  $('tab-login').setAttribute('aria-selected', String(!reg));
  $('tab-register').setAttribute('aria-selected', String(reg));
  $('auth-tabs').hidden = !state.allowRegister;
  $('auth-title').textContent = reg ? 'Tạo tài khoản' : 'Chào mừng trở lại';
  $('auth-sub').textContent = reg ? 'Đăng ký để quản lý máy ảo của bạn từ xa.' : 'Đăng nhập để vào bảng điều khiển.';
  $('auth-pass2-field').hidden = !reg;
  $('auth-note').hidden = !reg;
  $('auth-pass').autocomplete = reg ? 'new-password' : 'current-password';
  $('auth-submit').textContent = reg ? 'Gửi đăng ký' : 'Đăng nhập';
  $('auth-error').hidden = true;
}

function showAuth(error) {
  stopPolling();
  closeAllDialogs();
  $('boot').hidden = true;
  $('shell').hidden = true;
  $('auth').hidden = false;
  $('auth-forms').hidden = false;
  $('auth-pending').hidden = true;
  setAuthMode('login');
  if (error) authError(error);
  $('auth-user').focus();
}

function closeAllDialogs() {
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
}

function authError(text) {
  $('auth-error').textContent = text;
  $('auth-error').hidden = false;
}

function showPending(username) {
  $('auth-forms').hidden = true;
  $('auth-pending').hidden = false;
  $('pending-text').textContent = `Tài khoản “${username}” đã được tạo và đang chờ quản trị viên duyệt. Khi được duyệt, bạn đăng nhập lại bằng tên và mật khẩu vừa tạo.`;
  $('pending-back').focus();
}

$('tab-login').addEventListener('click', () => setAuthMode('login'));
$('tab-register').addEventListener('click', () => setAuthMode('register'));
$('pending-back').addEventListener('click', () => {
  $('auth-pending').hidden = true;
  $('auth-forms').hidden = false;
  setAuthMode('login');
  $('auth-pass').focus();
});

$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('auth-user').value.trim();
  const password = $('auth-pass').value;
  if (!username || !password) return authError('Hãy nhập tên đăng nhập và mật khẩu.');
  if (authMode === 'register') {
    if (password.length < 8) return authError('Mật khẩu tối thiểu 8 ký tự.');
    if (password !== $('auth-pass2').value) return authError('Hai lần nhập mật khẩu không khớp.');
  }
  const btn = $('auth-submit');
  btn.disabled = true;
  try {
    const data = await api('POST', authMode === 'register' ? '/api/register' : '/api/login', { username, password }, { quiet: true });
    $('auth-pass').value = '';
    $('auth-pass2').value = '';
    if (authMode === 'register') {
      if (data.status === 'pending') return showPending(username);
      setAuthMode('login');
      return authError('Đã đăng ký, hãy đăng nhập.');
    }
    const next = new URLSearchParams(location.search).get('next');
    if (next && /^viewer\.html(\?[\w%=&.-]*)?$/.test(next)) {
      location.href = next;
      return;
    }
    await enterShell();
  } catch (err) {
    if (err.status === 403 && /duyệt/.test(err.message)) return showPending(username);
    authError(err.status === 0 ? 'Không kết nối được server.' : err.message);
  } finally {
    btn.disabled = false;
  }
});

// ================================================================ shell / routing

async function enterShell() {
  const { user } = await api('GET', '/api/session', undefined, { quiet: true });
  state.me = user;
  $('boot').hidden = true;
  $('auth').hidden = true;
  $('shell').hidden = false;
  const initial = (user.username || '?').charAt(0);
  for (const id of ['me-avatar', 'mtop-avatar', 'acc-avatar']) $(id).textContent = initial;
  $('me-name').textContent = user.username;
  $('me-role').textContent = user.role === 'admin' ? 'Quản trị viên' : 'Người dùng';
  $('acc-name').textContent = user.username;
  $('acc-role').replaceChildren(
    el('span', { class: `chip ${user.role === 'admin' ? 'accent' : 'ok'} plain` }, user.role === 'admin' ? 'Quản trị viên' : 'Người dùng · Đang hoạt động'),
  );
  $('pw-username').value = user.username;
  $('relay-url').textContent = location.origin;
  for (const a of document.querySelectorAll('.admin-only')) a.hidden = user.role !== 'admin';
  renderTheme();
  startPolling();
  route();
}

function route() {
  if (!state.me) return;
  let [name, query] = location.hash.slice(1).split('?');
  if (!ROUTE_TITLES[name] || (name === 'admin' && state.me.role !== 'admin')) name = 'phones';
  if (name === 'phones' && query) {
    const pc = new URLSearchParams(query).get('pc');
    if (pc !== null) setPcFilter(pc);
  }
  for (const v of views) v.hidden = v.dataset.view !== name;
  for (const a of document.querySelectorAll('[data-route]')) {
    if (a.dataset.route === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  $('mtop-title').textContent = ROUTE_TITLES[name];
  document.title = `${ROUTE_TITLES[name]} · LD Remote`;
  if (name !== 'phones') setSelectMode(false);
  if (name === 'phones') renderPhones();
  if (name === 'pcs') loadMachines().then(renderPcs, () => {});
  if (name === 'keys') loadKeys().catch(() => {});
  if (name === 'admin') loadUsers().catch(() => {});
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

function startPolling() {
  stopPolling();
  // The first load always runs; after that, background tabs skip polls (and catch up on return).
  const loop = (name, fn, ms) => {
    const tick = async (first) => {
      if (first || document.visibilityState === 'visible') await fn().catch(() => {});
      timers[name] = setTimeout(tick, ms);
    };
    tick(true);
  };
  loop('devices', loadDevices, 8000);
  loop('machines', reloadMachines, 15000);
  if (state.me.role === 'admin') loop('users', loadUsers, 20000);
  timers.thumbs = setInterval(refreshVisibleThumbs, 10000);
  timers.clock = setInterval(() => {
    for (const c of document.querySelectorAll('.ph .clock')) c.textContent = clockText();
  }, 30000);
}

function stopPolling() {
  for (const [k, t] of Object.entries(timers)) {
    clearTimeout(t);
    clearInterval(t);
    delete timers[k];
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.me && !$('shell').hidden) {
    loadDevices().catch(() => {});
    reloadMachines().catch(() => {});
    loadUsers().catch(() => {});
    refreshVisibleThumbs();
  }
});

const reloadMachines = () => loadMachines().then(() => (currentRoute() === 'pcs' ? renderPcs() : renderPhones()));

const currentRoute = () => views.find((v) => !v.hidden)?.dataset.view;

// ================================================================ data

async function loadDevices() {
  try {
    const body = await api('GET', '/api/devices', undefined, { quiet: true });
    state.devices = body.devices ?? [];
    state.agents = body.agents ?? [];
    state.devicesError = false;
  } catch (err) {
    if (err.status === 401) return;
    state.devicesError = true;
  }
  state.devicesLoaded = true;
  settlePending();
  renderPhones();
  renderSide();
  if (currentRoute() === 'pcs') renderPcs();
}

async function loadMachines() {
  const { machines } = await api('GET', '/api/machines', undefined, { quiet: true });
  state.machines = machines ?? [];
}

function settlePending() {
  const now = Date.now();
  for (const [key, p] of state.pending) {
    const d = state.devices.find((x) => deviceKey(x) === key);
    const s = d ? deviceState(d) : null;
    const done =
      now - p.at > 90e3 ||
      (p.action === 'launch' && s === 'live') ||
      (p.action === 'quit' && s === 'off') ||
      (p.action === 'reboot' && now - p.at > 25e3 && s === 'live');
    if (done) state.pending.delete(key);
  }
}

function soonRefresh() {
  setTimeout(() => loadDevices().catch(() => {}), 1500);
  setTimeout(() => loadDevices().catch(() => {}), 5000);
}

// ================================================================ sidebar

function renderSide() {
  const running = state.devices.filter((d) => d.running).length;
  const pcsOnline = state.agents.length;
  $('nav-phones-count').textContent = state.devices.length ? String(state.devices.length) : '';
  const box = $('side-status');
  if (!state.devicesLoaded) return box.replaceChildren();
  box.replaceChildren(
    el('div', { class: 'row' }, el('span', { class: `chip ${pcsOnline ? 'ok' : ''}` }, `${pcsOnline} PC online`)),
    el('div', { class: 'row' }, `${running}/${state.devices.length} máy đang chạy`),
  );
}

// ================================================================ phones view

const grid = $('grid');
const cards = new Map(); // key → { sig, node }

function setPcFilter(pc) {
  state.filter.pc = pc;
  storageSet('ldr-filter-pc', pc);
}

$('f-search').addEventListener('input', (e) => {
  state.filter.q = e.target.value.trim().toLowerCase();
  renderPhones();
});
$('f-pc').addEventListener('change', (e) => {
  setPcFilter(e.target.value);
  renderPhones();
});
for (const b of $('f-state').querySelectorAll('button')) {
  b.addEventListener('click', () => {
    state.filter.state = b.dataset.state;
    renderPhones();
  });
}
$('btn-refresh').addEventListener('click', async () => {
  $('btn-refresh').disabled = true;
  await Promise.all([loadDevices(), loadMachines().catch(() => {})]);
  renderPhones();
  refreshVisibleThumbs(true);
  $('btn-refresh').disabled = false;
  toast('Đã cập nhật danh sách máy.', 'ok', 1600);
});
$('btn-create').addEventListener('click', () => openCreateDialog());
$('btn-select').addEventListener('click', () => setSelectMode(!state.selectMode));

function matchesFilter(d) {
  const f = state.filter;
  if (f.pc && String(d.machine) !== f.pc) return false;
  if (f.state === 'running' && !d.running) return false;
  if (f.state === 'off' && d.running) return false;
  if (f.q && !`${d.name} ${d.agent ?? ''} ${d.index ?? ''}`.toLowerCase().includes(f.q)) return false;
  return true;
}

function renderPcSelect() {
  const sel = $('f-pc');
  const opts = state.machines.map((m) => [String(m.id), `${m.name}${m.online ? '' : ' (offline)'}`]);
  // PCs online but missing from the machine list (legacy key): take them from the devices.
  for (const d of state.devices) if (!opts.some(([v]) => v === String(d.machine))) opts.push([String(d.machine), d.agent ?? `PC ${d.machine}`]);
  const sig = JSON.stringify(opts);
  if (sel.dataset.sig !== sig) {
    sel.dataset.sig = sig;
    sel.replaceChildren(new Option('Tất cả PC', ''), ...opts.map(([v, l]) => new Option(l, v)));
  }
  if (state.filter.pc && !opts.some(([v]) => v === state.filter.pc)) setPcFilter('');
  sel.value = state.filter.pc;
  sel.hidden = opts.length < 2 && !state.filter.pc;
}

function renderPhones() {
  if (currentRoute() !== 'phones' && cards.size) return renderKpis();
  renderPcSelect();
  renderKpis();
  const all = state.devices;
  const running = all.filter((d) => d.running).length;
  const seg = $('f-state').querySelectorAll('button');
  const counts = { '': all.length, running, off: all.length - running };
  for (const b of seg) {
    b.setAttribute('aria-checked', String(b.dataset.state === state.filter.state));
    b.querySelector('span').textContent = state.devicesLoaded ? String(counts[b.dataset.state]) : '';
  }

  const empty = emptyState();
  $('phones-empty').hidden = !empty;
  if (empty) $('phones-empty').replaceChildren(empty);
  $('filters').hidden = !state.devicesLoaded || all.length === 0;
  $('btn-select').hidden = all.length === 0;
  $('btn-create').hidden = state.devicesLoaded && state.agents.length === 0;
  $('kpis').hidden = state.devicesLoaded && all.length === 0 && state.machines.length === 0 && !state.devicesError;

  if (!state.devicesLoaded) {
    grid.replaceChildren(...Array.from({ length: 6 }, () => el('div', { class: 'pcard skeleton', 'aria-hidden': 'true' }, el('div', { class: 'pframe' }), el('div', { class: 'sk-line' }), el('div', { class: 'sk-line short' }))));
    return;
  }
  const shown = all.filter(matchesFilter).sort((a, b) => (a.agent ?? '').localeCompare(b.agent ?? '') || (a.index ?? 0) - (b.index ?? 0));
  const keys = new Set();
  const nodes = shown.map((d) => {
    const key = deviceKey(d);
    keys.add(key);
    const sig = JSON.stringify([d, state.pending.get(key)?.action, state.selectMode, state.selected.has(key)]);
    let entry = cards.get(key);
    if (!entry || entry.sig !== sig) {
      const node = buildCard(d);
      if (entry) {
        thumbObserver.unobserve(entry.node);
        entry.node.replaceWith(node);
      }
      entry = { sig, node, device: d };
      cards.set(key, entry);
      thumbObserver.observe(node);
    }
    entry.device = d;
    return entry.node;
  });
  for (const [key, entry] of cards) {
    if (!keys.has(key)) {
      thumbObserver.unobserve(entry.node);
      entry.node.remove();
      cards.delete(key);
    }
  }
  const same = grid.children.length === nodes.length && nodes.every((n, i) => grid.children[i] === n);
  if (!same) grid.replaceChildren(...nodes);
  for (const key of state.selected) if (!state.devices.some((d) => deviceKey(d) === key)) state.selected.delete(key);
  renderBatch();
}

function renderKpis() {
  const all = state.devices;
  const running = all.filter((d) => d.running).length;
  const loaded = state.devicesLoaded;
  $('kpi-total').textContent = loaded ? all.length : '–';
  $('kpi-running').textContent = loaded ? running : '–';
  $('kpi-off').textContent = loaded ? all.length - running : '–';
  const pcsTotal = Math.max(state.machines.length, state.agents.length);
  $('kpi-pcs').textContent = loaded ? `${state.agents.length}/${pcsTotal}` : '–';
}

function emptyBox({ iconName, warn, title, text, extra = [], actions = [] }) {
  return el(
    'div',
    { class: 'empty' },
    el('div', { class: `empty-ico${warn ? ' warn' : ''}` }, icon(iconName)),
    el('h2', {}, title),
    text && el('p', {}, text),
    extra,
    actions.length ? el('div', { class: 'actions' }, actions) : null,
  );
}

function onboardingSteps() {
  return el(
    'ol',
    { class: 'steps' },
    el('li', {}, el('b', {}, 'Tạo API key'), el('span', {}, 'Vào mục API key, đặt tên rồi bấm “Tạo key”. Key chỉ hiện một lần.')),
    el('li', {}, el('b', {}, 'Tải app LDPlayer Remote về PC'), el('span', {}, 'Cài trên PC đang chạy LDPlayer và bật ADB trong cài đặt LDPlayer.')),
    el('li', {}, el('b', {}, 'Dán key vào app'), el('span', {}, 'PC tự kết nối, các máy ảo sẽ hiện ngay tại đây.')),
  );
}

function emptyState() {
  if (!state.devicesLoaded) return null;
  const all = state.devices;
  if (state.devicesError && !all.length) {
    return emptyBox({
      iconName: 'alert',
      warn: true,
      title: 'Không tải được danh sách máy',
      text: 'Không kết nối được server. Kiểm tra mạng rồi thử lại.',
      actions: [el('button', { class: 'btn primary', type: 'button', onclick: () => loadDevices() }, icon('refresh'), 'Thử lại')],
    });
  }
  if (!all.length && !state.agents.length && !state.machines.length) {
    return emptyBox({
      iconName: 'sparkle',
      title: 'Bắt đầu: kết nối PC đầu tiên',
      text: 'Chưa có PC nào trong tài khoản. Làm theo 3 bước dưới đây, máy ảo LDPlayer trên PC của bạn sẽ hiện ở đây để điều khiển từ xa.',
      extra: [onboardingSteps()],
      actions: [el('a', { class: 'btn primary lg', href: '#keys' }, icon('key'), 'Tạo API key')],
    });
  }
  if (!state.agents.length) {
    return emptyBox({
      iconName: 'pc',
      warn: true,
      title: 'PC đang offline',
      text: 'Không có PC nào đang kết nối. Hãy bật PC và mở app LDPlayer Remote trên đó; máy ảo sẽ hiện lại sau vài giây.',
      extra: [
        el(
          'div',
          { class: 'pc-list' },
          state.machines.map((m) => el('div', {}, icon('pc'), el('b', {}, m.name), el('small', {}, m.online ? 'online' : `lần cuối ${fmtTime(m.last_seen)}`))),
        ),
      ],
      actions: [el('a', { class: 'btn', href: '#pcs' }, 'Xem PC'), el('a', { class: 'btn ghost', href: '#keys' }, 'Kết nối PC khác')],
    });
  }
  if (!all.length) {
    return emptyBox({
      iconName: 'phone',
      title: 'Chưa thấy máy ảo nào',
      text: `${state.agents.join(', ')} đang online nhưng chưa có máy ảo LDPlayer nào. Tạo máy mới ngay, hoặc mở LDPlayer Multi-Instance trên PC.`,
      actions: [el('button', { class: 'btn primary', type: 'button', onclick: () => openCreateDialog() }, icon('plus'), 'Tạo máy mới')],
    });
  }
  if (!all.some(matchesFilter)) {
    return emptyBox({
      iconName: 'search',
      title: 'Không có máy khớp bộ lọc',
      text: 'Thử đổi từ khoá hoặc bỏ bộ lọc.',
      actions: [
        el('button', {
          class: 'btn',
          type: 'button',
          onclick: () => {
            state.filter = { q: '', pc: '', state: '' };
            storageSet('ldr-filter-pc', '');
            $('f-search').value = '';
            renderPhones();
          },
        }, 'Bỏ bộ lọc'),
      ],
    });
  }
  return null;
}

const clockText = () => new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });

function placeholder(d, s) {
  if (s === 'live') {
    return el(
      'div',
      { class: 'ph live', style: { '--h': String(((d.index ?? 0) * 47 + 220) % 360) } },
      el('div', { class: 'clock' }, clockText()),
      el('div', { class: 'date' }, new Date().toLocaleDateString('vi-VN', { weekday: 'long', day: 'numeric', month: 'numeric' })),
      el('div', { class: 'dots', 'aria-hidden': 'true' }, Array.from({ length: 8 }, () => el('i'))),
    );
  }
  if (s === 'noadb') {
    return el('div', { class: 'ph noadb' }, el('div', { class: 'ph-ico' }, icon('alert')), el('b', {}, 'Chưa bật ADB'), el('small', {}, 'LDPlayer: Cài đặt → Cài đặt khác → Gỡ lỗi ADB → Mở kết nối cục bộ'));
  }
  return el('div', { class: 'ph off' }, el('div', { class: 'ph-ico' }, icon('power')), el('b', {}, 'Đã tắt'), el('small', {}, isInstance(d) ? 'Bấm Bật để khởi động' : ''));
}

const PENDING_LABEL = { launch: 'Đang bật…', quit: 'Đang tắt…', reboot: 'Đang khởi động lại…', create: 'Đang tạo…' };

function buildCard(d) {
  const key = deviceKey(d);
  const s = deviceState(d);
  const pending = state.pending.get(key);
  const selected = state.selected.has(key);
  const canOpen = s === 'live' && !state.selectMode;
  const thumb = s === 'live' ? state.thumbs.get(key) : null;

  const screen = el('div', { class: 'pscreen' }, thumb ? el('img', { src: thumb, alt: '' }) : placeholder(d, s));
  const frameChildren = [
    screen,
    el('span', { class: `chip ${STATE_CHIP[s]} ${s === 'live' ? 'pulse' : ''}` }, STATE_LABEL[s]),
    canOpen && el('div', { class: 'hover-cta', 'aria-hidden': 'true' }, el('span', {}, icon('play'), 'Mở điều khiển')),
    pending && el('div', { class: 'busy' }, el('div', { class: 'spinner' }), PENDING_LABEL[pending.action] ?? 'Đang xử lý…'),
  ];
  const frame = canOpen
    ? el('a', { class: 'pframe', href: viewerUrl(d), 'aria-label': `Mở điều khiển ${d.name}` }, frameChildren)
    : el(
        'button',
        {
          class: 'pframe',
          type: 'button',
          'aria-label': state.selectMode ? `Chọn ${d.name}` : `${d.name}: ${STATE_LABEL[s]}`,
          disabled: !state.selectMode && s !== 'off' ? true : undefined,
          onclick: () => {
            if (state.selectMode) toggleSelected(key);
            else if (s === 'off') powerToggle(d);
          },
        },
        frameChildren,
      );

  const more = el('button', { class: 'btn ghost icon sm', type: 'button', 'aria-label': `Thêm thao tác cho ${d.name}`, 'aria-haspopup': 'menu', title: 'Thêm' }, icon('more'));
  more.addEventListener('click', () => openCardMenu(more, d));

  const running = s !== 'off';
  const power = el(
    'button',
    {
      class: `btn sm icon ${running ? '' : 'power-on'}`,
      type: 'button',
      title: running ? 'Tắt máy' : 'Bật máy',
      'aria-label': `${running ? 'Tắt' : 'Bật'} ${d.name}`,
      disabled: !isInstance(d) || !!pending || undefined,
      onclick: () => powerToggle(d),
    },
    icon('power'),
  );

  const open = s === 'live'
    ? el('a', { class: 'btn primary sm', href: viewerUrl(d) }, icon('play'), 'Điều khiển')
    : el('button', { class: 'btn primary sm', type: 'button', disabled: !isInstance(d) || !!pending || s === 'noadb' || undefined, onclick: () => powerToggle(d) }, icon('power'), s === 'noadb' ? 'Chưa bật ADB' : 'Bật máy');

  const card = el(
    'article',
    { class: `pcard${selected ? ' selected' : ''}`, dataset: { key, state: s } },
    frame,
    state.selectMode &&
      el(
        'button',
        { class: 'pcheck', type: 'button', role: 'checkbox', 'aria-checked': String(selected), 'aria-label': `Chọn ${d.name}`, onclick: () => toggleSelected(key) },
        icon('check'),
      ),
    el(
      'div',
      { class: 'pinfo' },
      el('div', {}, el('div', { class: 'pname', title: d.name }, d.name), el('div', { class: 'pmeta' }, icon('pc'), el('span', {}, `${d.agent ?? 'PC'}${d.index !== null && d.index !== undefined ? ` · #${d.index}` : ''}`))),
      more,
    ),
    el('div', { class: 'pactions' }, open, power),
  );
  return card;
}

function openCardMenu(anchor, d) {
  const s = deviceState(d);
  const inst = isInstance(d);
  openMenu(
    anchor,
    [
      { label: 'Mở điều khiển', icon: 'play', disabled: s !== 'live', onClick: () => (location.href = viewerUrl(d)) },
      s === 'off'
        ? { label: 'Bật máy', icon: 'power', disabled: !inst, onClick: () => powerToggle(d) }
        : { label: 'Tắt máy', icon: 'power', disabled: !inst, onClick: () => powerToggle(d) },
      { label: 'Khởi động lại', icon: 'restart', disabled: !inst || s === 'off', onClick: () => runAction(d, 'reboot') },
      '-',
      { label: 'Đổi tên', icon: 'edit', disabled: !inst, onClick: () => renameInstance(d) },
      { label: 'Nhân bản', icon: 'copy', disabled: !inst, onClick: () => cloneInstance(d) },
      { label: 'Cài APK', icon: 'apk', disabled: !inst || s === 'off', onClick: () => openApkDialog(d) },
      { label: 'Ứng dụng đã cài', icon: 'apps', disabled: !inst || s !== 'live', onClick: () => openAppsDialog(d) },
      '-',
      { label: 'Xoá máy', icon: 'trash', danger: true, disabled: !inst, onClick: () => deleteInstance(d) },
    ],
    { sheetTitle: `${d.name} · ${d.agent ?? ''}` },
  );
}

async function runAction(d, action, { quiet = false } = {}) {
  const key = deviceKey(d);
  try {
    await instanceAction(d, action, { quiet });
    state.pending.set(key, { action, at: Date.now() });
    renderPhones();
    soonRefresh();
    return true;
  } catch (err) {
    if (quiet) throw err;
    return false;
  }
}

async function powerToggle(d) {
  if (!isInstance(d)) return toast('Máy này không điều khiển nguồn được từ web.', 'error');
  if (deviceState(d) === 'off') return runAction(d, 'launch');
  const ok = await confirmDialog({ title: `Tắt “${d.name}”?`, text: 'Máy ảo sẽ đóng trên PC. Các ứng dụng đang chạy trong máy sẽ dừng.', confirm: 'Tắt máy', danger: true, iconName: 'power' });
  if (ok) runAction(d, 'quit');
}

async function renameInstance(d) {
  const name = await promptDialog({ title: 'Đổi tên máy', text: `${d.agent ?? ''} · #${d.index}`, label: 'Tên mới', value: d.name, maxLength: 40 });
  if (!name || name === d.name) return;
  try {
    await api('PATCH', instPath(d), { name });
    toast('Đã đổi tên.', 'ok');
    soonRefresh();
  } catch { /* toasted */ }
}

async function cloneInstance(d) {
  const name = await promptDialog({ title: 'Nhân bản máy', text: `Tạo máy mới trên ${d.agent ?? 'PC'} với dữ liệu và ứng dụng của “${d.name}”.`, label: 'Tên máy mới', value: `${d.name} - Bản sao`, confirm: 'Nhân bản', iconName: 'copy', maxLength: 40 });
  if (!name) return;
  try {
    await api('POST', `/api/machines/${d.machine}/instances`, { action: 'copy', from: d.index, name });
    toast(`Đang nhân bản thành “${name}”…`, 'ok');
    soonRefresh();
  } catch { /* toasted */ }
}

async function deleteInstance(d) {
  const ok = await confirmDialog({
    title: `Xoá “${d.name}”?`,
    text: `Máy ảo và toàn bộ dữ liệu bên trong sẽ bị xoá vĩnh viễn khỏi ${d.agent ?? 'PC'}. Không hoàn tác được.${d.running ? ' Máy đang chạy sẽ bị tắt trước.' : ''}`,
    confirm: 'Xoá vĩnh viễn',
    danger: true,
    iconName: 'trash',
  });
  if (!ok) return;
  try {
    await api('DELETE', instPath(d));
    toast('Đã xoá máy.', 'ok');
    soonRefresh();
  } catch { /* toasted */ }
}

async function openCreateDialog() {
  const online = state.machines.filter((m) => m.online);
  if (!online.length) {
    toast('Chưa có PC nào online để tạo máy.', 'error');
    return;
  }
  const pcSel = el('select', { class: 'input' }, online.map((m) => new Option(m.name, String(m.id))));
  if (state.filter.pc && online.some((m) => String(m.id) === state.filter.pc)) pcSel.value = state.filter.pc;
  const modeNew = el('button', { type: 'button', role: 'radio', 'aria-checked': 'true' }, 'Máy mới');
  const modeCopy = el('button', { type: 'button', role: 'radio', 'aria-checked': 'false' }, 'Nhân bản từ máy có sẵn');
  const srcSel = el('select', { class: 'input' });
  const srcField = el('label', { class: 'field', hidden: true }, el('span', {}, 'Máy nguồn'), srcSel);
  const nameInput = el('input', { class: 'input', type: 'text', required: true, maxlength: '40', placeholder: 'vd: Máy 05' });
  let mode = 'create';
  const fillSources = () => {
    const list = state.devices.filter((d) => String(d.machine) === pcSel.value && isInstance(d));
    srcSel.replaceChildren(...list.map((d) => new Option(`${d.name} (#${d.index})`, String(d.index))));
    modeCopy.disabled = !list.length;
    if (!list.length && mode === 'copy') setMode('create');
  };
  const setMode = (m) => {
    mode = m;
    modeNew.setAttribute('aria-checked', String(m === 'create'));
    modeCopy.setAttribute('aria-checked', String(m === 'copy'));
    srcField.hidden = m !== 'copy';
  };
  modeNew.addEventListener('click', () => setMode('create'));
  modeCopy.addEventListener('click', () => setMode('copy'));
  pcSel.addEventListener('change', fillSources);
  fillSources();
  const count = state.devices.filter((d) => String(d.machine) === pcSel.value).length;
  nameInput.value = `Máy ${String(count + 1).padStart(2, '0')}`;

  await modal({
    title: 'Tạo máy mới',
    text: 'Tạo một máy ảo LDPlayer mới trên PC đã chọn.',
    iconName: 'plus',
    body: [
      el('label', { class: 'field' }, el('span', {}, 'PC'), pcSel),
      el('div', { class: 'field' }, el('span', {}, 'Cách tạo'), el('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Cách tạo' }, modeNew, modeCopy)),
      srcField,
      el('label', { class: 'field' }, el('span', {}, 'Tên máy'), nameInput, el('small', { class: 'hint' }, 'Chữ, số, khoảng trắng và . _ -')),
    ],
    actions: [
      { label: 'Huỷ', value: null, kind: 'ghost' },
      { label: 'Tạo máy', kind: 'primary', submit: true, icon: 'plus' },
    ],
    onSubmit: async () => {
      const name = nameInput.value.trim();
      if (!name) return undefined;
      const body = mode === 'copy' ? { action: 'copy', from: Number(srcSel.value), name } : { action: 'create', name };
      try {
        await api('POST', `/api/machines/${pcSel.value}/instances`, body);
        toast(`Đang tạo “${name}”…`, 'ok');
        soonRefresh();
        return true;
      } catch (err) {
        return err.unbuilt ? null : undefined;
      }
    },
  });
}

// ---------------------------------------------------------------- select mode / batch

function setSelectMode(on) {
  if (state.selectMode === on) return;
  state.selectMode = on;
  if (!on) state.selected.clear();
  $('btn-select').setAttribute('aria-pressed', String(on));
  renderPhones();
}

function toggleSelected(key) {
  if (state.selected.has(key)) state.selected.delete(key);
  else state.selected.add(key);
  renderPhones();
}

function renderBatch() {
  const n = state.selected.size;
  $('batchbar').hidden = !state.selectMode;
  $('batch-count').textContent = n ? `Đã chọn ${n} máy` : 'Chọn máy…';
  for (const id of ['batch-launch', 'batch-quit', 'batch-reboot']) $(id).disabled = !n;
}

$('batch-close').addEventListener('click', () => setSelectMode(false));
$('batch-all').addEventListener('click', () => {
  const visible = state.devices.filter(matchesFilter).map(deviceKey);
  const allSelected = visible.every((k) => state.selected.has(k));
  for (const k of visible) {
    if (allSelected) state.selected.delete(k);
    else state.selected.add(k);
  }
  renderPhones();
});

async function batch(action) {
  const targets = state.devices.filter((d) => state.selected.has(deviceKey(d)) && isInstance(d));
  const wanted = targets.filter((d) => (action === 'launch' ? !d.running : action === 'quit' ? d.running : d.running));
  if (!wanted.length) {
    toast(action === 'launch' ? 'Các máy đã chọn đều đang chạy.' : 'Các máy đã chọn đều đang tắt.', 'info');
    return;
  }
  if (action !== 'launch') {
    const label = action === 'quit' ? 'Tắt' : 'Khởi động lại';
    const ok = await confirmDialog({ title: `${label} ${wanted.length} máy?`, text: wanted.map((d) => d.name).join(', '), confirm: label, danger: action === 'quit', iconName: action === 'quit' ? 'power' : 'restart' });
    if (!ok) return;
  }
  let done = 0;
  for (const d of wanted) {
    try {
      await runAction(d, action, { quiet: true });
      done++;
    } catch (err) {
      toast(err.unbuilt ? SOON : `${d.name}: ${err.message}`, err.unbuilt ? 'info' : 'error', 4000);
      if (err.unbuilt) break;
    }
  }
  if (done) toast(`Đã gửi lệnh tới ${done}/${wanted.length} máy.`, 'ok');
  setSelectMode(false);
}
$('batch-launch').addEventListener('click', () => batch('launch'));
$('batch-quit').addEventListener('click', () => batch('quit'));
$('batch-reboot').addEventListener('click', () => batch('reboot'));

// ---------------------------------------------------------------- thumbnails

const visibleKeys = new Set();
const thumbObserver = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      const key = e.target.dataset.key;
      if (e.isIntersecting) {
        visibleKeys.add(key);
        if (!state.thumbs.has(key)) queueThumb(key);
      } else {
        visibleKeys.delete(key);
      }
    }
  },
  { rootMargin: '100px' },
);

const thumbQueue = new Set();
let thumbBusy = false;
function queueThumb(key) {
  thumbQueue.add(key);
  if (!thumbBusy) drainThumbs();
}
async function drainThumbs() {
  thumbBusy = true;
  while (thumbQueue.size) {
    const key = thumbQueue.values().next().value;
    thumbQueue.delete(key);
    const entry = cards.get(key);
    if (!entry || deviceState(entry.device) !== 'live' || !visibleKeys.has(key)) continue;
    const url = await fetchScreenshot(entry.device);
    if (!url) continue;
    const old = state.thumbs.get(key);
    state.thumbs.set(key, url);
    const screen = cards.get(key)?.node.querySelector('.pscreen');
    if (screen) {
      let img = screen.querySelector('img');
      if (!img) {
        img = el('img', { alt: '' });
        screen.replaceChildren(img);
      }
      img.src = url;
    }
    if (old) setTimeout(() => URL.revokeObjectURL(old), 1000);
  }
  thumbBusy = false;
}
function refreshVisibleThumbs() {
  if (document.visibilityState !== 'visible' || currentRoute() !== 'phones') return;
  for (const key of visibleKeys) queueThumb(key);
}

// ================================================================ PCs view

function renderPcs() {
  const box = $('pcs');
  if (!state.machines.length) {
    box.replaceChildren(
      emptyBox({
        iconName: 'pc',
        title: 'Chưa có PC nào',
        text: 'Tạo API key rồi dán vào app LDPlayer Remote trên PC chạy LDPlayer. PC sẽ tự hiện ở đây.',
        extra: [onboardingSteps()],
        actions: [el('a', { class: 'btn primary', href: '#keys' }, icon('key'), 'Tạo API key')],
      }),
    );
    box.style.display = 'block';
    return;
  }
  box.style.display = '';
  box.replaceChildren(
    ...state.machines.map((m) => {
      const devs = state.devices.filter((d) => d.machine === m.id);
      const running = devs.filter((d) => d.running).length;
      return el(
        'div',
        { class: `card pc-card${m.online ? ' online' : ''}` },
        el(
          'div',
          { class: 'pc-head' },
          el('span', { class: 'pc-ico' }, icon('pc')),
          el('div', {}, el('b', { title: m.name }, m.name), el('span', { class: `chip ${m.online ? 'ok' : ''}` }, m.online ? 'Online' : 'Offline')),
        ),
        el(
          'div',
          { class: 'pc-stats' },
          el('div', {}, el('b', {}, m.online ? String(devs.length) : '–'), el('small', {}, 'Máy ảo')),
          el('div', {}, el('b', {}, m.online ? String(running) : '–'), el('small', {}, 'Đang chạy')),
          el('div', {}, el('b', {}, m.online ? String(devs.length - running) : '–'), el('small', {}, 'Đã tắt')),
        ),
        el(
          'div',
          { class: 'pc-meta' },
          el('span', {}, icon('clock'), m.online ? 'Đang kết nối' : `Lần cuối online: ${fmtTime(m.last_seen)}`),
          m.key_name && el('span', {}, icon('key'), `Key: ${m.key_name}`),
          m.last_ip && el('span', {}, icon('signal'), `IP: ${m.last_ip}`),
        ),
        el(
          'div',
          { class: 'pc-actions' },
          el('a', { class: 'btn sm', href: `#phones?pc=${m.id}` }, icon('phone'), 'Xem điện thoại'),
          el('button', { class: 'btn sm', type: 'button', onclick: () => renamePc(m) }, icon('edit'), 'Đổi tên'),
          el('button', { class: 'btn sm danger', type: 'button', onclick: () => removePc(m) }, icon('trash'), 'Gỡ'),
        ),
      );
    }),
  );
}

async function renamePc(m) {
  const name = await promptDialog({ title: 'Đổi tên PC', label: 'Tên mới', value: m.name, maxLength: 40 });
  if (!name || name === m.name) return;
  try {
    await api('PATCH', `/api/machines/${m.id}`, { name });
    toast('Đã đổi tên PC.', 'ok');
    await loadMachines();
    renderPcs();
    loadDevices();
  } catch { /* toasted */ }
}

async function removePc(m) {
  const ok = await confirmDialog({ title: `Gỡ PC “${m.name}”?`, text: 'PC bị gỡ khỏi tài khoản và ngắt kết nối. Nếu PC vẫn còn key hợp lệ, lần kết nối sau nó sẽ hiện lại; muốn chặn hẳn hãy xoá key.', confirm: 'Gỡ PC', danger: true, iconName: 'pc' });
  if (!ok) return;
  try {
    await api('DELETE', `/api/machines/${m.id}`);
    toast('Đã gỡ PC.', 'ok');
    await loadMachines();
    renderPcs();
    loadDevices();
  } catch { /* toasted */ }
}

// ================================================================ API keys

async function loadKeys() {
  const { keys } = await api('GET', '/api/keys', undefined, { quiet: true });
  const box = $('keys');
  if (!keys.length) {
    box.replaceChildren(el('div', { class: 'list-empty' }, 'Chưa có key nào. Tạo key ở bước 1 bên cạnh.'));
    return;
  }
  box.replaceChildren(
    ...keys.map((k) =>
      el(
        'div',
        { class: 'item' },
        el('span', { class: 'item-ico' }, icon('key')),
        el(
          'div',
          { class: 'main-col' },
          el('div', { class: 'title' }, k.name, el('span', { class: `chip ${k.machines ? 'ok' : ''} plain` }, `${k.machines} PC`)),
          el('div', { class: 'meta' }, `${k.prefix}… · tạo ${fmtTime(k.created_at)} · dùng lần cuối ${fmtTime(k.last_used_at)}`),
        ),
        el(
          'div',
          { class: 'actions' },
          el('button', {
            class: 'btn sm danger',
            type: 'button',
            'aria-label': `Xoá key ${k.name}`,
            onclick: async () => {
              const ok = await confirmDialog({ title: `Xoá key “${k.name}”?`, text: k.machines ? `${k.machines} PC đang dùng key này sẽ bị ngắt ngay.` : 'Key sẽ không dùng được nữa.', confirm: 'Xoá key', danger: true, iconName: 'key' });
              if (!ok) return;
              try {
                await api('DELETE', `/api/keys/${k.id}`);
                $('new-key').hidden = true;
                toast('Đã xoá key.', 'ok');
                loadKeys();
                loadMachines().catch(() => {});
              } catch { /* toasted */ }
            },
          }, icon('trash'), 'Xoá'),
        ),
      ),
    ),
  );
}

$('key-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const { key } = await api('POST', '/api/keys', { name: $('key-name').value.trim() });
    $('key-name').value = '';
    $('new-key-value').textContent = key;
    $('new-key-env').textContent = `RELAY_URL=${location.origin}\nAGENT_KEY=${key}`;
    $('new-key').hidden = false;
    toast('Đã tạo key. Hãy chép lại ngay.', 'ok');
    loadKeys();
  } catch { /* toasted */ }
});

async function copyText(node, okText) {
  try {
    await navigator.clipboard.writeText(node.textContent);
    toast(okText, 'ok');
  } catch {
    getSelection().selectAllChildren(node);
    toast('Không chép tự động được, nội dung đã được bôi đen để bạn chép.', 'info', 4000);
  }
}
$('new-key-copy').addEventListener('click', () => copyText($('new-key-value'), 'Đã chép key.'));
$('new-env-copy').addEventListener('click', () => copyText($('new-key-env'), 'Đã chép cấu hình.'));

// ================================================================ account

$('password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if ($('pw-new').value !== $('pw-new2').value) return toast('Hai lần nhập mật khẩu mới không khớp.', 'error');
  try {
    await api('POST', '/api/password', { current: $('pw-current').value, password: $('pw-new').value });
    e.target.reset();
    $('pw-username').value = state.me.username;
    toast('Đã đổi mật khẩu. Các trình duyệt khác đã bị đăng xuất.', 'ok', 4000);
  } catch { /* toasted */ }
});

function renderTheme() {
  const dark = currentTheme() === 'dark';
  for (const b of document.querySelectorAll('.theme-toggle')) b.replaceChildren(icon(dark ? 'sun' : 'moon'));
  for (const s of document.querySelectorAll('.theme-switch')) s.setAttribute('aria-checked', String(dark));
}
for (const b of document.querySelectorAll('.theme-toggle, .theme-switch')) {
  b.addEventListener('click', () => {
    toggleTheme();
    renderTheme();
  });
}

for (const b of document.querySelectorAll('.logout-btn')) {
  b.addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' }).catch(() => {});
    state.me = null;
    state.devicesLoaded = false;
    for (const url of state.thumbs.values()) URL.revokeObjectURL(url);
    state.thumbs.clear();
    cards.clear();
    grid.replaceChildren();
    showAuth();
  });
}

// ================================================================ admin

const STATUS_LABEL = { pending: 'Chờ duyệt', active: 'Đang dùng', disabled: 'Đã khoá' };
const STATUS_CHIP = { pending: 'warn', active: 'ok', disabled: 'danger' };

async function loadUsers() {
  if (state.me?.role !== 'admin') return;
  const { users, allowRegister } = await api('GET', '/api/admin/users', undefined, { quiet: true });
  state.users = users;
  const pending = users.filter((u) => u.status === 'pending').length;
  for (const id of ['nav-pending', 'tab-pending']) {
    $(id).hidden = !pending;
    $(id).textContent = String(pending);
  }
  $('register-note').textContent = allowRegister
    ? 'Ai cũng đăng ký được, nhưng phải được duyệt mới đăng nhập. (Tắt đăng ký: ALLOW_REGISTER=0 trong relay.env.)'
    : 'Đăng ký đang tắt (ALLOW_REGISTER=0).';
  if (state.userFilter === null) state.userFilter = pending ? 'pending' : '';
  if (currentRoute() === 'admin') renderUsers();
}

$('u-search').addEventListener('input', renderUsers);
for (const b of $('u-filter').querySelectorAll('button')) {
  b.addEventListener('click', () => {
    state.userFilter = b.dataset.status;
    renderUsers();
  });
}

function renderUsers() {
  const q = $('u-search').value.trim().toLowerCase();
  const counts = { '': state.users.length };
  for (const u of state.users) counts[u.status] = (counts[u.status] ?? 0) + 1;
  for (const b of $('u-filter').querySelectorAll('button')) {
    b.setAttribute('aria-checked', String(b.dataset.status === (state.userFilter ?? '')));
    b.querySelector('span').textContent = String(counts[b.dataset.status] ?? 0);
  }
  const shown = state.users.filter((u) => (!state.userFilter || u.status === state.userFilter) && (!q || u.username.toLowerCase().includes(q)));

  const act = (u, body, confirmOpts) => async () => {
    if (confirmOpts && !(await confirmDialog(confirmOpts))) return;
    try {
      await api('PATCH', `/api/admin/users/${u.id}`, body);
      toast('Đã cập nhật.', 'ok');
      loadUsers();
    } catch { /* toasted */ }
  };
  const box = $('users');
  if (!shown.length) {
    box.replaceChildren(el('div', { class: 'list-empty' }, state.userFilter === 'pending' ? 'Không có tài khoản nào chờ duyệt.' : 'Không có người dùng phù hợp.'));
    return;
  }
  box.replaceChildren(
    ...shown.map((u) => {
      const self = u.id === state.me.id;
      const more = el('button', { class: 'btn sm ghost icon', type: 'button', 'aria-label': `Thêm thao tác cho ${u.username}`, 'aria-haspopup': 'menu' }, icon('more'));
      more.addEventListener('click', () =>
        openMenu(more, [
          { label: u.role === 'admin' ? 'Bỏ quyền admin' : 'Cho làm admin', icon: 'shield', onClick: act(u, { role: u.role === 'admin' ? 'user' : 'admin' }, { title: u.role === 'admin' ? `Bỏ quyền admin của “${u.username}”?` : `Cho “${u.username}” làm admin?`, text: u.role === 'admin' ? 'Họ sẽ không quản lý người dùng được nữa.' : 'Admin duyệt, khoá và xoá được mọi tài khoản.', confirm: 'Đồng ý' }) },
          {
            label: 'Đặt mật khẩu mới',
            icon: 'key',
            onClick: async () => {
              const password = await promptDialog({ title: `Mật khẩu mới cho “${u.username}”`, text: 'Mọi phiên đăng nhập của họ sẽ bị đăng xuất.', label: 'Mật khẩu (tối thiểu 8 ký tự)', type: 'password', minLength: 8, maxLength: 200, confirm: 'Đặt mật khẩu', iconName: 'key' });
              if (!password) return;
              try {
                await api('PATCH', `/api/admin/users/${u.id}`, { password });
                toast('Đã đặt mật khẩu mới.', 'ok');
              } catch { /* toasted */ }
            },
          },
          '-',
          {
            label: 'Xoá tài khoản',
            icon: 'trash',
            danger: true,
            onClick: async () => {
              const ok = await confirmDialog({ title: `Xoá hẳn “${u.username}”?`, text: 'Tài khoản cùng key và danh sách PC của họ bị xoá. Không hoàn tác được.', confirm: 'Xoá tài khoản', danger: true, iconName: 'trash' });
              if (!ok) return;
              try {
                await api('DELETE', `/api/admin/users/${u.id}`);
                toast('Đã xoá tài khoản.', 'ok');
                loadUsers();
              } catch { /* toasted */ }
            },
          },
        ], { sheetTitle: u.username }),
      );
      const buttons = self
        ? [el('span', { class: 'muted' }, 'Bạn')]
        : [
            u.status === 'pending' && el('button', { class: 'btn sm primary', type: 'button', onclick: act(u, { status: 'active' }) }, icon('check'), 'Duyệt'),
            u.status === 'pending' && el('button', { class: 'btn sm', type: 'button', onclick: act(u, { status: 'disabled' }, { title: `Từ chối “${u.username}”?`, text: 'Tài khoản bị khoá, bạn vẫn mở khoá lại được sau.', confirm: 'Từ chối', danger: true }) }, 'Từ chối'),
            u.status === 'active' && el('button', { class: 'btn sm', type: 'button', onclick: act(u, { status: 'disabled' }, { title: `Khoá “${u.username}”?`, text: 'Mọi phiên đăng nhập và PC của họ bị ngắt ngay.', confirm: 'Khoá', danger: true }) }, 'Khoá'),
            u.status === 'disabled' && el('button', { class: 'btn sm', type: 'button', onclick: act(u, { status: 'active' }) }, 'Mở khoá'),
            more,
          ];
      return el(
        'div',
        { class: 'item' },
        el('span', { class: 'avatar' }, u.username.charAt(0)),
        el(
          'div',
          { class: 'main-col' },
          el(
            'div',
            { class: 'title' },
            u.username,
            el('span', { class: `chip ${STATUS_CHIP[u.status] ?? ''}` }, STATUS_LABEL[u.status] ?? u.status),
            u.role === 'admin' && el('span', { class: 'chip accent plain' }, 'Admin'),
          ),
          el('div', { class: 'meta' }, `Đăng ký ${fmtTime(u.created_at)} · ${u.machines} PC (${u.online} online) · ${u.keys} key`),
        ),
        el('div', { class: 'actions' }, buttons),
      );
    }),
  );
}

// ================================================================ boot

hydrateIcons();
setUnauthorizedHandler(() => {
  if (state.me) {
    state.me = null;
    showAuth('Phiên đăng nhập đã hết hạn, hãy đăng nhập lại.');
  }
});

async function boot() {
  try {
    const c = await fetch('/api/config').then((r) => r.json());
    state.allowRegister = c.allowRegister !== false;
  } catch { /* keep default */ }
  try {
    await enterShell();
  } catch {
    showAuth();
  }
}
boot();

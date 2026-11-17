// Account page: PCs (machines), API keys, password, and user approval for admins.
const $ = (id) => document.getElementById(id);

let toastTimer = null;
function toast(text, ms = 2500) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    location.href = './';
    throw new Error('unauthorized');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    toast(data.error ?? `Lỗi HTTP ${res.status}`, 4000);
    throw new Error(data.error ?? res.status);
  }
  return data;
}

/** Small DOM builder: el('div', { class: 'x', onclick }, ...children). Text is always textContent. */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

function fmtTime(ms) {
  if (!ms) return 'chưa';
  const d = new Date(ms);
  const diff = Date.now() - ms;
  if (diff < 60e3) return 'vừa xong';
  if (diff < 3600e3) return `${Math.floor(diff / 60e3)} phút trước`;
  if (diff < 86400e3) return `${Math.floor(diff / 3600e3)} giờ trước`;
  return d.toLocaleDateString('vi-VN');
}

function renderList(container, items, render, emptyText) {
  container.replaceChildren(...(items.length ? items.map(render) : [el('div', { class: 'empty' }, emptyText)]));
}

// ---------------------------------------------------------------- machines

async function loadMachines() {
  const { machines } = await api('GET', '/api/machines');
  renderList(
    $('machines'),
    machines,
    (m) =>
      el(
        'div',
        { class: 'item' },
        el('span', { class: `dot${m.online ? ' on' : ''}`, title: m.online ? 'Online' : 'Offline' }),
        el(
          'div',
          { class: 'main' },
          el('div', { class: 'title' }, m.name),
          el(
            'div',
            { class: 'meta' },
            m.online ? 'Đang online' : `Offline · lần cuối ${fmtTime(m.last_seen)}`,
            m.key_name ? ` · key "${m.key_name}"` : '',
            m.last_ip ? ` · IP ${m.last_ip}` : '',
          ),
        ),
        el(
          'div',
          { class: 'actions' },
          el('button', {
            onclick: async () => {
              const name = prompt('Tên mới cho PC này:', m.name);
              if (!name || name.trim() === m.name) return;
              await api('PATCH', `/api/machines/${m.id}`, { name: name.trim() });
              loadMachines();
            },
          }, 'Đổi tên'),
          el('button', {
            class: 'danger',
            onclick: async () => {
              if (!confirm(`Gỡ PC "${m.name}" khỏi tài khoản? Nếu PC vẫn còn key hợp lệ, lần kết nối sau nó sẽ hiện lại.`)) return;
              await api('DELETE', `/api/machines/${m.id}`);
              loadMachines();
            },
          }, 'Gỡ'),
        ),
      ),
    'Chưa có PC nào. Tạo API key bên dưới rồi nhập vào app trên PC.',
  );
}

// ---------------------------------------------------------------- API keys

async function loadKeys() {
  const { keys } = await api('GET', '/api/keys');
  renderList(
    $('keys'),
    keys,
    (k) =>
      el(
        'div',
        { class: 'item' },
        el(
          'div',
          { class: 'main' },
          el('div', { class: 'title' }, k.name),
          el(
            'div',
            { class: 'meta' },
            `${k.prefix}… · ${k.machines} PC · tạo ${fmtTime(k.created_at)} · dùng lần cuối ${fmtTime(k.last_used_at)}`,
          ),
        ),
        el(
          'div',
          { class: 'actions' },
          el('button', {
            class: 'danger',
            onclick: async () => {
              if (!confirm(`Xoá key "${k.name}"? ${k.machines ? `${k.machines} PC đang dùng key này sẽ bị ngắt ngay.` : ''}`)) return;
              await api('DELETE', `/api/keys/${k.id}`);
              $('new-key').hidden = true;
              loadKeys();
              loadMachines();
            },
          }, 'Xoá'),
        ),
      ),
    'Chưa có key nào.',
  );
}

$('key-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { key } = await api('POST', '/api/keys', { name: $('key-name').value.trim() });
  $('key-name').value = '';
  $('new-key-value').textContent = key;
  $('new-key-env').textContent = `RELAY_URL=${location.origin}\nAGENT_KEY=${key}`;
  $('new-key').hidden = false;
  loadKeys();
});

$('new-key-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('new-key-value').textContent);
    toast('Đã chép key.');
  } catch {
    getSelection().selectAllChildren($('new-key-value'));
    toast('Không chép tự động được, key đã được bôi đen để bạn chép.');
  }
});

// ---------------------------------------------------------------- password

$('password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if ($('pw-new').value !== $('pw-new2').value) return toast('Hai lần nhập mật khẩu mới không khớp.');
  await api('POST', '/api/password', { current: $('pw-current').value, password: $('pw-new').value });
  e.target.reset();
  toast('Đã đổi mật khẩu. Các trình duyệt khác đã bị đăng xuất.', 4000);
});

// ---------------------------------------------------------------- admin

const STATUS_LABEL = { pending: 'Chờ duyệt', active: 'Đang dùng', disabled: 'Đã khoá' };

async function loadUsers() {
  const { users, allowRegister } = await api('GET', '/api/admin/users');
  const pending = users.filter((u) => u.status === 'pending').length;
  $('pending-count').hidden = !pending;
  $('pending-count').className = 'badge pending';
  $('pending-count').textContent = `${pending} chờ duyệt`;
  $('register-note').textContent = allowRegister
    ? 'Ai cũng đăng ký được, nhưng phải được duyệt mới đăng nhập. (Tắt đăng ký: ALLOW_REGISTER=0 trong relay.env.)'
    : 'Đăng ký đang tắt (ALLOW_REGISTER=0).';

  const act = (u, body, confirmText) => async () => {
    if (confirmText && !confirm(confirmText)) return;
    await api('PATCH', `/api/admin/users/${u.id}`, body);
    loadUsers();
  };

  renderList(
    $('users'),
    users,
    (u) => {
      const self = u.username === me?.username;
      const buttons = self
        ? [el('span', { class: 'muted' }, '(bạn)')]
        : [
            u.status === 'pending' && el('button', { class: 'primary', onclick: act(u, { status: 'active' }) }, 'Duyệt'),
            u.status === 'active' && el('button', { onclick: act(u, { status: 'disabled' }, `Khoá "${u.username}"? Mọi phiên và PC của họ bị ngắt.`) }, 'Khoá'),
            u.status === 'disabled' && el('button', { onclick: act(u, { status: 'active' }) }, 'Mở khoá'),
            u.status === 'pending' && el('button', { onclick: act(u, { status: 'disabled' }) }, 'Từ chối'),
            el('button', {
              onclick: act(u, { role: u.role === 'admin' ? 'user' : 'admin' }, u.role === 'admin' ? `Bỏ quyền admin của "${u.username}"?` : `Cho "${u.username}" làm admin?`),
            }, u.role === 'admin' ? 'Bỏ admin' : 'Làm admin'),
            el('button', {
              onclick: async () => {
                const password = prompt(`Mật khẩu mới cho "${u.username}" (tối thiểu 8 ký tự):`);
                if (!password) return;
                await api('PATCH', `/api/admin/users/${u.id}`, { password });
                toast('Đã đặt mật khẩu mới.');
              },
            }, 'Đặt mật khẩu'),
            el('button', {
              class: 'danger',
              onclick: async () => {
                if (!confirm(`Xoá hẳn tài khoản "${u.username}" cùng key và danh sách PC của họ? Không hoàn tác được.`)) return;
                await api('DELETE', `/api/admin/users/${u.id}`);
                loadUsers();
              },
            }, 'Xoá'),
          ];
      return el(
        'div',
        { class: 'item' },
        el(
          'div',
          { class: 'main' },
          el(
            'div',
            { class: 'title' },
            u.username,
            ' ',
            el('span', { class: `badge ${u.status}` }, STATUS_LABEL[u.status] ?? u.status),
            u.role === 'admin' ? ' ' : '',
            u.role === 'admin' ? el('span', { class: 'badge admin' }, 'Admin') : '',
          ),
          el('div', { class: 'meta' }, `Đăng ký ${fmtTime(u.created_at)} · ${u.machines} PC (${u.online} online) · ${u.keys} key`),
        ),
        el('div', { class: 'actions' }, buttons),
      );
    },
    'Chưa có người dùng.',
  );
}

// ---------------------------------------------------------------- init

let me = null;

$('btn-logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = './';
});

async function init() {
  ({ user: me } = await api('GET', '/api/session'));
  $('me').textContent = me.username;
  $('pw-username').value = me.username;
  await Promise.all([loadMachines(), loadKeys()]);
  if (me.role === 'admin') {
    $('admin').hidden = false;
    await loadUsers();
  }
  // Keep online/offline dots fresh.
  setInterval(() => {
    if (document.hidden) return;
    loadMachines().catch(() => {});
    if (me.role === 'admin') loadUsers().catch(() => {});
  }, 10000);
}

init().catch(() => {});

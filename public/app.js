// Web client: decodes the H.264 stream with WebCodecs onto a canvas and turns pointer/keyboard
// input into scrcpy control messages (big-endian, see server/scrcpy.js for the accepted set).

const $ = (id) => document.getElementById(id);
const canvas = $('screen');
const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
const stage = $('stage');
const overlay = $('overlay');
const overlayText = $('overlay-text');
const loginForm = $('login-form');
const logoutBtn = $('btn-logout');
const statusEl = $('status');
const statsEl = $('stats');
const deviceSelect = $('device');
const ime = $('ime');
const toastEl = $('toast');

const params = new URLSearchParams(location.search);
const nowMs = () => performance.timeOrigin + performance.now();

function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function storageSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
}

// ---------------------------------------------------------------- UI helpers

function setStatus(state, text) {
  statusEl.dataset.state = state;
  statusEl.textContent = text;
}

function showOverlay(text, { askPassword = false } = {}) {
  overlayText.textContent = text;
  loginForm.hidden = !askPassword;
  overlay.hidden = false;
  if (askPassword) $('password-input').focus();
}

let toastTimer = null;
function toast(text, ms = 2500) {
  toastEl.textContent = text;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), ms);
}

function layout() {
  const vw = canvas.width || 16;
  const vh = canvas.height || 9;
  const { width: sw, height: sh } = stage.getBoundingClientRect();
  const scale = Math.min(sw / vw, sh / vh);
  canvas.style.width = `${Math.floor(vw * scale)}px`;
  canvas.style.height = `${Math.floor(vh * scale)}px`;
  canvasRect = null;
}
new ResizeObserver(layout).observe(stage);

// ---------------------------------------------------------------- login

async function login(password) {
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (res.ok) return null;
  return (await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`;
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('password-input');
  const error = await login(input.value);
  input.value = '';
  if (error) showOverlay(error, { askPassword: true });
  else refreshDevices();
});

logoutBtn.addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  connect(null);
  lastDevicesSignature = null;
  deviceSelect.replaceChildren();
  logoutBtn.hidden = true;
  setStatus('idle', 'Đã đăng xuất');
  showOverlay('Đã đăng xuất.', { askPassword: true });
});

// ---------------------------------------------------------------- control messages

const MSG = { KEYCODE: 0, TEXT: 1, TOUCH: 2, SCROLL: 3, BACK_OR_SCREEN_ON: 4, EXPAND_NOTIFICATION_PANEL: 5, GET_CLIPBOARD: 8, SET_CLIPBOARD: 9 };
const ACTION_DOWN = 0;
const ACTION_UP = 1;
const ACTION_MOVE = 2;
const POINTER_ID_GENERIC_FINGER = -2n;
const COPY_KEY_COPY = 1;
const KEYCODE_HOME = 3;
const KEYCODE_ENTER = 66;
const KEYCODE_DEL = 67;
const KEYCODE_FORWARD_DEL = 112;
const INJECT_TEXT_MAX = 300;
const utf8 = new TextEncoder();

function send(buf) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(buf);
}

function keyMsg(action, keycode, repeat = 0, meta = 0) {
  const v = new DataView(new ArrayBuffer(14));
  v.setUint8(0, MSG.KEYCODE);
  v.setUint8(1, action);
  v.setInt32(2, keycode);
  v.setInt32(6, repeat);
  v.setInt32(10, meta);
  return v.buffer;
}

function textMsg(text) {
  const bytes = utf8.encode(text);
  const buf = new Uint8Array(5 + bytes.length);
  const v = new DataView(buf.buffer);
  v.setUint8(0, MSG.TEXT);
  v.setUint32(1, bytes.length);
  buf.set(bytes, 5);
  return buf.buffer;
}

function clipboardMsg(text, paste) {
  const bytes = utf8.encode(text);
  const buf = new Uint8Array(14 + bytes.length);
  const v = new DataView(buf.buffer);
  v.setUint8(0, MSG.SET_CLIPBOARD);
  v.setBigUint64(1, 0n); // sequence 0: no ack wanted
  v.setUint8(9, paste ? 1 : 0);
  v.setUint32(10, bytes.length);
  buf.set(bytes, 14);
  return buf.buffer;
}

function touchMsg(action, pointerId, x, y, pressure) {
  const v = new DataView(new ArrayBuffer(32));
  v.setUint8(0, MSG.TOUCH);
  v.setUint8(1, action);
  v.setBigUint64(2, BigInt.asUintN(64, pointerId));
  v.setInt32(10, x);
  v.setInt32(14, y);
  v.setUint16(18, videoW);
  v.setUint16(20, videoH);
  v.setUint16(22, pressure >= 1 ? 0xffff : Math.round(pressure * 0x10000));
  v.setInt32(24, 0); // action button
  v.setInt32(28, 0); // buttons
  return v.buffer;
}

function scrollMsg(x, y, hScroll, vScroll) {
  // Scroll amounts are signed 16-bit fixed point over [-16, 16].
  const fp = (value) => Math.max(-0x8000, Math.min(0x7fff, Math.round((value / 16) * 0x8000)));
  const v = new DataView(new ArrayBuffer(21));
  v.setUint8(0, MSG.SCROLL);
  v.setInt32(1, x);
  v.setInt32(5, y);
  v.setUint16(9, videoW);
  v.setUint16(11, videoH);
  v.setInt16(13, fp(hScroll));
  v.setInt16(15, fp(vScroll));
  v.setInt32(17, 0);
  return v.buffer;
}

const simpleMsg = (...bytes) => new Uint8Array(bytes).buffer;

function tapKey(keycode, meta = 0) {
  send(keyMsg(ACTION_DOWN, keycode, 0, meta));
  send(keyMsg(ACTION_UP, keycode, 0, meta));
}

/** ASCII goes through key injection; anything else (Vietnamese, emoji…) is pasted via the clipboard. */
function sendText(text) {
  if (!text) return;
  if (/^[\x20-\x7e]*$/.test(text)) {
    for (let i = 0; i < text.length; i += INJECT_TEXT_MAX) send(textMsg(text.slice(i, i + INJECT_TEXT_MAX)));
  } else {
    send(clipboardMsg(text, true));
  }
}

// ---------------------------------------------------------------- connection

let ws = null;
let deviceId = null;
let videoW = 0;
let videoH = 0;
let reconnectTimer = null;
let lastError = null;
let firstFrameShown = false;
let lastMessageAt = 0;
// Video frames (≥ ~10/s even on a static screen) and 1 s pongs both count; this much silence means
// the connection stalled somewhere on the path, so reconnect instead of freezing until TCP gives up.
const STALL_TIMEOUT_MS = 4000;

function connect(newDeviceId) {
  deviceId = newDeviceId;
  clearTimeout(reconnectTimer);
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  resetDecoder();
  firstFrameShown = false;
  videoW = videoH = 0;
  if (!deviceId) return;

  setStatus('starting', 'Đang kết nối');
  showOverlay('Đang kết nối…');
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const sock = new WebSocket(`${proto}//${location.host}/ws?device=${encodeURIComponent(deviceId)}`);
  sock.binaryType = 'arraybuffer';
  ws = sock;
  sock.onopen = () => {
    lastError = null;
    lastMessageAt = performance.now();
    ping();
  };
  sock.onmessage = (e) => {
    lastMessageAt = performance.now();
    if (typeof e.data === 'string') onJson(JSON.parse(e.data));
    else onVideo(e.data);
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    resetDecoder();
    firstFrameShown = false;
    setStatus('error', 'Mất kết nối');
    showOverlay(lastError ? `Lỗi: ${lastError}. Đang thử lại…` : 'Mất kết nối, đang thử lại…');
    // Re-check the session too: an expired cookie shows up as a failed WebSocket handshake.
    reconnectTimer = setTimeout(async () => {
      if (await isLoggedIn()) connect(deviceId);
    }, 1000);
  };
}

setInterval(() => {
  if (ws?.readyState !== WebSocket.OPEN || !firstFrameShown || document.visibilityState !== 'visible') return;
  if (performance.now() - lastMessageAt > STALL_TIMEOUT_MS) {
    console.warn('stream stalled, reconnecting');
    lastError = 'mất tín hiệu';
    ws.close();
  }
}, 1000);

function requestKeyframe() {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'keyframe' }));
}

function onJson(msg) {
  switch (msg.type) {
    case 'hello':
      if (msg.width) {
        videoW = msg.width;
        videoH = msg.height;
      }
      setStatus('live', msg.deviceName || msg.serial);
      if (!firstFrameShown) showOverlay('Đang chờ khung hình đầu tiên…');
      break;
    case 'status':
      if (msg.state === 'starting') {
        setStatus('starting', 'Đang khởi động');
        showOverlay('Đang khởi động scrcpy-server trên máy ảo…');
      } else if (msg.state === 'stopped') {
        lastError = msg.message || 'luồng đã dừng';
      }
      break;
    case 'pong':
      onPong(msg);
      break;
    case 'clipboard':
      navigator.clipboard?.writeText(msg.text).then(
        () => toast('Đã chép từ máy ảo vào clipboard'),
        () => toast('Không ghi được clipboard của trình duyệt'),
      );
      break;
  }
}

// ---------------------------------------------------------------- clock sync / stats

let clockOffset = null; // server clock − client clock (ms)
let rtt = null;
const syncSamples = [];

function ping() {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping', t: nowMs() }));
}
setInterval(ping, 1000);

function onPong(msg) {
  const r = nowMs() - msg.t;
  syncSamples.push({ r, offset: msg.serverTime - (msg.t + r / 2) });
  if (syncSamples.length > 10) syncSamples.shift();
  // The sample with the smallest round trip has the tightest offset bound.
  clockOffset = syncSamples.reduce((best, s) => (s.r < best.r ? s : best)).offset;
  rtt = r;
}

const stats = { frames: 0, bytes: 0, latencySum: 0, latencyCount: 0 };
setInterval(() => {
  if (ws?.readyState === WebSocket.OPEN && firstFrameShown) {
    const latency = stats.latencyCount ? Math.round(stats.latencySum / stats.latencyCount) : '–';
    const mbps = ((stats.bytes * 8) / 1e6).toFixed(1);
    statsEl.textContent = `${stats.frames} fps · ${mbps} Mbps · trễ ${latency} ms · RTT ${rtt === null ? '–' : rtt.toFixed(0)} ms · ${videoW}×${videoH}`;
    statsEl.title = 'trễ = từ lúc PC nhận khung hình tới lúc vẽ xong trên trình duyệt (chưa gồm thời gian encode trong máy ảo)';
  } else {
    statsEl.textContent = '';
  }
  stats.frames = stats.bytes = stats.latencySum = stats.latencyCount = 0;
}, 1000);

// ---------------------------------------------------------------- video decoding

const MAX_DECODE_QUEUE = 4;
let hwPreference = params.get('hw') ?? 'no-preference';
let decoder = null;
let decoderSps = null;
let waitingKey = true;
let decodeErrors = 0;
const frameTimes = new Map(); // pts → server receive time

function resetDecoder() {
  if (decoder && decoder.state !== 'closed') decoder.close();
  decoder = null;
  decoderSps = null;
  waitingKey = true;
  frameTimes.clear();
}

/** Returns the first NAL unit of the given type from an Annex B buffer (header byte included). */
function findNal(data, type) {
  let start = -1;
  for (let i = 0; i + 3 <= data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      if (start !== -1) return data.subarray(start, data[i - 1] === 0 ? i - 1 : i);
      if ((data[i + 3] & 0x1f) === type) start = i + 3;
      i += 2;
    }
  }
  return start === -1 ? null : data.subarray(start);
}

const sameBytes = (a, b) => a && b && a.length === b.length && a.every((x, i) => x === b[i]);

function configureDecoder(sps) {
  const codec = `avc1.${[sps[1], sps[2], sps[3]].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  if (decoder && decoder.state !== 'closed') decoder.close();
  decoder = new VideoDecoder({ output: onFrame, error: onDecodeError });
  try {
    decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: hwPreference });
  } catch (err) {
    showOverlay(`Trình duyệt không giải mã được ${codec}: ${err.message}`);
    return false;
  }
  decoderSps = sps.slice();
  return true;
}

function onDecodeError(err) {
  console.warn('decoder error', err);
  decodeErrors++;
  if (decodeErrors >= 3 && hwPreference !== 'prefer-software') {
    hwPreference = 'prefer-software';
    toast('Giải mã phần cứng lỗi, chuyển sang giải mã phần mềm');
  }
  resetDecoder();
  requestKeyframe();
}

function onVideo(buf) {
  stats.bytes += buf.byteLength;
  const v = new DataView(buf);
  const key = (v.getUint8(1) & 1) === 1;
  const seq = v.getUint32(2, true);
  const pts = v.getFloat64(6, true);
  const serverTime = v.getFloat64(14, true);
  const data = new Uint8Array(buf, 22);
  // Acks let the sender measure queueing on the path and drop frames before latency builds up.
  ws?.send(`{"type":"ack","seq":${seq}}`);

  if (key) {
    const sps = findNal(data, 7);
    const configured = decoder?.state === 'configured';
    if (sps && !(configured && sameBytes(sps, decoderSps)) && !configureDecoder(sps)) return;
    if (decoder?.state !== 'configured') return;
    waitingKey = false;
  } else {
    if (waitingKey || decoder?.state !== 'configured') return;
    if (decoder.decodeQueueSize > MAX_DECODE_QUEUE) {
      // Decoder is falling behind: skip to the next key frame rather than build up latency.
      waitingKey = true;
      requestKeyframe();
      return;
    }
  }

  frameTimes.set(pts, serverTime);
  if (frameTimes.size > 60) frameTimes.delete(frameTimes.keys().next().value);
  decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: pts, data }));
}

function onFrame(frame) {
  const w = frame.displayWidth;
  const h = frame.displayHeight;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    layout();
  }
  ctx.drawImage(frame, 0, 0, w, h);
  const serverTime = frameTimes.get(frame.timestamp);
  if (serverTime !== undefined) {
    frameTimes.delete(frame.timestamp);
    if (clockOffset !== null) {
      stats.latencySum += nowMs() - (serverTime - clockOffset);
      stats.latencyCount++;
    }
  }
  frame.close();
  stats.frames++;
  decodeErrors = 0;
  if (!videoW) {
    videoW = w;
    videoH = h;
  }
  if (!firstFrameShown) {
    firstFrameShown = true;
    overlay.hidden = true;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    lastMessageAt = performance.now(); // background tabs are throttled; don't call that a stall
    requestKeyframe();
  }
});

// ---------------------------------------------------------------- pointer input

const MSG_TIMED_TOUCH = 0xf0;
const activePointers = new Map(); // browser pointerId → { id: scrcpy pointer id, x, y }
let canvasRect = null; // cached: reading layout on every raw pointer event is wasteful

function videoPoint(e) {
  canvasRect ??= canvas.getBoundingClientRect();
  const r = canvasRect;
  const x = Math.round(((e.clientX - r.left) / r.width) * videoW);
  const y = Math.round(((e.clientY - r.top) / r.height) * videoH);
  return [Math.max(0, Math.min(videoW - 1, x)), Math.max(0, Math.min(videoH - 1, y))];
}

/**
 * Touch events carry the time the point was captured, so the agent can replay them with the
 * finger's real rhythm (Android derives scroll/fling velocity from event timing).
 */
function sendTouch(action, pointer, e) {
  if (!videoW) return;
  const [x, y] = videoPoint(e);
  if (action === ACTION_MOVE && x === pointer.x && y === pointer.y) return;
  pointer.x = x;
  pointer.y = y;
  const pressure = e.pointerType === 'mouse' || !e.pressure ? 1 : e.pressure;
  const buf = new Uint8Array(41);
  new DataView(buf.buffer).setFloat64(1, e.timeStamp);
  buf[0] = MSG_TIMED_TOUCH;
  buf.set(new Uint8Array(touchMsg(action, pointer.id, x, y, action === ACTION_UP ? 0 : pressure)), 9);
  send(buf.buffer);
}

canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (e.pointerType === 'mouse') {
    ime.focus({ preventScroll: true }); // route the physical keyboard to the device
    if (e.button === 2) return send(simpleMsg(MSG.BACK_OR_SCREEN_ON, ACTION_DOWN));
    if (e.button === 1) return send(keyMsg(ACTION_DOWN, KEYCODE_HOME));
    if (e.button !== 0) return;
  }
  canvas.setPointerCapture(e.pointerId);
  canvasRect = canvas.getBoundingClientRect();
  const pointer = { id: e.pointerType === 'mouse' ? POINTER_ID_GENERIC_FINGER : BigInt(e.pointerId), x: -1, y: -1 };
  activePointers.set(e.pointerId, pointer);
  sendTouch(ACTION_DOWN, pointer, e);
});

function onPointerMove(e) {
  const pointer = activePointers.get(e.pointerId);
  if (!pointer) return;
  // Replay points the browser merged, each with its own timestamp, so fast swipes keep their path.
  const points = e.getCoalescedEvents?.() ?? [];
  for (const p of points.length ? points : [e]) sendTouch(ACTION_MOVE, pointer, p);
}
// pointerrawupdate fires as soon as the OS reports movement; pointermove waits for the next frame
// (up to ~16 ms later). Use the raw stream where the browser supports it.
canvas.addEventListener('onpointerrawupdate' in window ? 'pointerrawupdate' : 'pointermove', onPointerMove);

function endPointer(e) {
  if (e.pointerType === 'mouse' && e.type === 'pointerup') {
    if (e.button === 2) return send(simpleMsg(MSG.BACK_OR_SCREEN_ON, ACTION_UP));
    if (e.button === 1) return send(keyMsg(ACTION_UP, KEYCODE_HOME));
  }
  const pointer = activePointers.get(e.pointerId);
  if (!pointer) return;
  activePointers.delete(e.pointerId);
  sendTouch(ACTION_UP, pointer, e);
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    if (!videoW) return;
    const unit = e.deltaMode === 1 ? 3 : e.deltaMode === 2 ? 0.1 : 100; // lines / pages / pixels per notch
    const clamp = (n) => Math.max(-16, Math.min(16, n));
    const [x, y] = videoPoint(e);
    send(scrollMsg(x, y, clamp(-e.deltaX / unit), clamp(-e.deltaY / unit)));
  },
  { passive: false },
);

// ---------------------------------------------------------------- keyboard input

const KEYCODES = {
  Enter: 66, NumpadEnter: 66, Backspace: 67, Delete: 112, Tab: 61, Escape: 111, Space: 62,
  ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22,
  Home: 122, End: 123, PageUp: 92, PageDown: 93, Insert: 124,
  ShiftLeft: 59, ShiftRight: 60, ControlLeft: 113, ControlRight: 114, AltLeft: 57, AltRight: 58,
  MetaLeft: 117, MetaRight: 118, CapsLock: 115,
  Minus: 69, Equal: 70, BracketLeft: 71, BracketRight: 72, Backslash: 73, Semicolon: 74,
  Quote: 75, Backquote: 68, Comma: 55, Period: 56, Slash: 76,
  NumpadDivide: 154, NumpadMultiply: 155, NumpadSubtract: 156, NumpadAdd: 157, NumpadDecimal: 158,
};
for (let i = 0; i < 26; i++) KEYCODES[`Key${String.fromCharCode(65 + i)}`] = 29 + i;
for (let i = 0; i < 10; i++) {
  KEYCODES[`Digit${i}`] = 7 + i;
  KEYCODES[`Numpad${i}`] = 144 + i;
}
for (let i = 1; i <= 12; i++) KEYCODES[`F${i}`] = 130 + i;

function metaState(e) {
  return (
    (e.shiftKey ? 0x41 : 0) | // META_SHIFT_ON | META_SHIFT_LEFT_ON
    (e.altKey ? 0x12 : 0) | // META_ALT_ON | META_ALT_LEFT_ON
    (e.ctrlKey ? 0x3000 : 0) | // META_CTRL_ON | META_CTRL_LEFT_ON
    (e.metaKey ? 0x30000 : 0) | // META_META_ON | META_META_LEFT_ON
    (e.getModifierState?.('CapsLock') ? 0x100000 : 0)
  );
}

let keyMode = storageGet('ldr-keymode') === 'raw' ? 'raw' : 'text';
const keyModeBtn = $('btn-keymode');
function renderKeyMode() {
  keyModeBtn.textContent = keyMode === 'raw' ? 'Phím game' : 'Văn bản';
  keyModeBtn.setAttribute('aria-pressed', String(keyMode === 'raw'));
}
renderKeyMode();
keyModeBtn.addEventListener('click', () => {
  keyMode = keyMode === 'raw' ? 'text' : 'raw';
  storageSet('ldr-keymode', keyMode);
  renderKeyMode();
  toast(keyMode === 'raw' ? 'Phím game: gửi mã phím thô (WASD…)' : 'Văn bản: gửi ký tự, hỗ trợ tiếng Việt');
});

// The textarea keeps one sentinel character so phone keyboards still emit a delete when "empty".
const SENTINEL = '_';
function resetIme() {
  ime.value = SENTINEL;
  ime.setSelectionRange(1, 1);
}
resetIme();

const pressedKeys = new Map(); // code → android keycode

ime.addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  const ctrlOrMeta = e.ctrlKey || e.metaKey;
  if (keyMode === 'text') {
    if (ctrlOrMeta && e.code === 'KeyV') return; // handled by the paste event
    if (ctrlOrMeta && e.code === 'KeyC') {
      e.preventDefault();
      send(simpleMsg(MSG.GET_CLIPBOARD, COPY_KEY_COPY));
      return;
    }
    if (e.key.length === 1 && !ctrlOrMeta && !e.altKey) return; // printable: arrives as an input event
  }
  const keycode = KEYCODES[e.code];
  if (keycode === undefined) return;
  e.preventDefault();
  pressedKeys.set(e.code, keycode);
  send(keyMsg(ACTION_DOWN, keycode, e.repeat ? 1 : 0, metaState(e)));
});

ime.addEventListener('keyup', (e) => {
  const keycode = pressedKeys.get(e.code);
  if (keycode === undefined) return;
  e.preventDefault();
  pressedKeys.delete(e.code);
  send(keyMsg(ACTION_UP, keycode, 0, metaState(e)));
});

ime.addEventListener('blur', () => {
  for (const keycode of pressedKeys.values()) send(keyMsg(ACTION_UP, keycode));
  pressedKeys.clear();
});

ime.addEventListener('input', (e) => {
  if (e.isComposing) return;
  switch (e.inputType) {
    case 'insertText':
    case 'insertReplacementText':
      sendText(e.data ?? ime.value.replace(SENTINEL, ''));
      break;
    case 'insertLineBreak':
    case 'insertParagraph':
      tapKey(KEYCODE_ENTER);
      break;
    case 'deleteContentBackward':
      tapKey(KEYCODE_DEL);
      break;
    case 'deleteContentForward':
      tapKey(KEYCODE_FORWARD_DEL);
      break;
    // Composition results are sent on compositionend; pastes by the paste event.
  }
  resetIme();
});

ime.addEventListener('compositionend', (e) => {
  sendText(e.data);
  resetIme();
});

ime.addEventListener('paste', (e) => {
  e.preventDefault();
  const text = e.clipboardData?.getData('text/plain');
  if (text) send(clipboardMsg(text, true));
});

// ---------------------------------------------------------------- toolbar

const nav = $('nav');
nav.addEventListener('mousedown', (e) => e.preventDefault()); // keep keyboard focus on the device

for (const btn of nav.querySelectorAll('button[data-key]')) {
  const keycode = Number(btn.dataset.key);
  let down = false;
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    btn.setPointerCapture(e.pointerId);
    down = true;
    send(keyMsg(ACTION_DOWN, keycode));
  });
  const release = () => {
    if (!down) return;
    down = false;
    send(keyMsg(ACTION_UP, keycode));
  };
  btn.addEventListener('pointerup', release);
  btn.addEventListener('pointercancel', release);
}

$('btn-keyboard').addEventListener('click', () => ime.focus());
$('btn-notify').addEventListener('click', () => send(simpleMsg(MSG.EXPAND_NOTIFICATION_PANEL)));
$('btn-fullscreen').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
});

// ---------------------------------------------------------------- devices

let devicesTimer = null;
let lastDevicesSignature = null;

function deviceLabel(d, multiAgent) {
  const agent = multiAgent && d.agent ? `${d.agent} · ` : '';
  const index = d.index !== null ? ` #${d.index}` : '';
  const state = !d.running ? ' — đang tắt' : !d.adb ? ' — chưa bật ADB' : '';
  return `${agent}${d.name}${index}${state}`;
}

function requireLogin(message = 'Nhập mật khẩu để vào.') {
  clearTimeout(devicesTimer);
  connect(null);
  logoutBtn.hidden = true;
  setStatus('idle', 'Chưa đăng nhập');
  showOverlay(message, { askPassword: true });
}

async function isLoggedIn() {
  try {
    const res = await fetch('/api/session');
    if (res.status === 401) {
      requireLogin('Phiên đăng nhập đã hết hạn.');
      return false;
    }
  } catch {
    // Server unreachable: keep retrying the stream.
  }
  return true;
}

async function refreshDevices() {
  clearTimeout(devicesTimer);
  let body;
  try {
    const res = await fetch('/api/devices');
    if (res.status === 401) return requireLogin();
    body = await res.json();
  } catch {
    showOverlay('Không kết nối được server.');
    devicesTimer = setTimeout(refreshDevices, 3000);
    return;
  }
  logoutBtn.hidden = false;

  const { devices, agents } = body;
  const multiAgent = (agents?.length ?? 0) > 1;
  const signature = JSON.stringify(devices);
  if (signature !== lastDevicesSignature) {
    // Re-rendering closes an open dropdown, so only do it when something changed.
    lastDevicesSignature = signature;
    deviceSelect.replaceChildren(
      ...devices.map((d) => {
        const opt = new Option(deviceLabel(d, multiAgent), d.id ?? '');
        opt.disabled = !d.adb;
        return opt;
      }),
    );
  }

  const ready = devices.filter((d) => d.adb);
  if (deviceId && ready.some((d) => d.id === deviceId)) {
    deviceSelect.value = deviceId;
  } else if (ready.length) {
    const wanted = params.get('device') ?? storageGet('ldr-device');
    const pick = ready.find((d) => d.id === wanted) ?? ready[0];
    deviceSelect.value = pick.id;
    connect(pick.id);
  } else {
    connect(null);
    setStatus('idle', 'Chưa có máy ảo');
    let message = 'Không tìm thấy máy ảo LDPlayer / thiết bị adb nào.';
    if (agents && agents.length === 0) message = 'PC chưa kết nối tới relay (agent đang offline).';
    else if (devices.length) {
      message = 'Chưa có máy ảo nào bật ADB. Trong LDPlayer: Cài đặt → Cài đặt khác → Gỡ lỗi ADB → "Mở kết nối cục bộ", lưu rồi khởi động lại máy ảo.';
    }
    showOverlay(message);
  }
  devicesTimer = setTimeout(refreshDevices, ready.length ? 15000 : 3000);
}

deviceSelect.addEventListener('change', () => {
  storageSet('ldr-device', deviceSelect.value);
  connect(deviceSelect.value || null);
});

async function init() {
  if (!('VideoDecoder' in window)) {
    setStatus('error', 'Không hỗ trợ');
    showOverlay(
      window.isSecureContext
        ? 'Trình duyệt này không hỗ trợ WebCodecs. Hãy dùng Chrome, Edge, Safari 16.4+ hoặc Firefox 130+.'
        : 'WebCodecs chỉ chạy trên https hoặc localhost. Hãy mở trang bằng https://…',
    );
    return;
  }
  // Local mode prints a ?token= link; exchange it for a session cookie and drop it from the URL.
  const token = params.get('token');
  if (token) {
    params.delete('token');
    const qs = params.toString();
    history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : ''));
    await login(token);
  }
  refreshDevices();
}

init();

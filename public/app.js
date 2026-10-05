// Web client. Video arrives over WebRTC (RTP, played by a <video> element) when it can connect,
// otherwise over the WebSocket (H.264 decoded with WebCodecs onto a canvas). Pointer/keyboard input
// becomes scrcpy control messages (big-endian, see src/scrcpy.js in ldplayer-remote-client).

const $ = (id) => document.getElementById(id);
const canvas = $('screen');
const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
const stage = $('stage');
const surface = $('surface');
const video = $('video');
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
  const vw = videoW || canvas.width || 16;
  const vh = videoH || canvas.height || 9;
  const cs = getComputedStyle(stage); // padding keeps clear of the notch in full-screen mode
  const sw = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const sh = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const scale = Math.min(sw / vw, sh / vh);
  surface.style.width = `${Math.floor(vw * scale)}px`;
  surface.style.height = `${Math.floor(vh * scale)}px`;
  surfaceRect = null;
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
  if (rtcActive && dc?.readyState === 'open') dc.send(buf);
  else if (ws?.readyState === WebSocket.OPEN) ws.send(buf);
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
  stopRtc();
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
    flushDiag();
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
    stopRtc();
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
    diag({ event: 'ws-stall', transport: rtcActive ? 'rtc' : 'ws' });
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
      layout();
      if (msg.rtc) {
        rtcIceServers = msg.rtc.iceServers;
        startRtc();
      }
      break;
    case 'rtc-offer':
      onRtcOffer(msg).catch((err) => stopRtc(`WebRTC lỗi: ${err.message}`, true));
      break;
    case 'rtc-candidate':
      pc?.addIceCandidate({ candidate: msg.candidate, sdpMid: msg.mid }).catch(() => {});
      break;
    case 'rtc-failed':
      if (pc) stopRtc(`WebRTC không kết nối được (${msg.message})`);
      rtcRetryAt = Date.now() + RTC_RETRY_MS;
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
setInterval(async () => {
  if (ws?.readyState === WebSocket.OPEN && rtcActive) {
    statsEl.textContent = await rtcStatsLine();
  } else if (ws?.readyState === WebSocket.OPEN && firstFrameShown) {
    const latency = stats.latencyCount ? Math.round(stats.latencySum / stats.latencyCount) : '–';
    const mbps = ((stats.bytes * 8) / 1e6).toFixed(1);
    statsEl.textContent = `WS · ${stats.frames} fps · ${mbps} Mbps · trễ ${latency} ms · RTT ${rtt === null ? '–' : rtt.toFixed(0)} ms · ${videoW}×${videoH}`;
    statsEl.title = 'trễ = từ lúc PC nhận khung hình tới lúc vẽ xong trên trình duyệt (chưa gồm thời gian encode trong máy ảo)';
  } else {
    statsEl.textContent = '';
  }
  stats.frames = stats.bytes = stats.latencySum = stats.latencyCount = 0;
  // Retry WebRTC periodically after a failure.
  if (ws?.readyState === WebSocket.OPEN && !pc && rtcIceServers && Date.now() >= rtcRetryAt) startRtc();
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
  if (rtcActive) return;
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
  markRendered();
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
    wsJson({ type: rtcActive ? 'keyframe' : 'resume' });
  } else if (!rtcActive) {
    wsJson({ type: 'pause' }); // a throttled tab cannot keep up; the agent stops sending
  }
});

// ---------------------------------------------------------------- WebRTC

// Video over RTP/UDP (peer-to-peer, or via the relay's TURN server) does not stall on packet loss
// the way a TCP WebSocket does. Signaling rides on the existing WebSocket; input uses a DataChannel.
const RTC_ENABLED = params.get('rtc') !== '0' && 'RTCPeerConnection' in window;
const RTC_FIRST_FRAME_TIMEOUT_MS = 12000;
const RTC_RETRY_MS = 30000;
let pc = null;
let dc = null;
let rtcActive = false;
let rtcTimer = null;
let rtcRetryAt = 0;
let rtcIceServers = null;
let rtcLast = null; // previous getStats() sample
let rtcStalledSeconds = 0;

function wsJson(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function startRtc() {
  if (!RTC_ENABLED || pc || !rtcIceServers || Date.now() < rtcRetryAt) return;
  pc = new RTCPeerConnection({ iceServers: rtcIceServers });
  const peer = pc;
  peer.onicecandidate = (e) => {
    if (e.candidate?.candidate) wsJson({ type: 'rtc-candidate', candidate: e.candidate.candidate, mid: e.candidate.sdpMid });
  };
  peer.ontrack = (e) => {
    // Play each frame as soon as it is decodable: no extra jitter buffering.
    try { e.receiver.jitterBufferTarget = 0; } catch { /* unsupported */ }
    try { e.receiver.playoutDelayHint = 0; } catch { /* unsupported */ }
    video.srcObject = e.streams[0] ?? new MediaStream([e.track]);
    video.play().catch(() => {});
    waitFirstRtcFrame(peer);
  };
  peer.ondatachannel = (e) => {
    dc = e.channel;
    dc.binaryType = 'arraybuffer';
  };
  peer.onconnectionstatechange = () => {
    if (peer === pc && peer.connectionState === 'failed') stopRtc('Kết nối WebRTC bị ngắt', true);
  };
  rtcTimer = setTimeout(() => {
    if (peer === pc && !rtcActive) stopRtc('WebRTC không kết nối được', true);
  }, RTC_FIRST_FRAME_TIMEOUT_MS);
  wsJson({ type: 'rtc-start' });
}

async function onRtcOffer(msg) {
  if (!pc) return;
  await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  wsJson({ type: 'rtc-answer', sdp: pc.localDescription.sdp });
}

function waitFirstRtcFrame(peer) {
  const onFirst = () => {
    if (peer !== pc || rtcActive) return;
    rtcActive = true;
    clearTimeout(rtcTimer);
    wsJson({ type: 'rtc-ready' });
    resetDecoder();
    canvas.hidden = true;
    video.hidden = false;
    if (!videoW) {
      videoW = video.videoWidth;
      videoH = video.videoHeight;
    }
    layout();
    firstFrameShown = true;
    overlay.hidden = true;
    markRendered();
    trackRtcFrames(peer);
    diag({ event: 'rtc-connected' });
  };
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(onFirst);
  else video.addEventListener('playing', onFirst, { once: true });
}

/** Tears WebRTC down; with `notify`, tells the agent to resume WebSocket video and backs off. */
function stopRtc(reason = null, notify = false) {
  clearTimeout(rtcTimer);
  const wasActive = rtcActive;
  rtcActive = false;
  rtcLast = null;
  rtcStalledSeconds = 0;
  if (pc) {
    pc.close();
    pc = null;
  }
  dc = null;
  video.srcObject = null;
  video.hidden = true;
  canvas.hidden = false;
  if (notify) {
    wsJson({ type: 'rtc-stop' });
    rtcRetryAt = Date.now() + RTC_RETRY_MS;
  }
  if (reason) {
    toast(`${reason}, chuyển sang WebSocket`);
    diag({ event: 'rtc-fallback', reason, path: rtcPathGuess });
  }
  renderTracking = false;
  if (wasActive && ws) {
    firstFrameShown = false;
    requestKeyframe();
  }
}

async function rtcStatsLine() {
  const report = await pc.getStats();
  let inbound = null;
  let pairId = null;
  report.forEach((s) => {
    if (s.type === 'inbound-rtp' && s.kind === 'video') inbound = s;
    if (s.type === 'transport' && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId;
  });
  if (!pairId) {
    report.forEach((s) => {
      if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pairId = s.id;
    });
  }
  const pair = pairId ? report.get(pairId) : null;
  const local = pair ? report.get(pair.localCandidateId) : null;
  const path = local?.candidateType === 'relay' ? 'TURN' : 'P2P';
  rtcPathGuess = path;
  if (pair?.currentRoundTripTime !== undefined) rtt = pair.currentRoundTripTime * 1000;
  if (!inbound) return `WebRTC ${path} · đang chờ video`;

  const prev = rtcLast;
  rtcLast = inbound;
  if (!prev) return `WebRTC ${path}`;
  const bytes = inbound.bytesReceived - prev.bytesReceived;
  const decoded = (inbound.framesDecoded ?? 0) - (prev.framesDecoded ?? 0);
  const emitted = (inbound.jitterBufferEmittedCount ?? 0) - (prev.jitterBufferEmittedCount ?? 0);
  const buffer = emitted > 0 ? Math.round((((inbound.jitterBufferDelay ?? 0) - (prev.jitterBufferDelay ?? 0)) / emitted) * 1000) : '–';
  const lost = (inbound.packetsLost ?? 0) - (prev.packetsLost ?? 0);

  // Data arriving but nothing decoding: the decoder lost its reference, ask for a key frame.
  // Nothing arriving at all for a while: the path is dead, fall back to the WebSocket.
  rtcStalledSeconds = decoded === 0 ? rtcStalledSeconds + 1 : 0;
  const received = (inbound.packetsReceived ?? 0) - (prev.packetsReceived ?? 0);
  net = {
    path,
    fps: decoded,
    mbps: Number(((bytes * 8) / 1e6).toFixed(2)),
    lost,
    lossPct: received + lost > 0 ? Number(((lost / (received + lost)) * 100).toFixed(1)) : 0,
    rtt: rtt === null ? null : Math.round(rtt),
    buffer: typeof buffer === 'number' ? buffer : null,
  };
  if (!renderTracking && decoded === 0 && bytes > 0 && rtcStalledSeconds >= 2) requestKeyframe();
  if (bytes === 0 && rtcStalledSeconds >= 5) stopRtc('Mất tín hiệu WebRTC', true);

  return `WebRTC ${path} · ${decoded} fps · ${((bytes * 8) / 1e6).toFixed(1)} Mbps · đệm ${buffer} ms · mất ${lost} gói · RTT ${rtt === null ? '–' : rtt.toFixed(0)} ms · ${videoW}×${videoH}`;
}

video.addEventListener('resize', () => {
  if (rtcActive && video.videoWidth && !videoW) {
    videoW = video.videoWidth;
    videoH = video.videoHeight;
  }
  layout();
});

// ---------------------------------------------------------------- freeze detection / diagnostics

// scrcpy repeats the last frame every 100 ms on a static screen, so a healthy stream renders at
// least ~10 frames/s. Longer than this without a rendered frame is a freeze: ask for a key frame
// right away (and again every second while it lasts) instead of waiting for the stats tick.
const FREEZE_MS = 500;
const FREEZE_KEYFRAME_EVERY_MS = 1000;
const SUMMARY_EVERY_MS = 60000;
let lastRenderAt = 0;
let renderTracking = false; // WebRTC: true once requestVideoFrameCallback reports frames
let freeze = null; // { start, transport, keyframes, lastKeyAt }
let rtcPathGuess = null;
let net = {}; // latest network numbers from rtcStatsLine()
const minute = { freezes: 0, freezeMs: 0 };
const diagQueue = [];

/** Sends a diagnostic event to the agent log (queued while the socket is reconnecting). */
function diag(event) {
  diagQueue.push({ type: 'diag', at: Date.now(), ...event });
  if (diagQueue.length > 20) diagQueue.shift();
  flushDiag();
}

function flushDiag() {
  while (diagQueue.length && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(diagQueue.shift()));
}

function markRendered() {
  const t = performance.now();
  if (freeze) {
    const f = freeze;
    freeze = null;
    const ms = Math.round(t - f.start);
    minute.freezes++;
    minute.freezeMs += ms;
    diag({ event: 'freeze', ms, transport: f.transport, keyframes: f.keyframes, ...(f.transport === 'rtc' ? net : { rtt: rtt === null ? null : Math.round(rtt) }) });
  }
  lastRenderAt = t;
}

function trackRtcFrames(peer) {
  if (!video.requestVideoFrameCallback) return;
  renderTracking = true;
  const onFrame = () => {
    if (peer !== pc) return;
    markRendered();
    video.requestVideoFrameCallback(onFrame);
  };
  video.requestVideoFrameCallback(onFrame);
}

setInterval(() => {
  const watching = firstFrameShown && ws?.readyState === WebSocket.OPEN && document.visibilityState === 'visible' && (!rtcActive || renderTracking);
  if (!watching) {
    freeze = null;
    return;
  }
  const t = performance.now();
  if (!freeze && t - lastRenderAt > FREEZE_MS) {
    freeze = { start: lastRenderAt, transport: rtcActive ? 'rtc' : 'ws', keyframes: 0, lastKeyAt: 0 };
  }
  if (freeze && t - freeze.lastKeyAt > FREEZE_KEYFRAME_EVERY_MS) {
    freeze.lastKeyAt = t;
    freeze.keyframes++;
    requestKeyframe();
  }
}, 100);

// Once a minute, a one-line summary of how the connection behaved.
setInterval(() => {
  if (!firstFrameShown || ws?.readyState !== WebSocket.OPEN) return;
  diag({ event: 'summary', transport: rtcActive ? 'rtc' : 'ws', freezes: minute.freezes, freezeMs: minute.freezeMs, ...(rtcActive ? net : { rtt: rtt === null ? null : Math.round(rtt) }) });
  minute.freezes = 0;
  minute.freezeMs = 0;
}, SUMMARY_EVERY_MS);

// ---------------------------------------------------------------- pointer input

const MSG_TIMED_TOUCH = 0xf0;
const activePointers = new Map(); // browser pointerId → { id: scrcpy pointer id, x, y }
let surfaceRect = null; // cached: reading layout on every raw pointer event is wasteful

function videoPoint(e) {
  surfaceRect ??= surface.getBoundingClientRect();
  const r = surfaceRect;
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

surface.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (e.pointerType === 'mouse') {
    ime.focus({ preventScroll: true }); // route the physical keyboard to the device
    if (e.button === 2) return send(simpleMsg(MSG.BACK_OR_SCREEN_ON, ACTION_DOWN));
    if (e.button === 1) return send(keyMsg(ACTION_DOWN, KEYCODE_HOME));
    if (e.button !== 0) return;
  }
  surface.setPointerCapture(e.pointerId);
  surfaceRect = surface.getBoundingClientRect();
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
surface.addEventListener('onpointerrawupdate' in window ? 'pointerrawupdate' : 'pointermove', onPointerMove);

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
surface.addEventListener('pointerup', endPointer);
surface.addEventListener('pointercancel', endPointer);
surface.addEventListener('contextmenu', (e) => e.preventDefault());

surface.addEventListener(
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
// Real fullscreen where the browser allows it (desktop, Android, iPad). iPhone Safari has no
// Fullscreen API for pages, so there (and if the request fails) hide the bars instead; opened
// from the home screen the page already runs without Safari's UI.
const fullscreenApi = {
  element: () => document.fullscreenElement ?? document.webkitFullscreenElement,
  request: (el) => (el.requestFullscreen ?? el.webkitRequestFullscreen)?.call(el),
  exit: () => (document.exitFullscreen ?? document.webkitExitFullscreen)?.call(document),
};

function setImmersive(on) {
  document.body.classList.toggle('immersive', on);
  storageSet('ldr-immersive', on ? '1' : '0');
}

async function toggleFullscreen() {
  if (fullscreenApi.element()) return fullscreenApi.exit();
  if (document.body.classList.contains('immersive')) return setImmersive(false);
  try {
    const pending = fullscreenApi.request(document.documentElement);
    if (!pending && !fullscreenApi.element()) throw new Error('unsupported');
    await pending;
  } catch {
    setImmersive(true);
  }
}

$('btn-fullscreen').addEventListener('click', toggleFullscreen);
$('float-exit').addEventListener('click', toggleFullscreen);
$('float-back').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  send(keyMsg(ACTION_DOWN, 4));
});
$('float-back').addEventListener('pointerup', () => send(keyMsg(ACTION_UP, 4)));
$('float-bar').addEventListener('mousedown', (e) => e.preventDefault()); // keep keyboard focus

// A home-screen app remembers the full-screen choice between launches.
const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
if (standalone && storageGet('ldr-immersive') === '1') setImmersive(true);

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

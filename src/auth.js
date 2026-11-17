// Account auth for the relay: username + password, server-side sessions in SQLite (so logout,
// disabling a user or changing a password takes effect at once), login/registration rate limits,
// and an Origin check for cookie-authenticated WebSockets.
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);
const COOKIE_NAME = 'ldr_sid';
export const SESSION_MS = 30 * 24 * 3600 * 1000;
const SCRYPT_PARAMS = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

// Per client IP only: a server-wide limit would let anyone lock every user out with a few bad
// logins. nginx overwrites X-Forwarded-For with the real address, so the IP can't be spoofed.
const IP_MAX_ATTEMPTS = 8;
const IP_WINDOW_MS = 15 * 60 * 1000;
const REGISTER_MAX_PER_IP = 5;
const REGISTER_WINDOW_MS = 60 * 60 * 1000;

export const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;
export const MIN_PASSWORD = 8;

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scrypt(password.normalize('NFC'), salt, 32, SCRYPT_PARAMS);
  const { N, r, p } = SCRYPT_PARAMS;
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPasswordHash(password, stored) {
  const [alg, N, r, p, salt, expected] = String(stored).split('$');
  if (alg !== 'scrypt' || !salt || !expected) return false;
  const expectedBuf = Buffer.from(expected, 'base64');
  const hash = await scrypt(String(password).normalize('NFC'), Buffer.from(salt, 'base64'), expectedBuf.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT_PARAMS.maxmem,
  });
  return timingSafeEqual(hash, expectedBuf);
}

/** Checked against when the username does not exist, so both cases take the same time. */
const DUMMY_HASH = await hashPassword(randomBytes(16).toString('hex'));

export function validateCredentials(username, password) {
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    return 'Tên đăng nhập 3–32 ký tự, chỉ gồm chữ không dấu, số, dấu . _ -';
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD || password.length > 256) {
    return `Mật khẩu cần ít nhất ${MIN_PASSWORD} ký tự.`;
  }
  return null;
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function readJsonBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        resolve(body && typeof body === 'object' ? body : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

export function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class WindowCounter {
  constructor(max, windowMs) {
    this.max = max;
    this.windowMs = windowMs;
    this.map = new Map(); // key → { count, resetAt }
  }

  get(key) {
    const e = this.map.get(key);
    if (e && e.resetAt < Date.now()) this.map.delete(key);
    return this.map.get(key)?.count ?? 0;
  }

  full(key) {
    return this.get(key) >= this.max;
  }

  hit(key) {
    const e = this.map.get(key) ?? { count: 0, resetAt: Date.now() + this.windowMs };
    e.count++;
    this.map.set(key, e);
  }

  clear(key) {
    this.map.delete(key);
  }
}

export class Auth {
  /**
   * @param {object} o
   * @param {import('./db.js').Store} o.store
   * @param {boolean} [o.trustProxy] honour X-Forwarded-For / X-Forwarded-Proto (behind nginx)
   * @param {boolean} [o.allowRegister]
   */
  constructor({ store, trustProxy = false, allowRegister = true }) {
    this.store = store;
    this.trustProxy = trustProxy;
    this.allowRegister = allowRegister;
    this.ipAttempts = new WindowCounter(IP_MAX_ATTEMPTS, IP_WINDOW_MS);
    this.registrations = new WindowCounter(REGISTER_MAX_PER_IP, REGISTER_WINDOW_MS);
  }

  clientIp(req) {
    if (this.trustProxy) {
      const fwd = req.headers['x-forwarded-for'];
      if (fwd) return fwd.split(',')[0].trim();
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  isHttps(req) {
    return Boolean(req.socket.encrypted) || (this.trustProxy && req.headers['x-forwarded-proto'] === 'https');
  }

  token(req) {
    return parseCookies(req.headers.cookie)[COOKIE_NAME] ?? null;
  }

  /** The logged-in, active user for this request, or undefined. */
  user(req) {
    return this.store.sessionUser(this.token(req));
  }

  /** Blocks cross-site pages from opening a WebSocket with the user's cookie. */
  isSameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return false;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  cookie(req, value, maxAgeSec) {
    const secure = this.isHttps(req) ? '; Secure' : '';
    return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure}`;
  }

  startSession(req, res, user, body = {}) {
    const token = this.store.createSession(user.id, SESSION_MS, this.clientIp(req));
    sendJson(res, 200, { ok: true, ...body }, { 'Set-Cookie': this.cookie(req, token, SESSION_MS / 1000) });
  }

  async handleLogin(req, res) {
    const ip = this.clientIp(req);
    if (this.ipAttempts.full(ip)) {
      return sendJson(res, 429, { error: 'Sai mật khẩu quá nhiều lần, thử lại sau 15 phút.' });
    }
    // Counted before the (slow) password hash, so parallel requests can't slip past the limit;
    // a successful login clears it again.
    this.ipAttempts.hit(ip);
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: 'bad request' });
    }
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' && body.password.length <= 256 ? body.password : '';
    const user = username ? this.store.userByName(username) : undefined;
    const ok = (await verifyPasswordHash(password, user?.password_hash ?? DUMMY_HASH)) && Boolean(user);
    if (!ok) {
      console.warn(`login failed for "${username.slice(0, 40)}" from ${ip}`);
      await sleep(400);
      return sendJson(res, 401, { error: 'Sai tên đăng nhập hoặc mật khẩu.' });
    }
    this.ipAttempts.clear(ip);
    if (user.status === 'pending') return sendJson(res, 403, { error: 'Tài khoản đang chờ admin duyệt.' });
    if (user.status !== 'active') return sendJson(res, 403, { error: 'Tài khoản đã bị khoá.' });
    console.log(`login "${user.username}" from ${ip}`);
    this.startSession(req, res, user);
  }

  async handleRegister(req, res) {
    if (!this.allowRegister) return sendJson(res, 403, { error: 'Server đang tắt đăng ký.' });
    const ip = this.clientIp(req);
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: 'bad request' });
    }
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const error = validateCredentials(username, body.password);
    if (error) return sendJson(res, 400, { error });
    // Check and count in one synchronous step, before the slow hash, so parallel requests can't
    // get past the limit.
    if (this.registrations.full(ip)) return sendJson(res, 429, { error: 'Đăng ký quá nhiều lần, thử lại sau.' });
    this.registrations.hit(ip);
    if (this.store.userByName(username)) return sendJson(res, 409, { error: 'Tên đăng nhập đã có người dùng.' });
    const passwordHash = await hashPassword(body.password);
    if (this.store.userByName(username)) return sendJson(res, 409, { error: 'Tên đăng nhập đã có người dùng.' });
    // Every web sign-up waits for an admin. Admins are only created from the server shell
    // (ldplayer-relay-admin), so a fresh server can't be claimed by whoever registers first.
    const user = this.store.createUser({ username, passwordHash, role: 'user', status: 'pending' });
    console.log(`registered "${user.username}" (pending) from ${ip}`);
    sendJson(res, 200, { ok: true, status: 'pending' });
  }

  handleLogout(req, res) {
    const token = this.token(req);
    if (token) this.store.deleteSession(token);
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': this.cookie(req, '', 0) });
  }
}

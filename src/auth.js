// Single-password auth shared by the local server and the relay: a stateless HMAC-signed session
// cookie, login rate limiting, and an Origin check for cookie-authenticated WebSockets.
import { createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);
const COOKIE_NAME = 'ldr_session';
const SESSION_MS = 30 * 24 * 3600 * 1000;
const SCRYPT_PARAMS = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

const IP_MAX_FAILURES = 5;
const IP_WINDOW_MS = 15 * 60 * 1000;
const GLOBAL_MAX_FAILURES = 30;
const GLOBAL_WINDOW_MS = 60 * 60 * 1000;

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

/** Derives a stable cookie-signing key from any secret string. */
export const deriveKey = (secret) => createHash('sha256').update(`ldr-session:${secret}`).digest();

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function readJsonBody(req, limit = 4096) {
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
        resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}'));
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

export class Auth {
  /**
   * @param {object} o
   * @param {(password: string) => Promise<boolean>|boolean} o.verify
   * @param {Buffer} o.key cookie signing key (see deriveKey)
   * @param {boolean} [o.trustProxy] honour X-Forwarded-For / X-Forwarded-Proto (behind Caddy)
   */
  constructor({ verify, key, trustProxy = false }) {
    this.verify = verify;
    this.key = key;
    this.trustProxy = trustProxy;
    this.failures = new Map(); // ip → { count, resetAt }
    this.globalFailures = { count: 0, resetAt: 0 };
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

  sign(expires) {
    return createHmac('sha256', this.key).update(String(expires)).digest('base64url');
  }

  isAuthenticated(req) {
    const value = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (!value) return false;
    const [expires, sig] = value.split('.');
    return Boolean(sig) && safeEqual(sig, this.sign(expires)) && Number(expires) > Date.now();
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

  lockedOut(ip) {
    const t = Date.now();
    if (this.globalFailures.resetAt < t) this.globalFailures = { count: 0, resetAt: t + GLOBAL_WINDOW_MS };
    const entry = this.failures.get(ip);
    if (entry && entry.resetAt < t) this.failures.delete(ip);
    return (this.failures.get(ip)?.count ?? 0) >= IP_MAX_FAILURES || this.globalFailures.count >= GLOBAL_MAX_FAILURES;
  }

  recordFailure(ip) {
    const t = Date.now();
    const entry = this.failures.get(ip) ?? { count: 0, resetAt: t + IP_WINDOW_MS };
    entry.count++;
    this.failures.set(ip, entry);
    this.globalFailures.count++;
  }

  async handleLogin(req, res) {
    const ip = this.clientIp(req);
    if (this.lockedOut(ip)) {
      return sendJson(res, 429, { error: 'Sai mật khẩu quá nhiều lần, thử lại sau 15 phút.' });
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, { error: 'bad request' });
    }
    const ok = typeof body.password === 'string' && body.password.length <= 256 && (await this.verify(body.password));
    if (!ok) {
      this.recordFailure(ip);
      console.warn(`login failed from ${ip}`);
      await sleep(500);
      return sendJson(res, 401, { error: 'Sai mật khẩu.' });
    }
    this.failures.delete(ip);
    const expires = Date.now() + SESSION_MS;
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': this.cookie(req, `${expires}.${this.sign(expires)}`, SESSION_MS / 1000) });
  }

  handleLogout(req, res) {
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': this.cookie(req, '', 0) });
  }
}

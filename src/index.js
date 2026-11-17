// Relay (runs on a VPS): serves the web UI to logged-in users. Each user's PCs (agents) keep an
// outbound control connection authenticated with one of that user's API keys; for each viewer the
// agent dials back a dedicated channel socket, and the relay pipes viewer ⇄ channel byte-for-byte.
import { createServer } from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Auth, hashPassword, readJsonBody, safeEqual, sendJson, validateCredentials, verifyPasswordHash } from './auth.js';
import { DB_PATH, Store } from './db.js';
import { serveStatic } from './static.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const config = {
  port: Number(process.env.PORT ?? 8090),
  host: process.env.HOST ?? '127.0.0.1',
  trustProxy: (process.env.TRUST_PROXY ?? '1') === '1',
  allowRegister: (process.env.ALLOW_REGISTER ?? '1') === '1',
  // Before accounts existed: one web password and one agent key. Both keep working after an upgrade.
  legacyPasswordHash: process.env.PASSWORD_HASH,
  legacyAgentKey: process.env.AGENT_KEY,
  // coturn with use-auth-secret: we mint short-lived TURN credentials for each viewer.
  turnSecret: process.env.TURN_SECRET,
  turnHost: process.env.TURN_HOST ?? process.env.DOMAIN,
  turnPort: Number(process.env.TURN_PORT ?? 3478),
};

const store = new Store();
console.log(`database: ${DB_PATH}`);

// Upgrade from the single-password version: the old password becomes the "admin" account.
if (store.countUsers() === 0 && config.legacyPasswordHash) {
  store.createUser({ username: 'admin', passwordHash: config.legacyPasswordHash, role: 'admin', status: 'active' });
  console.log('created account "admin" from the old PASSWORD_HASH (log in with the old password)');
}
if (store.countUsers() === 0) {
  console.log('no accounts yet: the first account registered on the web page becomes the admin');
}

const auth = new Auth({ store, trustProxy: config.trustProxy, allowRegister: config.allowRegister });

const CHANNEL_TIMEOUT_MS = 10000;
const TURN_CREDENTIAL_TTL_S = 12 * 3600;

/**
 * ICE servers for one viewer's WebRTC session, in both formats (browser RTCPeerConnection and the
 * agent's node-datachannel). TURN uses coturn's REST-style credentials: username = expiry:label,
 * password = base64(HMAC-SHA1(secret, username)).
 */
function iceServers() {
  if (!config.turnSecret || !config.turnHost) {
    return {
      agent: ['stun:stun.l.google.com:19302'],
      browser: [{ urls: 'stun:stun.l.google.com:19302' }],
    };
  }
  const { turnHost: host, turnPort: port } = config;
  const username = `${Math.floor(Date.now() / 1000) + TURN_CREDENTIAL_TTL_S}:ldplayer`;
  const password = createHmac('sha1', config.turnSecret).update(username).digest('base64');
  return {
    agent: [`stun:${host}:${port}`, { hostname: host, port, username, password, relayType: 'TurnUdp' }],
    browser: [
      { urls: `stun:${host}:${port}` },
      { urls: [`turn:${host}:${port}?transport=udp`, `turn:${host}:${port}?transport=tcp`], username, credential: password },
    ],
  };
}
const AGENT_REQUEST_TIMEOUT_MS = 5000;
const HEARTBEAT_MS = 5000;
const PIPE_HIGH_WATER = 256 * 1024;

// ---------------------------------------------------------------- agents

class AgentConn {
  constructor({ machineId, keyId, userId }, ws, ip) {
    this.machineId = machineId; // database id, used in web URLs
    this.userId = userId;
    this.keyId = keyId;
    this.ws = ws;
    this.ip = ip;
    this.pending = new Map(); // reqId → { resolve, reject, timer }
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      const req = this.pending.get(msg.reqId);
      if (req) {
        this.pending.delete(msg.reqId);
        clearTimeout(req.timer);
        req.resolve(msg);
      }
    });
    ws.on('close', () => {
      for (const req of this.pending.values()) {
        clearTimeout(req.timer);
        req.reject(new Error('agent disconnected'));
      }
      this.pending.clear();
    });
  }

  send(msg) {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }

  request(msg) {
    const reqId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error('agent request timed out'));
      }, AGENT_REQUEST_TIMEOUT_MS);
      this.pending.set(reqId, { resolve, reject, timer });
      this.send({ ...msg, reqId });
    });
  }
}

const agents = new Map(); // machine database id → AgentConn
const channels = new Map(); // channel id → { viewer, agent, timer }
const viewers = new Set(); // { ws, userId }

const agentLabel = (agent) => `#${agent.machineId} (user ${agent.userId})`;

function registerAgent(owner, machine, ws, ip) {
  agents.get(machine.id)?.ws.close(4000, 'replaced by a new connection');
  const agent = new AgentConn({ machineId: machine.id, keyId: owner.key_id, userId: owner.user_id }, ws, ip);
  agents.set(machine.id, agent);
  if (owner.key_id) store.touchApiKey(owner.key_id);
  console.log(`agent ${agentLabel(agent)} "${machine.name}" of "${owner.username}" connected from ${ip}`);
  ws.on('close', () => {
    if (agents.get(machine.id) === agent) agents.delete(machine.id);
    store.touchMachine(machine.id);
    console.log(`agent ${agentLabel(agent)} disconnected`);
  });
}

/** Drops live connections that lost their right to exist (key revoked, user disabled, …). */
function kickAgents(predicate, reason) {
  for (const agent of agents.values()) if (predicate(agent)) agent.ws.close(4001, reason);
}

function kickViewers(userId, reason) {
  for (const v of viewers) if (v.userId === userId) v.ws.close(4001, reason);
}

async function listDevices(userId) {
  const names = new Map(store.listMachines(userId).map((m) => [m.id, m.name]));
  const mine = [...agents.values()].filter((a) => a.userId === userId);
  const results = await Promise.all(
    mine.map(async (agent) => {
      const name = names.get(agent.machineId) ?? '?';
      try {
        const { devices } = await agent.request({ type: 'devices' });
        return devices.map((d) => ({ ...d, id: d.id ? `${agent.machineId}/${d.id}` : null, agent: name, machine: agent.machineId }));
      } catch (err) {
        console.warn(`agent ${agentLabel(agent)}: ${err.message}`);
        return [];
      }
    }),
  );
  return { devices: results.flat(), agents: mine.map((a) => names.get(a.machineId) ?? '?') };
}

// ---------------------------------------------------------------- piping

const closeCode = (code) => (code >= 3000 && code <= 4999) || code === 1000 || code === 1011 ? code : 1000;

/** Forwards messages both ways; when one side's send buffer fills up, stops reading the other. */
function pipe(a, b) {
  const forward = (from, to) => {
    let paused = false;
    from.on('message', (data, isBinary) => {
      if (to.readyState !== to.OPEN) return;
      to.send(data, { binary: isBinary });
      if (!paused && to.bufferedAmount > PIPE_HIGH_WATER) {
        paused = true;
        from._socket.pause();
        to._socket.once('drain', () => {
          paused = false;
          from._socket.resume();
        });
      }
    });
    from.on('close', (code, reason) => to.close(closeCode(code), reason.toString()));
  };
  forward(a, b);
  forward(b, a);
}

// ---------------------------------------------------------------- http API

const publicUser = (u) => ({ id: u.id, username: u.username, role: u.role });

async function body(req) {
  try {
    return await readJsonBody(req);
  } catch {
    return null;
  }
}

/** Account API for a logged-in user. Returns false when no route matched. */
async function handleUserApi(req, res, user, path) {
  const { method } = req;
  let m;

  if (path === '/api/session') return sendJson(res, 200, { user: publicUser(user) });
  if (path === '/api/devices' && method === 'GET') return sendJson(res, 200, await listDevices(user.id));

  if (path === '/api/password' && method === 'POST') {
    const b = await body(req);
    if (!b || !(await verifyPasswordHash(String(b.current ?? ''), user.password_hash))) {
      return sendJson(res, 400, { error: 'Mật khẩu hiện tại không đúng.' });
    }
    const error = validateCredentials(user.username, b.password);
    if (error) return sendJson(res, 400, { error });
    store.setPassword(user.id, await hashPassword(b.password));
    store.deleteUserSessions(user.id, auth.token(req)); // log out every other browser
    return sendJson(res, 200, { ok: true });
  }

  // ---- API keys
  if (path === '/api/keys' && method === 'GET') return sendJson(res, 200, { keys: store.listApiKeys(user.id) });
  if (path === '/api/keys' && method === 'POST') {
    const b = await body(req);
    const name = String(b?.name ?? '').trim().slice(0, 60) || 'Key';
    if (store.listApiKeys(user.id).length >= 50) return sendJson(res, 400, { error: 'Tối đa 50 key.' });
    const { id, key } = store.createApiKey(user.id, name);
    return sendJson(res, 200, { id, key, name });
  }
  if ((m = path.match(/^\/api\/keys\/(\d+)$/)) && method === 'DELETE') {
    const id = Number(m[1]);
    if (!store.deleteApiKey(user.id, id)) return sendJson(res, 404, { error: 'not found' });
    kickAgents((a) => a.keyId === id, 'api key revoked');
    return sendJson(res, 200, { ok: true });
  }

  // ---- machines (PCs)
  if (path === '/api/machines' && method === 'GET') {
    const machines = store.listMachines(user.id).map((mc) => ({ ...mc, online: agents.get(mc.id)?.userId === user.id }));
    return sendJson(res, 200, { machines });
  }
  if ((m = path.match(/^\/api\/machines\/(\d+)$/))) {
    const id = Number(m[1]);
    if (method === 'PATCH') {
      const b = await body(req);
      const name = cleanName(b?.name, 40);
      if (!name) return sendJson(res, 400, { error: 'Tên không được trống.' });
      return store.renameMachine(user.id, id, name) ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: 'not found' });
    }
    if (method === 'DELETE') {
      if (!store.deleteMachine(user.id, id)) return sendJson(res, 404, { error: 'not found' });
      kickAgents((a) => a.machineId === id && a.userId === user.id, 'machine removed');
      return sendJson(res, 200, { ok: true });
    }
  }

  // ---- admin
  if (path.startsWith('/api/admin/')) {
    if (user.role !== 'admin') return sendJson(res, 403, { error: 'forbidden' });
    if (path === '/api/admin/users' && method === 'GET') {
      const online = new Map();
      for (const a of agents.values()) online.set(a.userId, (online.get(a.userId) ?? 0) + 1);
      const users = store.listUsers().map((u) => ({ ...u, online: online.get(u.id) ?? 0 }));
      return sendJson(res, 200, { users, allowRegister: config.allowRegister });
    }
    if ((m = path.match(/^\/api\/admin\/users\/(\d+)$/))) {
      const id = Number(m[1]);
      const target = store.userById(id);
      if (!target) return sendJson(res, 404, { error: 'not found' });
      if (id === user.id) return sendJson(res, 400, { error: 'Không tự khoá, đổi quyền hay xoá chính mình.' });
      if (method === 'PATCH') {
        const b = (await body(req)) ?? {};
        if (b.status !== undefined && !['active', 'disabled'].includes(b.status)) return sendJson(res, 400, { error: 'bad status' });
        if (b.role !== undefined && !['user', 'admin'].includes(b.role)) return sendJson(res, 400, { error: 'bad role' });
        if (b.password !== undefined) {
          const error = validateCredentials(target.username, b.password);
          if (error) return sendJson(res, 400, { error });
        }
        if (b.status) {
          store.setUserStatus(id, b.status);
          if (b.status !== 'active') {
            store.deleteUserSessions(id);
            kickAgents((a) => a.userId === id, 'account disabled');
            kickViewers(id, 'account disabled');
          }
        }
        if (b.role) store.setUserRole(id, b.role);
        if (b.password !== undefined) {
          store.setPassword(id, await hashPassword(b.password));
          store.deleteUserSessions(id);
        }
        const changes = Object.keys(b).filter((k) => ['status', 'role', 'password'].includes(k));
        console.log(`admin "${user.username}" updated "${target.username}": ${changes.map((k) => (k === 'password' ? k : `${k}=${b[k]}`)).join(', ')}`);
        return sendJson(res, 200, { ok: true });
      }
      if (method === 'DELETE') {
        store.deleteUser(id);
        kickAgents((a) => a.userId === id, 'account deleted');
        kickViewers(id, 'account deleted');
        console.log(`admin "${user.username}" deleted user "${target.username}"`);
        return sendJson(res, 200, { ok: true });
      }
    }
  }
  return false;
}

async function handleRequest(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname.startsWith('/api/')) {
    // The session cookie is SameSite=Strict; also refuse state changes announced from another site.
    if (req.method !== 'GET' && req.headers.origin && !auth.isSameOrigin(req)) return sendJson(res, 403, { error: 'bad origin' });
    if (pathname === '/api/config') {
      return sendJson(res, 200, { allowRegister: config.allowRegister, hasUsers: store.countUsers() > 0 });
    }
    if (pathname === '/api/login' && req.method === 'POST') return auth.handleLogin(req, res);
    if (pathname === '/api/register' && req.method === 'POST') return auth.handleRegister(req, res);
    if (pathname === '/api/logout' && req.method === 'POST') return auth.handleLogout(req, res);
    const user = auth.user(req);
    if (!user) return sendJson(res, 401, { error: 'unauthorized' });
    if ((await handleUserApi(req, res, user, pathname)) === false) sendJson(res, 404, { error: 'not found' });
    return;
  }
  return serveStatic(req, res, PUBLIC_DIR);
}

const server = createServer((req, res) =>
  handleRequest(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
  }),
);

// ---------------------------------------------------------------- websockets

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1 << 20 });

function reject(socket, status) {
  socket.end(`HTTP/1.1 ${status}\r\n\r\n`);
}

function accept(req, socket, head, onOpen) {
  wss.handleUpgrade(req, socket, head, (ws) => {
    socket.setKeepAlive(true, 5000);
    socket.setNoDelay(true);
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    ws.on('error', (err) => console.warn('websocket error:', err.message));
    onOpen(ws);
  });
}

/** The (active) owner of the API key in the Authorization header, or undefined. */
function agentOwner(req) {
  const key = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!key) return undefined;
  if (config.legacyAgentKey && safeEqual(key, config.legacyAgentKey)) {
    const admin = store.firstAdmin();
    return admin && { key_id: null, user_id: admin.id, username: admin.username };
  }
  return store.apiKeyOwner(key);
}

function cleanName(value, max) {
  let s = String(value ?? '');
  try {
    s = decodeURIComponent(s);
  } catch {
    // not percent-encoded
  }
  return s.replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, max);
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  const ip = auth.clientIp(req);

  if (url.pathname === '/agent') {
    const owner = agentOwner(req);
    const name = cleanName(req.headers['x-agent-name'], 40);
    // Agents without a machine id (older versions) are told apart by name.
    const machineId = cleanName(req.headers['x-machine-id'], 64) || name;
    if (!owner || !name) {
      console.warn(`rejected agent connection from ${ip} (${owner ? 'no name' : 'bad key'})`);
      return reject(socket, '401 Unauthorized');
    }
    const machine = store.upsertMachine({ userId: owner.user_id, machineId, name, keyId: owner.key_id, ip });
    return accept(req, socket, head, (ws) => registerAgent(owner, machine, ws, ip));
  }

  if (url.pathname === '/agent/channel') {
    const id = url.searchParams.get('id');
    const channel = channels.get(id);
    const owner = agentOwner(req);
    if (!channel || !owner || owner.user_id !== channel.agent.userId) return reject(socket, '401 Unauthorized');
    channels.delete(id);
    clearTimeout(channel.timer);
    return accept(req, socket, head, (ws) => {
      if (channel.viewer.readyState !== channel.viewer.OPEN) return ws.close(1000);
      pipe(channel.viewer, ws);
    });
  }

  if (url.pathname === '/ws') {
    const user = auth.user(req);
    if (!user || !auth.isSameOrigin(req)) return reject(socket, '401 Unauthorized');
    const device = url.searchParams.get('device') ?? '';
    const slash = device.indexOf('/');
    const found = agents.get(Number(device.slice(0, slash)));
    const agent = found?.userId === user.id ? found : null;
    const serial = device.slice(slash + 1);
    return accept(req, socket, head, (viewer) => {
      const entry = { ws: viewer, userId: user.id };
      viewers.add(entry);
      viewer.on('close', () => viewers.delete(entry));
      if (slash <= 0 || !agent) {
        viewer.send(JSON.stringify({ type: 'status', state: 'stopped', message: 'PC (agent) đang offline' }));
        return viewer.close(4404, 'agent offline');
      }
      const id = randomUUID();
      const timer = setTimeout(() => {
        channels.delete(id);
        viewer.send(JSON.stringify({ type: 'status', state: 'stopped', message: 'agent không phản hồi' }));
        viewer.close(4504, 'agent timeout');
      }, CHANNEL_TIMEOUT_MS);
      channels.set(id, { viewer, agent, timer });
      viewer.on('close', () => {
        if (channels.delete(id)) clearTimeout(timer);
      });
      agent.send({ type: 'open', channel: id, serial, ice: iceServers() });
    });
  }

  reject(socket, '404 Not Found');
});

// Drop half-open connections (sleeping phones, dead NAT mappings) within ~10 s, so a stalled
// viewer or agent reconnects quickly instead of freezing until TCP gives up.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);

setInterval(() => store.purgeExpiredSessions(), 3600 * 1000).unref();

server.listen(config.port, config.host, () => {
  console.log(`relay listening on http://${config.host}:${config.port} (trust proxy: ${config.trustProxy})`);
  console.log(config.turnSecret ? `TURN: ${config.turnHost}:${config.turnPort}` : 'TURN: not configured (WebRTC may fail on mobile networks)');
});

// Relay mode (runs on a VPS): serves the web UI behind a single password. PC agents keep an
// outbound control connection to it; for each viewer the agent dials back a dedicated channel
// socket, and the relay pipes viewer ⇄ channel byte-for-byte.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Auth, deriveKey, safeEqual, sendJson, verifyPasswordHash } from './auth.js';
import { serveStatic } from './static.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const config = {
  port: Number(process.env.PORT ?? 8090),
  host: process.env.HOST ?? '127.0.0.1',
  passwordHash: process.env.PASSWORD_HASH,
  agentKey: process.env.AGENT_KEY,
  sessionSecret: process.env.SESSION_SECRET,
  trustProxy: (process.env.TRUST_PROXY ?? '1') === '1',
};
for (const [key, name] of [['passwordHash', 'PASSWORD_HASH'], ['agentKey', 'AGENT_KEY'], ['sessionSecret', 'SESSION_SECRET']]) {
  if (!config[key]) {
    console.error(`Missing ${name}. Run "npm run setup" to create relay.env.`);
    process.exit(1);
  }
}

const auth = new Auth({
  verify: (pw) => verifyPasswordHash(pw, config.passwordHash),
  key: deriveKey(config.sessionSecret),
  trustProxy: config.trustProxy,
});

const CHANNEL_TIMEOUT_MS = 10000;
const AGENT_REQUEST_TIMEOUT_MS = 5000;
const HEARTBEAT_MS = 15000;
const PIPE_HIGH_WATER = 256 * 1024;

// ---------------------------------------------------------------- agents

class AgentConn {
  constructor(name, ws, ip) {
    this.name = name;
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

const agents = new Map(); // name → AgentConn
const channels = new Map(); // channel id → { viewer, agent, timer }

function registerAgent(name, ws, ip) {
  agents.get(name)?.ws.close(4000, 'replaced by a new connection');
  const agent = new AgentConn(name, ws, ip);
  agents.set(name, agent);
  console.log(`agent "${name}" connected from ${ip}`);
  ws.on('close', () => {
    if (agents.get(name) === agent) agents.delete(name);
    console.log(`agent "${name}" disconnected`);
  });
}

async function listDevices() {
  const results = await Promise.all(
    [...agents.values()].map(async (agent) => {
      try {
        const { devices } = await agent.request({ type: 'devices' });
        return devices.map((d) => ({ ...d, id: d.id ? `${agent.name}/${d.id}` : null, agent: agent.name }));
      } catch (err) {
        console.warn(`agent "${agent.name}": ${err.message}`);
        return [];
      }
    }),
  );
  return { devices: results.flat(), agents: [...agents.keys()] };
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

// ---------------------------------------------------------------- http

async function handleRequest(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/api/login' && req.method === 'POST') return auth.handleLogin(req, res);
  if (pathname === '/api/logout' && req.method === 'POST') return auth.handleLogout(req, res);
  if (pathname.startsWith('/api/')) {
    if (!auth.isAuthenticated(req)) return sendJson(res, 401, { error: 'unauthorized' });
    if (pathname === '/api/session') return sendJson(res, 200, { ok: true });
    if (pathname === '/api/devices' && req.method === 'GET') return sendJson(res, 200, await listDevices());
    return sendJson(res, 404, { error: 'not found' });
  }
  return serveStatic(req, res, PUBLIC_DIR);
}

const server = createServer((req, res) =>
  handleRequest(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
  }),
);

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1 << 20 });

function reject(socket, status) {
  socket.end(`HTTP/1.1 ${status}\r\n\r\n`);
}

function accept(req, socket, head, onOpen) {
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    ws.on('error', (err) => console.warn('websocket error:', err.message));
    onOpen(ws);
  });
}

function isAgent(req) {
  const key = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  return Boolean(key) && safeEqual(key, config.agentKey);
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  const ip = auth.clientIp(req);

  if (url.pathname === '/agent') {
    const name = String(req.headers['x-agent-name'] ?? '').replace(/[^\w.-]/g, '').slice(0, 40);
    if (!isAgent(req) || !name) {
      console.warn(`rejected agent connection from ${ip}`);
      return reject(socket, '401 Unauthorized');
    }
    return accept(req, socket, head, (ws) => registerAgent(name, ws, ip));
  }

  if (url.pathname === '/agent/channel') {
    const channel = channels.get(url.searchParams.get('id'));
    if (!isAgent(req) || !channel) return reject(socket, '401 Unauthorized');
    channels.delete(url.searchParams.get('id'));
    clearTimeout(channel.timer);
    return accept(req, socket, head, (ws) => {
      if (channel.viewer.readyState !== channel.viewer.OPEN) return ws.close(1000);
      pipe(channel.viewer, ws);
    });
  }

  if (url.pathname === '/ws') {
    if (!auth.isAuthenticated(req) || !auth.isSameOrigin(req)) return reject(socket, '401 Unauthorized');
    const device = url.searchParams.get('device') ?? '';
    const slash = device.indexOf('/');
    const agent = agents.get(device.slice(0, slash));
    const serial = device.slice(slash + 1);
    return accept(req, socket, head, (viewer) => {
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
      agent.send({ type: 'open', channel: id, serial });
    });
  }

  reject(socket, '404 Not Found');
});

// Drop half-open connections (sleeping phones, dead NAT mappings) and keep proxies from idling out.
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

server.listen(config.port, config.host, () => {
  console.log(`relay listening on http://${config.host}:${config.port} (trust proxy: ${config.trustProxy})`);
});

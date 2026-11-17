// SQLite storage (node:sqlite, built into Node 22.5+): users, login sessions, API keys and the PCs
// (machines) that connected with them. The file lives outside the code directory so redeploys
// never touch it (systemd StateDirectory → /var/lib/ldplayer-relay).
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_DIR = process.env.STATE_DIRECTORY || join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
export const DB_PATH = process.env.DB_PATH || join(DEFAULT_DIR, 'relay.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'disabled')),
  created_at    INTEGER NOT NULL,
  approved_at   INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  ip          TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS api_keys (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  prefix       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS api_keys_user ON api_keys(user_id);
CREATE TABLE IF NOT EXISTS machines (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  machine_id  TEXT NOT NULL,
  name        TEXT NOT NULL,
  key_id      INTEGER REFERENCES api_keys(id) ON DELETE SET NULL,
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  last_ip     TEXT,
  UNIQUE (user_id, machine_id)
);
`;

const now = () => Date.now();
export const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
export const newToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export class Store {
  constructor(path = DB_PATH) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
    this.db.exec(SCHEMA);
    this.q = {};
  }

  /** Cached prepared statement. */
  st(sql) {
    return (this.q[sql] ??= this.db.prepare(sql));
  }

  // ------------------------------------------------------------ users

  countUsers() {
    return this.st('SELECT COUNT(*) AS n FROM users').get().n;
  }

  createUser({ username, passwordHash, role = 'user', status = 'pending' }) {
    const t = now();
    const r = this.st(
      'INSERT INTO users (username, password_hash, role, status, created_at, approved_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(username, passwordHash, role, status, t, status === 'active' ? t : null);
    return this.userById(Number(r.lastInsertRowid));
  }

  userById(id) {
    return this.st('SELECT * FROM users WHERE id = ?').get(id);
  }

  userByName(username) {
    return this.st('SELECT * FROM users WHERE username = ?').get(username);
  }

  listUsers() {
    return this.st(
      `SELECT u.id, u.username, u.role, u.status, u.created_at, u.approved_at,
              (SELECT COUNT(*) FROM machines m WHERE m.user_id = u.id) AS machines,
              (SELECT COUNT(*) FROM api_keys k WHERE k.user_id = u.id) AS keys
       FROM users u ORDER BY u.status = 'pending' DESC, u.created_at DESC`,
    ).all();
  }

  setUserStatus(id, status) {
    this.st('UPDATE users SET status = ?, approved_at = COALESCE(approved_at, CASE WHEN ? = \'active\' THEN ? END) WHERE id = ?').run(
      status,
      status,
      now(),
      id,
    );
  }

  setUserRole(id, role) {
    this.st('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  }

  setPassword(id, passwordHash) {
    this.st('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
  }

  deleteUser(id) {
    this.st('DELETE FROM users WHERE id = ?').run(id);
  }

  countActiveAdmins() {
    return this.st("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'").get().n;
  }

  firstAdmin() {
    return this.st("SELECT * FROM users WHERE role = 'admin' AND status = 'active' ORDER BY id LIMIT 1").get();
  }

  // ------------------------------------------------------------ sessions

  createSession(userId, ttlMs, ip) {
    const token = newToken();
    const t = now();
    this.st('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ip) VALUES (?, ?, ?, ?, ?)').run(
      sha256(token),
      userId,
      t,
      t + ttlMs,
      ip ?? null,
    );
    return token;
  }

  /** The active user behind a session cookie, or undefined. */
  sessionUser(token) {
    if (!token) return undefined;
    return this.st(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND u.status = 'active'`,
    ).get(sha256(token), now());
  }

  deleteSession(token) {
    this.st('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  }

  deleteUserSessions(userId, exceptToken = null) {
    this.st('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, exceptToken ? sha256(exceptToken) : '');
  }

  purgeExpiredSessions() {
    this.st('DELETE FROM sessions WHERE expires_at <= ?').run(now());
  }

  // ------------------------------------------------------------ API keys

  /** Returns the full key once; only its hash is stored. */
  createApiKey(userId, name) {
    const key = `ldr_${newToken(24)}`;
    const r = this.st('INSERT INTO api_keys (user_id, name, key_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?)').run(
      userId,
      name,
      sha256(key),
      key.slice(0, 10),
      now(),
    );
    return { id: Number(r.lastInsertRowid), key };
  }

  listApiKeys(userId) {
    return this.st(
      `SELECT k.id, k.name, k.prefix, k.created_at, k.last_used_at,
              (SELECT COUNT(*) FROM machines m WHERE m.key_id = k.id) AS machines
       FROM api_keys k WHERE k.user_id = ? ORDER BY k.created_at DESC`,
    ).all(userId);
  }

  /** The key row plus its owner, only if the owner is active. */
  apiKeyOwner(key) {
    if (!key) return undefined;
    return this.st(
      `SELECT k.id AS key_id, u.id AS user_id, u.username FROM api_keys k JOIN users u ON u.id = k.user_id
       WHERE k.key_hash = ? AND u.status = 'active'`,
    ).get(sha256(key));
  }

  touchApiKey(id) {
    this.st('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now(), id);
  }

  deleteApiKey(userId, id) {
    return this.st('DELETE FROM api_keys WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
  }

  // ------------------------------------------------------------ machines

  /** Records a PC connecting with a key; returns its row (id is what the web UI uses). */
  upsertMachine({ userId, machineId, name, keyId, ip }) {
    const t = now();
    this.st(
      `INSERT INTO machines (user_id, machine_id, name, key_id, first_seen, last_seen, last_ip)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, machine_id) DO UPDATE SET key_id = excluded.key_id, last_seen = excluded.last_seen,
         last_ip = excluded.last_ip`,
    ).run(userId, machineId, name, keyId, t, t, ip ?? null);
    return this.st('SELECT * FROM machines WHERE user_id = ? AND machine_id = ?').get(userId, machineId);
  }

  touchMachine(id) {
    this.st('UPDATE machines SET last_seen = ? WHERE id = ?').run(now(), id);
  }

  listMachines(userId) {
    return this.st(
      `SELECT m.id, m.machine_id, m.name, m.first_seen, m.last_seen, m.last_ip, k.name AS key_name
       FROM machines m LEFT JOIN api_keys k ON k.id = m.key_id WHERE m.user_id = ? ORDER BY m.name COLLATE NOCASE`,
    ).all(userId);
  }

  renameMachine(userId, id, name) {
    return this.st('UPDATE machines SET name = ? WHERE id = ? AND user_id = ?').run(name, id, userId).changes > 0;
  }

  deleteMachine(userId, id) {
    return this.st('DELETE FROM machines WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
  }
}

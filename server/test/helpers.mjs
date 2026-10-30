// Test fixtures: a throwaway Postgres cluster, the app on a random port, and small API helpers.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.mjs';
import { createAdmin } from '../src/auth.mjs';
import { loadConfig } from '../src/config.mjs';
import { createPool, migrate } from '../src/db.mjs';
import { hashToken, newToken } from '../src/crypto.mjs';

const PG_BIN = process.env.PG_BIN || ['/opt/homebrew/opt/postgresql@18/bin', '/opt/homebrew/opt/postgresql@17/bin', '/usr/lib/postgresql/16/bin'].find((d) => fs.existsSync(path.join(d, 'initdb'))) || '';
const bin = (name) => (PG_BIN ? path.join(PG_BIN, name) : name);

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

export async function startPostgres() {
  const dir = fs.mkdtempSync('/tmp/wfpg-');
  const port = await freePort();
  const run = (cmd, args) => {
    const r = spawnSync(bin(cmd), args, { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`${cmd} failed: ${r.stderr || r.stdout}`);
  };
  run('initdb', ['-D', path.join(dir, 'data'), '-A', 'trust', '-U', 'postgres', '-E', 'UTF8']);
  run('pg_ctl', ['-D', path.join(dir, 'data'), '-o', `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c fsync=off`, '-l', path.join(dir, 'log'), '-w', 'start']);
  return {
    url: `postgres://postgres@127.0.0.1:${port}/postgres`,
    stop() {
      spawnSync(bin('pg_ctl'), ['-D', path.join(dir, 'data'), '-m', 'immediate', 'stop']);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const PASSWORD = 'correct horse battery';

// Starts everything and returns helpers. Call `close()` in test.after.
export async function startStack(pgUrl, overrides = {}) {
  const config = { ...loadConfig({ DATABASE_URL: pgUrl }), ...overrides };
  const pool = createPool(config);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(pool);
  const server = createApp({ pool, config });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const api = async (method, route, { body, token, headers } = {}) => {
    const res = await fetch(base + route, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* not json */ }
    return { status: res.status, body: json, headers: res.headers };
  };
  const login = async (email, password = PASSWORD) => (await api('POST', '/auth/login', { body: { email, password } })).body;

  const admin = async (email = 'admin@example.com') => {
    await createAdmin(pool, { email, password: PASSWORD });
    return (await login(email)).token;
  };
  // Creates a workflow user through the real invite flow.
  const user = async (adminToken, email) => {
    const inv = await api('POST', '/admin/invites', { token: adminToken, body: { email } });
    await api('POST', '/auth/accept-invite', { body: { token: inv.body.token, password: PASSWORD } });
    return (await login(email)).token;
  };
  return {
    pool, config, base, api, login, admin, user,
    async close() { await new Promise((r) => server.close(r)); await pool.end(); },
  };
}

export { hashToken, newToken };

let n = 0;
export const uuid = () => {
  n += 1;
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
};
export const ev = (run_id, type, extra = {}) => ({ event_id: uuid(), run_id, session_id: run_id, stage: null, type, ts: new Date().toISOString(), attrs: {}, ...extra });

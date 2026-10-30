// Login, cached token, and the sync worker. The client never holds database credentials: it
// holds an opaque session token for the telemetry server, nothing else.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PATHS } from '../paths.mjs';
import { ackBatch, enforceCaps, listBatches, queueStats, readBatch, rewriteBatch, seal } from './queue.mjs';

export const credentialsFile = () => path.join(process.env.WF_HOME || path.join(os.homedir(), '.agent-workflow-client'), 'credentials.json');

export function loadCredentials() {
  try { return JSON.parse(fs.readFileSync(credentialsFile(), 'utf8')); } catch { return null; }
}

export function telemetryConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(PATHS.config, 'utf8')).telemetry || {}; } catch { /* none */ }
  return { server_url: process.env.WF_SERVER || cfg.server_url || '', required: cfg.required === true, enabled: cfg.enabled !== false };
}

// 'ok' | 'expired' | 'none'
export function loginStatus(now = Date.now()) {
  const c = loadCredentials();
  if (!c?.token) return 'none';
  return Date.parse(c.expires_at) > now ? 'ok' : 'expired';
}

// Used at the start of a run and of init when the project requires login. Offline is fine while
// the cached token is valid; the check never touches the network.
export function loginProblem() {
  if (!telemetryConfig().required) return null;
  const s = loginStatus();
  if (s === 'ok') return null;
  return s === 'expired'
    ? 'your login has expired. Run `node .agent-workflow/wf.mjs login` (events stay queued meanwhile).'
    : 'this project requires login. Run `node .agent-workflow/wf.mjs login --server <url> --email <you>` first.';
}

async function post(url, body, token, fetchImpl) {
  return fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

export async function login({ server, email, password, fetchImpl = fetch }) {
  const res = await post(`${server.replace(/\/$/, '')}/auth/login`, { email, password }, null, fetchImpl);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `login failed (${res.status})`);
  const file = credentialsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ server: server.replace(/\/$/, ''), email, token: body.token, expires_at: body.expires_at, role: body.role }), { mode: 0o600 });
  return body;
}

export async function logout({ fetchImpl = fetch } = {}) {
  const c = loadCredentials();
  if (c?.token) {
    try { await post(`${c.server}/auth/logout`, {}, c.token, fetchImpl); } catch { /* offline: still forget it locally */ }
  }
  fs.rmSync(credentialsFile(), { force: true });
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// Sends sealed batches. A batch is deleted only for events the server accounted for (accepted,
// already had, or permanently rejected). Failures keep the batch and stop the run.
export async function syncOnce({ fetchImpl = fetch, attempts = 3, baseDelayMs = 500, sleep = sleepMs } = {}) {
  const creds = loadCredentials();
  const result = { sent: 0, accepted: 0, duplicates: 0, rejected: 0, status: 'ok' };
  if (!creds?.token) return { ...result, status: 'not_logged_in', ...queueStats() };
  if (Date.parse(creds.expires_at) <= Date.now()) return { ...result, status: 'expired', ...queueStats() };
  enforceCaps();
  seal();
  outer: for (const name of listBatches()) {
    const events = readBatch(name);
    if (!events.length) { ackBatch(name); continue; }
    for (let attempt = 0; ; attempt += 1) {
      let res = null;
      try { res = await post(`${creds.server}/events`, { events }, creds.token, fetchImpl); } catch { /* network down */ }
      if (res && res.status === 401) { result.status = 'expired'; break outer; }
      if (res && res.ok) {
        const body = await res.json().catch(() => null);
        if (!body) { result.status = 'server_error'; break outer; }
        const done = new Set([...(body.accepted || []), ...(body.duplicates || []), ...(body.rejected || []).map((r) => r.event_id)]);
        result.sent += events.length;
        result.accepted += (body.accepted || []).length;
        result.duplicates += (body.duplicates || []).length;
        result.rejected += (body.rejected || []).length;
        rewriteBatch(name, events.filter((e) => !done.has(e.event_id)));
        break;
      }
      if (res && res.status >= 400 && res.status < 500 && res.status !== 429) { result.status = 'rejected_by_server'; break outer; }
      if (attempt + 1 >= attempts) { result.status = 'server_unreachable'; break outer; }
      await sleep(baseDelayMs * 2 ** attempt);
    }
  }
  return { ...result, ...queueStats() };
}

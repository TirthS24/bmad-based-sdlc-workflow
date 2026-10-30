// Phase 5: login cache, sync with injected faults, and the offline rules. The server is a fake
// that stores events by id, like the real one, so "no loss, no duplicates" can be checked.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fresh } from './helpers.mjs';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-sync-'));
process.env.WF_DIR = path.join(scratch, '.agent-workflow');
process.env.REPO_ROOT = scratch;
process.env.WF_HOME = path.join(scratch, 'home');
fs.mkdirSync(process.env.WF_DIR, { recursive: true });
const q = await import('../lib/telemetry/queue.mjs');
const c = await import('../lib/telemetry/client.mjs');
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const ev = (n) => ({ event_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, run_id: 'r', type: 'stage_started', ts: new Date().toISOString(), attrs: {} });
const reset = () => { fs.rmSync(q.QUEUE_DIR, { recursive: true, force: true }); fs.rmSync(process.env.WF_HOME, { recursive: true, force: true }); };
const creds = (over = {}) => {
  fs.mkdirSync(process.env.WF_HOME, { recursive: true });
  fs.writeFileSync(c.credentialsFile(), JSON.stringify({ server: 'http://fake', email: 'a@b.c', token: 'tok', expires_at: new Date(Date.now() + 3600e3).toISOString(), role: 'user', ...over }));
};
const queue = (...ns) => { q.enqueue(ns.map(ev)); };
const noWait = { sleep: async () => {}, baseDelayMs: 0 };

// An idempotent store plus fault hooks. `lose` drops the response after storing; `fail` returns a status.
function fakeServer({ lose = 0, fail = [], reject = {} } = {}) {
  const store = new Map();
  const calls = [];
  let losses = lose;
  const failures = [...fail];
  const fetchImpl = async (url, opts) => {
    calls.push(opts.headers.authorization);
    if (failures.length) {
      const status = failures.shift();
      if (status === 'down') throw new TypeError('fetch failed');
      return new Response(JSON.stringify({ error: 'nope' }), { status });
    }
    const { events } = JSON.parse(opts.body);
    const out = { accepted: [], duplicates: [], rejected: [] };
    for (const e of events) {
      if (reject[e.event_id]) out.rejected.push({ event_id: e.event_id, reason: reject[e.event_id] });
      else if (store.has(e.event_id)) out.duplicates.push(e.event_id);
      else { store.set(e.event_id, e); out.accepted.push(e.event_id); }
    }
    if (losses > 0) { losses -= 1; throw new TypeError('connection reset'); }
    return new Response(JSON.stringify(out), { status: 200 });
  };
  return { store, calls, fetchImpl };
}

test('sync: sends queued events, then deletes the batch only after the acknowledgement', async () => {
  reset(); creds(); queue(1, 2, 3);
  const srv = fakeServer();
  const r = await c.syncOnce({ fetchImpl: srv.fetchImpl, ...noWait });
  assert.equal(r.status, 'ok');
  assert.equal(r.accepted, 3);
  assert.equal(srv.store.size, 3);
  assert.equal(q.listBatches().length, 0);
  assert.equal(srv.calls[0], 'Bearer tok');
});

test('sync: server down keeps everything, and the next sync delivers it', async () => {
  reset(); creds(); queue(1, 2);
  const down = fakeServer({ fail: ['down', 'down', 'down'] });
  const r1 = await c.syncOnce({ fetchImpl: down.fetchImpl, attempts: 3, ...noWait });
  assert.equal(r1.status, 'server_unreachable');
  assert.equal(q.queueStats().events, 2, 'nothing deleted');
  const r2 = await c.syncOnce({ fetchImpl: down.fetchImpl, ...noWait });
  assert.equal(r2.status, 'ok');
  assert.equal(down.store.size, 2);
  assert.equal(q.queueStats().events, 0);
});

test('sync: retries through transient failures with backoff', async () => {
  reset(); creds(); queue(1);
  const waits = [];
  const srv = fakeServer({ fail: [503, 'down'] });
  const r = await c.syncOnce({ fetchImpl: srv.fetchImpl, attempts: 3, baseDelayMs: 100, sleep: async (ms) => { waits.push(ms); } });
  assert.equal(r.status, 'ok');
  assert.deepEqual(waits, [100, 200]);
});

test('sync: a response lost after the server stored the batch causes no loss and no duplicates', async () => {
  reset(); creds(); queue(1, 2, 3);
  const srv = fakeServer({ lose: 1 });
  const r = await c.syncOnce({ fetchImpl: srv.fetchImpl, attempts: 3, ...noWait });
  assert.equal(r.status, 'ok');
  assert.equal(srv.store.size, 3, 'stored exactly once');
  assert.equal(r.duplicates, 3, 'the retry was recognised as a repeat');
  assert.equal(q.queueStats().events, 0, 'and the local copy is gone');
});

test('sync: duplicate send of an already-delivered event is harmless', async () => {
  reset(); creds(); queue(1);
  const srv = fakeServer();
  await c.syncOnce({ fetchImpl: srv.fetchImpl, ...noWait });
  queue(1, 2);
  const r = await c.syncOnce({ fetchImpl: srv.fetchImpl, ...noWait });
  assert.equal(r.duplicates, 1);
  assert.equal(r.accepted, 1);
  assert.equal(srv.store.size, 2);
});

test('sync: a permanently rejected event is dropped locally, the rest are kept until acknowledged', async () => {
  reset(); creds(); queue(1, 2);
  const srv = fakeServer({ reject: { [ev(2).event_id]: 'not_owned' } });
  const r = await c.syncOnce({ fetchImpl: srv.fetchImpl, ...noWait });
  assert.equal(r.rejected, 1);
  assert.equal(srv.store.size, 1);
  assert.equal(q.queueStats().events, 0);
});

test('sync: events the server did not account for stay queued', async () => {
  reset(); creds(); queue(1, 2, 3);
  const half = async (url, opts) => {
    const { events } = JSON.parse(opts.body);
    return new Response(JSON.stringify({ accepted: [events[0].event_id], duplicates: [], rejected: [] }), { status: 200 });
  };
  await c.syncOnce({ fetchImpl: half, ...noWait });
  assert.deepEqual(q.readBatch(q.listBatches()[0]).map((e) => e.event_id), [ev(2).event_id, ev(3).event_id]);
});

test('token expiry: an expired cache or a 401 stops syncing and keeps the queue', async () => {
  reset(); creds({ expires_at: new Date(Date.now() - 1000).toISOString() }); queue(1);
  const srv = fakeServer();
  assert.equal((await c.syncOnce({ fetchImpl: srv.fetchImpl })).status, 'expired');
  assert.equal(srv.calls.length, 0, 'no request is made with a dead token');
  creds(); // looks valid locally, but the server has revoked it
  const revoked = fakeServer({ fail: [401] });
  const r = await c.syncOnce({ fetchImpl: revoked.fetchImpl, ...noWait });
  assert.equal(r.status, 'expired');
  assert.equal(q.queueStats().events, 1);
});

test('sync: not logged in leaves the queue alone', async () => {
  reset(); queue(1);
  assert.equal((await c.syncOnce({ fetchImpl: fakeServer().fetchImpl })).status, 'not_logged_in');
  assert.equal(q.queueStats().events, 1);
});

test('sync: a 4xx other than 401 or 429 is not retried and keeps the batch', async () => {
  reset(); creds(); queue(1);
  const srv = fakeServer({ fail: [400] });
  const r = await c.syncOnce({ fetchImpl: srv.fetchImpl, attempts: 3, ...noWait });
  assert.equal(r.status, 'rejected_by_server');
  assert.equal(srv.calls.length, 1);
  assert.equal(q.queueStats().events, 1);
});

test('login: stores a private credentials file and logout removes it', async () => {
  reset();
  const fetchImpl = async (url, opts) => {
    assert.match(url, /\/auth\/login$/);
    assert.deepEqual(JSON.parse(opts.body), { email: 'a@b.c', password: 'pw' });
    return new Response(JSON.stringify({ token: 'T', expires_at: new Date(Date.now() + 1e6).toISOString(), role: 'user' }), { status: 200 });
  };
  await c.login({ server: 'http://fake/', email: 'a@b.c', password: 'pw', fetchImpl });
  const saved = JSON.parse(fs.readFileSync(c.credentialsFile(), 'utf8'));
  assert.equal(saved.token, 'T');
  assert.equal(saved.server, 'http://fake');
  assert.ok(!JSON.stringify(saved).includes('pw'), 'the password is never stored');
  assert.equal(fs.statSync(c.credentialsFile()).mode & 0o077, 0, 'owner-only file');
  assert.equal(c.loginStatus(), 'ok');
  let revoked = false;
  await c.logout({ fetchImpl: async () => { revoked = true; return new Response('{}'); } });
  assert.ok(revoked);
  assert.equal(c.loginStatus(), 'none');
  await assert.rejects(c.login({ server: 'http://fake', email: 'a@b.c', password: 'x', fetchImpl: async () => new Response(JSON.stringify({ error: 'invalid email or password' }), { status: 401 }) }), /invalid email or password/);
});

test('logout works offline: the local token is forgotten even if the server cannot be reached', async () => {
  reset(); creds();
  await c.logout({ fetchImpl: async () => { throw new TypeError('down'); } });
  assert.equal(c.loginStatus(), 'none');
});

// ---- offline rules through the CLI -------------------------------------------------------

function cliRepo(t) {
  const repo = fresh(t);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  repo.config({ telemetry: { required: true, server_url: 'http://127.0.0.1:1' } });
  const run = (args, opts = {}) => repo.run(args, { ...opts, env: { WF_HOME: home, WF_NO_AUTOSYNC: '1', ...(opts.env || {}) } });
  const login = (expires) => {
    fs.writeFileSync(path.join(home, 'credentials.json'), JSON.stringify({ server: 'http://127.0.0.1:1', email: 'a@b.c', token: 't', expires_at: expires, role: 'user' }));
  };
  return { repo, run, login };
}

test('offline: with login required, no login or an expired one stops run and init with a clear message', (t) => {
  const { run, login } = cliRepo(t);
  const none = run(['run', 'feat']);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /requires login/);
  login(new Date(Date.now() - 1000).toISOString());
  const expired = run(['run', 'feat']);
  assert.match(expired.stderr, /login has expired/);
  assert.match(run(['init']).stderr, /login has expired/);
});

test('offline: a valid cached token lets the workflow run with the server unreachable', (t) => {
  const { repo, run, login } = cliRepo(t);
  login(new Date(Date.now() + 3600e3).toISOString());
  assert.equal(run(['run', 'feat']).status, 0);
  assert.equal(repo.hasState(), true);
  const sync = run(['sync']);
  assert.equal(sync.status, 1, 'sync fails cleanly while offline');
  assert.match(sync.stdout, /sync: server_unreachable/);
  assert.match(sync.stdout, /queued [1-9]/);
  assert.equal(run(['whoami']).status, 0);
});

test('login is not required unless the project says so', (t) => {
  const repo = fresh(t);
  assert.equal(repo.run(['run', 'feat'], { env: { WF_HOME: path.join(os.tmpdir(), 'wf-nohome') } }).status, 0);
});

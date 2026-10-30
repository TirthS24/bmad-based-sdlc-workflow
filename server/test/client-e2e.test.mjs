// The real CLI against the real server and Postgres: login, run, sync, and what the server holds.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WF_ENTRY, fresh } from '../../.agent-workflow/test/helpers.mjs';
import { PASSWORD, startPostgres, startStack } from './helpers.mjs';

const pg = await startPostgres();
test.after(() => pg.stop());

async function setup(t) {
  const s = await startStack(pg.url);
  t.after(() => s.close());
  const adminToken = await s.admin();
  await s.user(adminToken, 'dev@example.com');
  const repo = fresh(t);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  repo.config({ telemetry: { required: true, server_url: s.base } });
  // Async on purpose: the server lives in this process, so a blocking spawn would deadlock it.
  const wf = (args, input = '') => new Promise((resolve) => {
    const child = spawn(process.execPath, [WF_ENTRY, ...args], {
      cwd: repo.root,
      env: { ...process.env, WF_DIR: repo.wfDir, REPO_ROOT: repo.root, WF_HOME: home, WF_NO_AUTOSYNC: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
  return { s, repo, wf, home, adminToken };
}
const serverTypes = async (s) => (await s.pool.query('SELECT type FROM events ORDER BY ts, received_at')).rows.map((r) => r.type);

test('end to end: login, work offline-capable, sync, and the server holds the events', async (t) => {
  const { s, repo, wf, adminToken } = await setup(t);

  const before = await wf(['run', 'feat']);
  assert.equal(before.status, 1, 'login is required first');
  assert.match(before.stderr, /requires login/);

  const bad = await wf(['login', '--email', 'dev@example.com', '--password-stdin'], 'wrong password here\n');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /invalid email or password/);

  const ok = await wf(['login', '--email', 'dev@example.com', '--password-stdin'], `${PASSWORD}\n`);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /logged in as dev@example.com \(user\)/);
  assert.match((await wf(['whoami'])).stdout, /dev@example.com at http/);

  assert.equal((await wf(['run', 'Add items for client: Maria Gonzalez'])).status, 0);
  const id = repo.state().run.id;
  repo.seedPlanning(id);
  assert.equal((await wf(['done', 'planning', '--result', `specs/spec-${id}/SRS.md`])).status, 0);
  assert.equal((await wf(['reject', 'gate_spec', '--reason', 'reach me at boss@corp.com'])).status, 0);

  const sync = await wf(['sync']);
  assert.equal(sync.status, 0, sync.stdout + sync.stderr);
  assert.match(sync.stdout, /sync: ok; sent \d+ \(accepted \d+, already had 0, rejected 0\); queued 0/);

  const types = await serverTypes(s);
  for (const t2 of ['run_started', 'stage_started', 'stage_completed', 'gate_requested', 'gate_rejected', 'scrub_hit']) assert.ok(types.includes(t2), t2);
  const run = (await s.pool.query('SELECT r.id, u.email, r.project FROM runs r JOIN users u ON u.id = r.user_id')).rows;
  assert.deepEqual(run.map((r) => [r.id, r.email]), [[id, 'dev@example.com']]);

  const dump = JSON.stringify((await s.pool.query('SELECT * FROM events')).rows);
  assert.ok(!dump.includes('Maria'), 'ticket text never reached the server');
  assert.ok(!dump.includes('boss@corp.com'), 'reasons arrive scrubbed');
  const rej = (await s.pool.query("SELECT attrs FROM events WHERE type = 'gate_rejected'")).rows[0].attrs;
  assert.equal(rej.reason, 'reach me at [REDACTED:email]');
  assert.equal((await s.pool.query('SELECT phi_pii_status FROM run_risk')).rows[0].phi_pii_status, 'scrubbed_hits');

  assert.equal((await wf(['sync'])).status, 0);
  assert.equal((await serverTypes(s)).length, types.length, 'a second sync adds nothing');

  const dash = await s.api('GET', '/admin/gates', { token: adminToken });
  assert.equal(dash.body.rejections[0].user_email, 'dev@example.com');

  assert.equal((await wf(['logout'])).status, 0);
  assert.equal((await s.pool.query('SELECT count(*)::int AS n FROM sessions WHERE revoked_at IS NOT NULL')).rows[0].n, 1, 'server-side session revoked');
  assert.equal((await wf(['run', 'again'])).status, 1, 'and the CLI asks for login again');
});

test('end to end: events queued while the server is away arrive later without loss', async (t) => {
  const { s, repo, wf, home } = await setup(t);
  assert.equal((await wf(['login', '--email', 'dev@example.com', '--password-stdin'], `${PASSWORD}\n`)).status, 0);
  const file = path.join(home, 'credentials.json');
  const creds = JSON.parse(fs.readFileSync(file, 'utf8'));

  fs.writeFileSync(file, JSON.stringify({ ...creds, server: 'http://127.0.0.1:1' })); // the server is away
  assert.equal((await wf(['run', 'feat'])).status, 0, 'the workflow keeps going on a cached login');
  const offline = await wf(['sync']);
  assert.equal(offline.status, 1);
  assert.match(offline.stdout, /server_unreachable/);
  assert.equal((await serverTypes(s)).length, 0);
  const queued = Number(/queued (\d+)/.exec(offline.stdout)[1]);
  assert.ok(queued >= 2);

  fs.writeFileSync(file, JSON.stringify(creds)); // and it is back
  const online = await wf(['sync']);
  assert.equal(online.status, 0, online.stdout);
  assert.equal((await serverTypes(s)).length, queued, 'every queued event arrived exactly once');
  assert.equal(repo.state().run.id.length > 0, true);
});

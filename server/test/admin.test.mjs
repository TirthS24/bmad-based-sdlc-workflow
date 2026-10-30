// Aggregates on seeded data: known inputs give known totals.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ev, startPostgres, startStack } from './helpers.mjs';

const pg = await startPostgres();
test.after(() => pg.stop());

let stack;
let adminToken;
test.before(async () => {
  stack = await startStack(pg.url);
  adminToken = await stack.admin();
  const alice = await stack.user(adminToken, 'alice@example.com');
  const bob = await stack.user(adminToken, 'bob@example.com');
  const post = (token, events) => stack.api('POST', '/events', { token, body: { events } });
  const done = (run, stage, ms) => ev(run, 'stage_completed', { stage, attrs: { duration_ms: ms } });

  await post(alice, [
    ev('A', 'run_started', { attrs: { project: 'shop', harness: 'cursor' } }),
    done('A', 'planning', 1000), done('A', 'feasibility', 3000), done('A', 'tests', 2000),
    ev('A', 'gate_approved', { stage: 'gate_spec', attrs: { gate: 'gate_spec', wait_ms: 5000 } }),
    ev('A', 'gate_rejected', { stage: 'gate_approach', attrs: { gate: 'gate_approach', wait_ms: 9000, count: 1, reason: 'unclear scope' } }),
    ev('A', 'loop_round', { stage: 'implement', attrs: { round: 1, cap: 5 } }),
    ev('A', 'loop_round', { stage: 'implement', attrs: { round: 2, cap: 5 } }),
    ev('A', 'loop_round', { stage: 'implement', attrs: { round: 3, cap: 5 } }),
    ev('A', 'error', { stage: 'implement', attrs: { error_class: 'test_failure' } }),
    ev('A', 'error', { stage: 'implement', attrs: { error_class: 'test_failure' } }),
    ev('A', 'error', { stage: 'tests', attrs: { error_class: 'guard_block' } }),
    ev('A', 'agent_failed', { stage: 'feasibility', attrs: { agent: 'solution-architect', error_class: 'timeout' } }),
    ev('A', 'scrub_hit', { attrs: { category: 'email', count: 1 } }),
    ev('A', 'run_ended', { attrs: { status: 'completed' } }),
  ]);
  await post(bob, [
    ev('B', 'run_started'),
    done('B', 'planning', 3000),
    ev('B', 'gate_approved', { stage: 'gate_spec', attrs: { gate: 'gate_spec', wait_ms: 1000 } }),
    ev('B', 'gate_rejected', { stage: 'gate_spec', attrs: { gate: 'gate_spec', wait_ms: 1000, count: 1, reason: 'too broad' } }),
    ev('B', 'error', { stage: 'implement', attrs: { error_class: 'agent_crash' } }),
    ev('B', 'run_ended', { attrs: { status: 'aborted' } }),
    ev('C', 'run_started'), ev('C', 'session_unchecked', { attrs: { harness: 'generic' } }),
  ]);
});
test.after(() => stack.close());

const get = async (route) => (await stack.api('GET', route, { token: adminToken })).body;

test('summary: counts, run states and the risk breakdown', async () => {
  const s = await get('/admin/summary');
  assert.deepEqual(s.runs, { total: 3, active: 1, completed: 1, aborted: 1 });
  assert.equal(s.users, 3);
  assert.equal(s.errors, 4);
  assert.equal(s.gate_rejections, 2);
  assert.equal(s.agent_failures, 1);
  assert.deepEqual(s.risk, { scrubbed_hits: 1, no_hits: 1, not_checked: 1 });
});

test('time per stage: count, average, median, max and total', async () => {
  const rows = await get('/admin/stages');
  const by = Object.fromEntries(rows.map((r) => [r.stage, r]));
  assert.deepEqual(by.planning, { stage: 'planning', n: 2, avg_ms: 2000, median_ms: 2000, max_ms: 3000, total_ms: 4000 });
  assert.deepEqual(by.feasibility, { stage: 'feasibility', n: 1, avg_ms: 3000, median_ms: 3000, max_ms: 3000, total_ms: 3000 });
  assert.equal(by.tests.total_ms, 2000);
  assert.deepEqual(rows.map((r) => r.stage), ['planning', 'feasibility', 'tests'], 'ordered by total time');
});

test('errors by class and by stage', async () => {
  const e = await get('/admin/errors');
  assert.deepEqual(Object.fromEntries(e.by_class.map((r) => [r.error_class, r.n])), { test_failure: 2, guard_block: 1, agent_crash: 1 });
  assert.deepEqual(e.by_stage.find((r) => r.stage === 'implement' && r.error_class === 'test_failure'), { stage: 'implement', error_class: 'test_failure', n: 2 });
});

test('gates held back: per gate totals, waits, and who rejected why', async () => {
  const g = await get('/admin/gates');
  const by = Object.fromEntries(g.per_gate.map((r) => [r.gate, r]));
  assert.deepEqual(by.gate_spec, { gate: 'gate_spec', approved: 2, rejected: 1, avg_wait_ms: 2333 });
  assert.deepEqual(by.gate_approach, { gate: 'gate_approach', approved: 0, rejected: 1, avg_wait_ms: 9000 });
  const rej = Object.fromEntries(g.rejections.map((r) => [r.run_id, r]));
  assert.equal(rej.A.user_email, 'alice@example.com');
  assert.equal(rej.A.reason, 'unclear scope');
  assert.equal(rej.A.wait_ms, 9000);
  assert.equal(rej.B.user_email, 'bob@example.com');
  assert.equal(rej.B.reason, 'too broad');
});

test('agent failures and retries', async () => {
  const f = await get('/admin/agent-failures');
  assert.deepEqual(f.by_agent, [{ agent: 'solution-architect', error_class: 'timeout', n: 1 }]);
  assert.equal(f.recent[0].run_id, 'A');
  const r = await get('/admin/retries');
  assert.equal(r.total_rounds, 3);
  assert.deepEqual(r.by_run_stage, [{ run_id: 'A', stage: 'implement', rounds: 3, max_round: 3, cap: 5 }]);
});

test('runs list and per-run drill-down with the risk indicator', async () => {
  const runs = await get('/admin/runs');
  const by = Object.fromEntries(runs.map((r) => [r.id, r]));
  assert.equal(by.A.user_email, 'alice@example.com');
  assert.equal(by.A.status, 'completed');
  assert.equal(by.A.phi_pii_status, 'scrubbed_hits');
  assert.equal(by.A.errors, 3);
  assert.equal(by.A.rejections, 1);
  assert.equal(by.A.loop_rounds, 3);
  assert.equal(by.A.project, 'shop');
  assert.equal(by.B.status, 'aborted');
  assert.equal(by.C.phi_pii_status, 'not_checked');

  const detail = await get('/admin/runs/A');
  assert.equal(detail.run.id, 'A');
  assert.equal(detail.events.length, 15);
  assert.equal(detail.events[0].type, 'run_started');
  assert.equal((await stack.api('GET', '/admin/runs/nope', { token: adminToken })).status, 404);
});

test('users and invites listings', async () => {
  const users = await get('/admin/users');
  assert.deepEqual(users.map((u) => [u.email, u.role, u.runs]).sort(), [['admin@example.com', 'admin', 0], ['alice@example.com', 'user', 2 - 1], ['bob@example.com', 'user', 2]].sort());
  const invites = await get('/admin/invites');
  assert.equal(invites.length, 2);
  assert.ok(invites.every((i) => i.used_at && i.invited_by === 'admin@example.com'));
});

test('the dashboard page is served without data and with a strict CSP', async () => {
  const res = await fetch(`${stack.base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  const html = await res.text();
  assert.ok(!html.includes('alice@example.com'));
});

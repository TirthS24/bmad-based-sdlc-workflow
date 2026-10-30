// Stage 11: the server accepts the new event types and its views return rows for them.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ev, startPostgres, startStack } from './helpers.mjs';

const pg = await startPostgres();
test.after(() => pg.stop());

async function setup(t) {
  const s = await startStack(pg.url);
  t.after(() => s.close());
  const adminToken = await s.admin();
  const alice = await s.user(adminToken, 'alice@example.com');
  return { s, alice };
}
const post = (s, token, events) => s.api('POST', '/events', { token, body: { events } });

test('events: human_escalations, agent_run, stage_skipped and gate_auto_declined are accepted', async (t) => {
  const { s, alice } = await setup(t);
  const events = [
    ev('run-v', 'run_started', { attrs: { project: 'shop', harness: 'claude-code', profile: 'dev' } }),
    ev('run-v', 'human_escalations', { attrs: { count: 2 } }),
    ev('run-v', 'agent_run', { attrs: { agent: 'implementer', status: 'completed', started_at: '2026-10-30T10:00:00Z', ended_at: '2026-10-30T10:01:00Z', duration_ms: 60000 } }),
    ev('run-v', 'stage_skipped', { attrs: { stage: 'feasibility' } }),
    ev('run-v', 'gate_auto_declined', { attrs: { gate: 'gate_approach', condition: 'approach_low_risk' } }),
  ];
  const res = await post(s, alice, events);
  assert.deepEqual(res.body.rejected, []);
  assert.equal(res.body.accepted.length, events.length);
});

test('views: agent_timings, run_human_escalations and gate_decisions return rows', async (t) => {
  const { s, alice } = await setup(t);
  await post(s, alice, [
    ev('run-v2', 'run_started', { attrs: { project: 'shop', harness: 'claude-code', profile: 'dev' } }),
    ev('run-v2', 'human_escalations', { attrs: { count: 3 } }),
    ev('run-v2', 'agent_run', { stage: 'implement', attrs: { agent: 'implementer', status: 'completed', started_at: '2026-10-30T10:00:00Z', ended_at: '2026-10-30T10:01:00Z', duration_ms: 60000 } }),
    ev('run-v2', 'gate_approved', { attrs: { gate: 'gate_spec', wait_ms: 5, by: 'auto', condition: 'planning_clean' } }),
  ]);
  const timings = (await s.pool.query("SELECT agent, status, duration_ms FROM agent_timings WHERE run_id = 'run-v2'")).rows;
  assert.deepEqual(timings, [{ agent: 'implementer', status: 'completed', duration_ms: '60000' }]);
  const esc = (await s.pool.query("SELECT count FROM run_human_escalations WHERE run_id = 'run-v2'")).rows;
  assert.deepEqual(esc, [{ count: 3 }]);
  const gates = (await s.pool.query("SELECT gate, by, condition FROM gate_decisions WHERE run_id = 'run-v2'")).rows;
  assert.deepEqual(gates, [{ gate: 'gate_spec', by: 'auto', condition: 'planning_clean' }]);
});

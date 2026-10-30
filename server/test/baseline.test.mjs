// Five scripted end-to-end runs through the real CLI, sync, server and dashboard API. At least
// three finish with no manual fix, and the dashboard's numbers equal what the client recorded.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fresh } from '../../.agent-workflow/test/helpers.mjs';
import { makeWf, runPipeline, tempHome } from './baseline-script.mjs';
import { PASSWORD, startPostgres, startStack } from './helpers.mjs';

const pg = await startPostgres();
test.after(() => pg.stop());

// Everything the client queued, read before the sync deletes it. This is the "recorded" side.
function recorded(repo) {
  const dir = path.join(repo.wfDir, 'queue');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}

test('five scripted runs: most finish unaided, and the dashboard reproduces the recorded numbers', async (t) => {
  const s = await startStack(pg.url);
  t.after(() => s.close());
  const adminToken = await s.admin();
  await s.user(adminToken, 'dev@example.com');

  const home = tempHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const scenarios = ['clean', 'rejected', 'clean', 'stuck', 'aborted'];
  const results = [];
  const all = [];
  for (const [i, scenario] of scenarios.entries()) {
    const repo = fresh(t);
    repo.config({ telemetry: { required: true, server_url: s.base } });
    const remote = repo.addRemoteAndFakeGh();
    t.after(remote.cleanup);
    const wf = makeWf(repo, home);
    if (i === 0) assert.equal((await wf(['login', '--email', 'dev@example.com', '--password-stdin'], `${PASSWORD}\n`)).status, 0);
    results.push(await runPipeline({ repo, wf, name: `baseline run ${i + 1}`, scenario }));
    all.push(...recorded(repo));
    const sync = await wf(['sync']);
    assert.equal(sync.status, 0, sync.stdout + sync.stderr);
  }

  // Outcomes.
  assert.equal(results.filter((r) => r.completed).length, 4);
  assert.ok(results.filter((r) => r.completed && !r.manual).length >= 3, 'at least three completed with no manual fix');
  const runs = (await s.api('GET', '/admin/runs', { token: adminToken })).body;
  const by = Object.fromEntries(runs.map((r) => [r.id, r]));
  assert.equal(runs.length, 5);
  assert.deepEqual(results.map((r) => by[r.id].status), ['completed', 'completed', 'completed', 'completed', 'aborted']);
  assert.ok(runs.every((r) => r.phi_pii_status === 'no_hits'), 'the scrubber ran and found nothing in scripted runs');

  // Dashboard numbers equal the recorded ones.
  const sum = (type, key, group) => all.filter((e) => e.type === type).reduce((m, e) => { m[group(e)] = (m[group(e)] || 0) + Number(e.attrs[key]); return m; }, {});
  const stages = Object.fromEntries((await s.api('GET', '/admin/stages', { token: adminToken })).body.map((r) => [r.stage, r.total_ms]));
  assert.deepEqual(stages, sum('stage_completed', 'duration_ms', (e) => e.stage));
  assert.ok(Object.keys(stages).length >= 7);

  const count = (type) => all.filter((e) => e.type === type).length;
  const summary = (await s.api('GET', '/admin/summary', { token: adminToken })).body;
  assert.equal(summary.events, all.length);
  assert.equal(summary.errors, count('error'));
  assert.equal(summary.gate_rejections, count('gate_rejected'));
  assert.equal(summary.agent_failures, count('agent_failed'));
  assert.equal(count('gate_rejected'), 1);
  assert.equal(count('agent_failed'), 1);

  const errors = (await s.api('GET', '/admin/errors', { token: adminToken })).body.by_class;
  const recordedErrors = {};
  for (const e of all.filter((x) => x.type === 'error')) recordedErrors[e.attrs.error_class] = (recordedErrors[e.attrs.error_class] || 0) + 1;
  assert.deepEqual(Object.fromEntries(errors.map((r) => [r.error_class, r.n])), recordedErrors);
  assert.ok(recordedErrors.test_failure >= 1 && recordedErrors.agent_crash === 1 && recordedErrors.guard_block >= 1);

  const retries = (await s.api('GET', '/admin/retries', { token: adminToken })).body;
  assert.equal(retries.total_rounds, count('loop_round'));
  assert.ok(retries.total_rounds >= 1, 'the stuck run recorded its retry rounds');

  const gates = (await s.api('GET', '/admin/gates', { token: adminToken })).body.per_gate;
  const approved = Object.fromEntries(gates.map((g) => [g.gate, g.approved]));
  assert.equal(approved.gate_final, 4);
  assert.equal(approved.gate_spec, 3 + 1);
});

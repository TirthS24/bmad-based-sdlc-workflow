// Gates: approve, reject, and what each records.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { VALID_APPROACH, VALID_SRS, VALID_SPEC, VALID_TICKET_BE, VALID_TICKET_FE, fresh, withRun } from './helpers.mjs';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const GATES = ['gate_spec', 'gate_approach', 'gate_tests', 'gate_review', 'gate_final'];
const NEXT = {
  gate_spec: 'feasibility',
  gate_approach: 'tests',
  gate_tests: 'implement',
  gate_review: 'verify',
  gate_final: 'pr',
};
const PREV = {
  gate_spec: 'planning',
  gate_approach: 'feasibility',
  gate_tests: 'tests',
  gate_review: 'implement',
  gate_final: 'verify',
};

test('approve needs a run, a known gate, and the matching stage', (t) => {
  const repo = fresh(t);
  assert.match(repo.run(['approve', 'gate_spec']).stderr, /no active run/);
  repo.startRun('feat');
  assert.match(repo.run(['approve', 'gate_spec']).stderr, /current stage is planning, not gate_spec/);
  assert.match(repo.run(['approve', 'gate9']).stderr, /unknown gate gate9/);
  assert.match(repo.run(['approve', 'implement']).stderr, /unknown gate implement/, 'only human stages are gates');
  assert.match(repo.run(['approve', 'gate1']).stderr, /unknown gate gate1/, 'the old gate ids are gone');
});

test('every gate approval opens the next stage and records who/when/hashes', (t) => {
  const { repo, id } = withRun(t);
  repo.seedSpecs(id);
  for (const gate of GATES) {
    repo.setStage(gate);
    const res = repo.run(['approve', gate, ...(gate === 'gate_approach' ? ['--approach', 'B'] : [])]);
    assert.equal(res.status, 0, `${gate}: ${res.stderr}`);
    const s = repo.state();
    assert.equal(s.current.stage, NEXT[gate], gate);
    assert.equal(s.current.attempt, 1);
    assert.equal(s.gates[gate].status, 'approved');
    assert.match(s.gates[gate].approved_at, /^\d{4}-\d\d-\d\dT/);
    assert.equal(s.gates[gate].rejections, 0);
    assert.equal(s.gates[gate].spec_hash, sha(VALID_SRS));
    assert.equal(s.gates[gate].approach_hash, sha(VALID_APPROACH));
    assert.ok(s.gates[gate].tickets_hash, `${gate} tickets_hash`);
  }
  assert.deepEqual(repo.events().filter((e) => e.type === 'approve').map((e) => e.gate), GATES);
});

test('gate_approach requires --approach A|B|C and stores it', (t) => {
  const { repo } = withRun(t);
  repo.setStage('gate_approach');
  assert.match(repo.run(['approve', 'gate_approach']).stderr, /gate_approach requires --approach A\|B\|C/);
  assert.match(repo.run(['approve', 'gate_approach', '--approach', 'D']).stderr, /gate_approach requires --approach A\|B\|C/);
  assert.equal(repo.state().gates.gate_approach.status, 'pending');
  const res = repo.run(['approve', 'gate_approach', '--approach', 'C']);
  assert.equal(repo.state().gates.gate_approach.approach, 'C');
  assert.match(res.stdout, /^approach: C$/m);
  assert.deepEqual(repo.events().at(-1), { ts: repo.events().at(-1).ts, type: 'approve', gate: 'gate_approach', by: 'human', approach: 'C' });
});

test('other gates do not take an approach', (t) => {
  const { repo } = withRun(t);
  repo.setStage('gate_spec');
  assert.equal(repo.run(['approve', 'gate_spec', '--approach', 'A']).status, 0);
  assert.equal('approach' in repo.state().gates.gate_spec, false);
});

test('hashes are null for files that do not exist', (t) => {
  const { repo } = withRun(t);
  repo.setStage('gate_spec');
  assert.equal(repo.run(['approve', 'gate_spec']).status, 0);
  const g = repo.state().gates.gate_spec;
  assert.equal(g.spec_hash, null);
  assert.equal(g.approach_hash, null);
  assert.equal(g.tickets_hash, null);
});

test('reject needs a run, a gate, the matching stage and a reason', (t) => {
  const repo = fresh(t);
  assert.match(repo.run(['reject', 'gate_spec', '--reason', 'x']).stderr, /no active run/);
  repo.startRun('feat');
  assert.match(repo.run(['reject', 'gate_spec', '--reason', 'x']).stderr, /current stage is planning, not gate_spec/);
  repo.setStage('gate_spec');
  assert.match(repo.run(['reject', 'gate_spec']).stderr, /reject requires --reason "<why>"/);
  assert.match(repo.run(['reject', 'gate_spec', '--reason', '   ']).stderr, /reject requires --reason/);
  assert.match(repo.run(['reject', 'nope', '--reason', 'x']).stderr, /unknown gate nope/);
  assert.equal(repo.state().current.stage, 'gate_spec');
});

test('rejecting any gate returns to the stage before it, with the reason', (t) => {
  const { repo } = withRun(t);
  for (const gate of GATES) {
    repo.setStage(gate);
    const res = repo.run(['reject', gate, '--reason', `fix ${gate}`]);
    assert.equal(res.status, 0, `${gate}: ${res.stderr}`);
    const s = repo.state();
    assert.equal(s.current.stage, PREV[gate], gate);
    assert.match(s.current.next_action, new RegExp(`^Revise after ${gate} was rejected \\("fix ${gate}"\\)\\. `));
    assert.equal(s.gates[gate].status, 'rejected');
    assert.equal(s.gates[gate].reason, `fix ${gate}`);
    assert.match(s.gates[gate].rejected_at, /^\d{4}-/);
    assert.equal(s.stages[PREV[gate]], undefined, 'the stage is no longer done');
  }
  assert.deepEqual(repo.state().rejections.map((r) => r.gate), GATES);
  assert.deepEqual(repo.events().filter((e) => e.type === 'reject').map((e) => [e.gate, e.count]), GATES.map((g) => [g, 1]));
  assert.equal(JSON.stringify(repo.events()).includes('fix gate_'), false, 'free-text reasons stay out of events');
});

test('rejecting gate_review returns to implement and clears implement, review and their loop counters', (t) => {
  const { repo } = withRun(t);
  repo.update((s) => {
    s.current.stage = 'gate_review';
    s.stages.implement = { status: 'done' };
    s.stages.review = { status: 'done' };
    s.stages.tests = { status: 'done' };
    s.loops.implement = { round: 4, last_failing: ['REQ-1'] };
    s.loops.review = { round: 2 };
  });
  const res = repo.run(['reject', 'gate_review', '--reason', 'handler leaks errors']);
  assert.equal(res.status, 0, res.stderr);
  const s = repo.state();
  assert.equal(s.current.stage, 'implement');
  assert.match(s.current.next_action, /^Revise after gate_review was rejected \("handler leaks errors"\)\. Run \/wf-implement/);
  assert.equal(s.stages.implement, undefined);
  assert.equal(s.stages.review, undefined);
  assert.deepEqual(s.stages.tests, { status: 'done' }, 'earlier stages stay done');
  assert.deepEqual(s.loops.implement, { round: 0, last_failing: [] });
  assert.deepEqual(s.loops.review, { round: 0 });
  assert.match(repo.run(['status']).stdout, /^writes: allowed: src\/\*\*/m, 'implement can write again');
});

test('a rejected gate can be approved after the stage is redone, and counts rejections', (t) => {
  const { repo, id } = withRun(t);
  repo.seedSpecs(id);
  repo.setStage('gate_spec');
  repo.run(['reject', 'gate_spec', '--reason', 'first']);
  assert.equal(repo.state().current.attempt, 2);
  assert.equal(repo.run(['done', 'planning']).status, 0);
  assert.equal(repo.state().current.stage, 'gate_spec');
  repo.run(['reject', 'gate_spec', '--reason', 'second']);
  assert.equal(repo.state().current.attempt, 3);
  assert.equal(repo.run(['done', 'planning']).status, 0);
  assert.equal(repo.run(['approve', 'gate_spec']).status, 0);
  const s = repo.state();
  assert.equal(s.gates.gate_spec.status, 'approved');
  assert.equal(s.gates.gate_spec.rejections, 2);
  assert.equal(s.rejections.length, 2);
  assert.equal(s.current.stage, 'feasibility');
});

test('rejecting gate_tests clears the freeze hash so the tests can be rewritten', (t) => {
  const { repo } = withRun(t);
  repo.update((s) => { s.freeze.test_files_hash = 'abc'; s.current.stage = 'gate_tests'; });
  repo.run(['reject', 'gate_tests', '--reason', 'missing case']);
  assert.equal(repo.state().freeze.test_files_hash, null);
  assert.equal(repo.state().current.stage, 'tests');
});

test('the status line shows every gate', (t) => {
  const { repo } = withRun(t);
  repo.setStage('gate_spec');
  repo.run(['approve', 'gate_spec']);
  repo.setStage('gate_approach');
  repo.run(['reject', 'gate_approach', '--reason', 'r']);
  assert.match(repo.run(['status']).stdout, /^gates: spec=approved approach=rejected tests=pending review=pending final=pending$/m);
});

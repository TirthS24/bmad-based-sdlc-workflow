// Characterization: human gates (`approve`).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { VALID_APPROACH, VALID_SPEC, VALID_TEST_PLAN, fresh, withRun } from './helpers.mjs';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

test('approve needs a run, a known gate, and the matching stage', (t) => {
  const repo = fresh(t);
  assert.match(repo.run(['approve', 'gate1', '--approach', 'A']).stderr, /no active run/);
  repo.startRun('feat');
  assert.match(repo.run(['approve', 'gate1', '--approach', 'A']).stderr, /current stage is grill_spec, not gate1/);
  assert.match(repo.run(['approve', 'gate2']).stderr, /current stage is grill_spec, not gate2/);
  assert.match(repo.run(['approve', 'gate9']).stderr, /unknown gate gate9/);
});

test('gate1 requires --approach A|B|C', (t) => {
  const { repo } = withRun(t);
  repo.setStage('gate1');
  assert.match(repo.run(['approve', 'gate1']).stderr, /gate1 requires --approach A\|B\|C/);
  assert.match(repo.run(['approve', 'gate1', '--approach', 'D']).stderr, /gate1 requires --approach A\|B\|C/);
  assert.equal(repo.state().gates.gate1.status, 'pending');
});

test('gate1 records the approach and hashes of the three spec files, then opens tests', (t) => {
  const { repo, id } = withRun(t);
  repo.seedSpecs(id);
  repo.setStage('gate1');
  const res = repo.run(['approve', 'gate1', '--approach', 'B']);
  assert.equal(res.status, 0, res.stderr);
  const s = repo.state();
  assert.deepEqual(s.gates.gate1, {
    status: 'approved',
    approach: 'B',
    spec_hash: sha(VALID_SPEC),
    approach_hash: sha(VALID_APPROACH),
    test_plan_hash: sha(VALID_TEST_PLAN),
  });
  assert.equal(s.current.stage, 'tests');
  assert.match(s.current.next_action, /^Run \/wf-tests/);
  assert.match(res.stdout, /gate1: approved \(B\)/);
  assert.deepEqual(repo.events().at(-1), { ts: repo.events().at(-1).ts, type: 'approve', gate: 'gate1', approach: 'B' });
});

test('gate1 stores null hashes for files that do not exist', (t) => {
  const { repo } = withRun(t);
  repo.setStage('gate1');
  assert.equal(repo.run(['approve', 'gate1', '--approach', 'A']).status, 0);
  const g = repo.state().gates.gate1;
  assert.equal(g.spec_hash, null);
  assert.equal(g.approach_hash, null);
  assert.equal(g.test_plan_hash, null);
});

test('gate2 approval opens the pr stage', (t) => {
  const { repo } = withRun(t);
  repo.setStage('gate2');
  const res = repo.run(['approve', 'gate2']);
  assert.equal(res.status, 0, res.stderr);
  const s = repo.state();
  assert.deepEqual(s.gates.gate2, { status: 'approved' });
  assert.equal(s.current.stage, 'pr');
  assert.match(s.current.next_action, /^Run \/wf-pr/);
  assert.equal(repo.events().at(-1).gate, 'gate2');
});

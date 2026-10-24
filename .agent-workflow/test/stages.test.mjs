// Characterization: `done <stage>` postconditions and stage transitions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { VALID_APPROACH, VALID_SPEC, VALID_TEST_PLAN, withRun } from './helpers.mjs';

const fails = (res, re) => {
  assert.equal(res.status, 1, res.stdout);
  assert.match(res.stderr, re);
};

test('done needs an active run, the current stage, and a non-human stage', (t) => {
  const { repo } = withRun(t);
  fails(repo.run(['done', 'feasibility']), /current stage is grill_spec, not feasibility/);
  fails(repo.run(['done', 'bogus']), /current stage is grill_spec, not bogus/);
  repo.setStage('gate1');
  fails(repo.run(['done', 'gate1']), /human gates use wf approve, not wf done/);
  repo.setStage('nonexistent');
  fails(repo.run(['done', 'nonexistent']), /unknown stage nonexistent/);
  repo.run(['abort']);
  fails(repo.run(['done', 'grill_spec']), /no active run/);
});

test('grill_spec: needs SPEC.md, no open questions, REQ ids and success lines', (t) => {
  const { repo, id } = withRun(t);
  const spec = `specs/spec-${id}/SPEC.md`;
  fails(repo.run(['done', 'grill_spec']), /postcondition failed: missing specs\/spec-.*\/SPEC\.md/);
  repo.file(spec, `${VALID_SPEC}\n[OPEN QUESTION] who?\n`);
  fails(repo.run(['done', 'grill_spec']), /SPEC\.md still contains \[OPEN QUESTION\] markers/);
  repo.file(spec, '# Spec\nno ids here\n');
  fails(repo.run(['done', 'grill_spec']), /SPEC\.md has no numbered REQ-n IDs/);
  repo.file(spec, '# Spec\n- **REQ-1** Do the thing\n  - detail only\n');
  fails(repo.run(['done', 'grill_spec']), /REQ-1 is missing a success condition/);
  repo.file(spec, VALID_SPEC);
  const ok = repo.run(['done', 'grill_spec', '--result', spec]);
  assert.equal(ok.status, 0, ok.stderr);
  const s = repo.state();
  assert.equal(s.current.stage, 'feasibility');
  assert.equal(s.current.attempt, 1);
  assert.equal(s.stages.grill_spec.status, 'done');
  assert.equal(s.stages.grill_spec.result, spec);
  assert.ok(s.stages.grill_spec.finished_at);
  assert.match(s.current.next_action, /^Run \/wf-feasibility/);
  assert.deepEqual(repo.events().at(-1), { ts: repo.events().at(-1).ts, type: 'done', stage: 'grill_spec', next: 'feasibility', result: spec });
});

test('grill_spec: every REQ needs its own success line', (t) => {
  const { repo, id } = withRun(t);
  repo.file(`specs/spec-${id}/SPEC.md`, '# Spec\n- **REQ-1** one\n  - **success:** yes\n- **REQ-2** two\n  - nothing\n');
  fails(repo.run(['done', 'grill_spec']), /REQ-2 is missing a success condition/);
});

test('feasibility: verdict, two approaches, single-commit line', (t) => {
  const { repo, id } = withRun(t);
  repo.setStage('feasibility');
  const p = `specs/spec-${id}/approach.md`;
  fails(repo.run(['done', 'feasibility']), /missing specs\/spec-.*\/approach\.md/);
  repo.file(p, '# Approach\n## A\n## B\none commit\n');
  fails(repo.run(['done', 'feasibility']), /approach\.md needs a verdict: as-is \/ with-changes \/ not-satisfiable/);
  repo.file(p, '# Approach\nVerdict: as-is\n## Only one\none commit\n');
  fails(repo.run(['done', 'feasibility']), /approach\.md needs at least 2 approaches/);
  repo.file(p, '# Approach\nVerdict: as-is\n## A\n## B\n');
  fails(repo.run(['done', 'feasibility']), /approach\.md needs a single-commit-fit line/);
  repo.file(p, VALID_APPROACH);
  assert.equal(repo.run(['done', 'feasibility', '--result', p]).status, 0);
  assert.equal(repo.state().current.stage, 'test_plan');
});

test('feasibility: two named approaches count even without headings', (t) => {
  const { repo, id } = withRun(t);
  repo.setStage('feasibility');
  repo.file(`specs/spec-${id}/approach.md`, 'Verdict: as-is\nApproach A is small. Approach B is big. one commit.\n');
  assert.equal(repo.run(['done', 'feasibility']).status, 0);
});

test('test_plan: covers every REQ and tags every scenario', (t) => {
  const { repo, id } = withRun(t);
  repo.setStage('test_plan');
  const dir = `specs/spec-${id}`;
  fails(repo.run(['done', 'test_plan']), /missing SPEC\.md/);
  repo.file(`${dir}/SPEC.md`, VALID_SPEC);
  fails(repo.run(['done', 'test_plan']), /missing test-plan\.md/);
  repo.file(`${dir}/test-plan.md`, '# Plan\n- PRD-1.1 (e2e, automated)\n');
  fails(repo.run(['done', 'test_plan']), /test-plan\.md has no scenario for REQ-1/);
  repo.file(`${dir}/test-plan.md`, '# Plan\nREQ-1 covered.\n');
  fails(repo.run(['done', 'test_plan']), /test-plan\.md has no PRD-n\.m or TECH-\* scenarios/);
  repo.file(`${dir}/test-plan.md`, '# Plan\nREQ-1\n- PRD-1.1 happy path (automated)\n');
  fails(repo.run(['done', 'test_plan']), /scenario missing layer: - PRD-1\.1 happy path \(automated\)/);
  repo.file(`${dir}/test-plan.md`, '# Plan\nREQ-1\n- PRD-1.1 happy path (e2e)\n');
  fails(repo.run(['done', 'test_plan']), /scenario missing automated\/manual\/N\/A tag: - PRD-1\.1 happy path \(e2e\)/);
  repo.file(`${dir}/test-plan.md`, VALID_TEST_PLAN);
  assert.equal(repo.run(['done', 'test_plan']).status, 0);
  assert.equal(repo.state().current.stage, 'gate1');
  assert.match(repo.state().current.next_action, /^Human: choose approach A\|B\|C/);
});

test('test_plan: TECH scenarios are checked too', (t) => {
  const { repo, id } = withRun(t);
  repo.setStage('test_plan');
  repo.file(`specs/spec-${id}/SPEC.md`, VALID_SPEC);
  repo.file(`specs/spec-${id}/test-plan.md`, 'REQ-1\n- TECH-api-404 returns 404 (api, automated)\n');
  assert.equal(repo.run(['done', 'test_plan']).status, 0);
});

test('tests: new tests must fail and cite an id, then the freeze hash is stored', (t) => {
  const { repo } = withRun(t);
  repo.setStage('tests');
  repo.config({ commands: { unit: 'exit 0' } });
  fails(repo.run(['done', 'tests']), /new tests must fail \(wf verify unit exited 0\)/);
  repo.config({ commands: { unit: 'echo boom; exit 1' } });
  fails(repo.run(['done', 'tests']), /failing tests must cite REQ \/ TECH \/ PRD ids/);
  repo.config({ commands: { unit: 'echo "FAILED REQ-1 happy"; exit 1' } });
  repo.file('tests/test_a.py', 'A');
  assert.equal(repo.run(['done', 'tests', '--result', 'tests']).status, 0);
  const s = repo.state();
  assert.equal(s.current.stage, 'implement');
  assert.match(s.freeze.test_files_hash, /^[0-9a-f]{64}$/);
});

test('tests: a skipped unit tier counts as not failing', (t) => {
  const { repo } = withRun(t);
  repo.setStage('tests');
  repo.config({ commands: { unit: '' } });
  fails(repo.run(['done', 'tests']), /new tests must fail/);
});

test('freeze hash follows test_globs content only', (t) => {
  const { repo } = withRun(t);
  repo.config({ commands: { unit: 'echo "FAILED TECH-x"; exit 1' } });
  const hashFor = () => {
    repo.setStage('tests');
    assert.equal(repo.run(['done', 'tests']).status, 0);
    return repo.state().freeze.test_files_hash;
  };
  repo.file('tests/test_a.py', 'A');
  const h1 = hashFor();
  assert.equal(hashFor(), h1, 'same content, same hash');
  repo.file('src/app.py', 'unrelated');
  assert.equal(hashFor(), h1, 'files outside test_globs do not matter');
  repo.file('tests/test_a.py', 'B');
  assert.notEqual(hashFor(), h1, 'edited test file changes the hash');
  const h3 = hashFor();
  repo.file('web/button.test.ts', 'new');
  assert.notEqual(hashFor(), h3, 'a new file matching **/*.test.ts changes the hash');
});

test('implement: unit and lint must pass', (t) => {
  const { repo } = withRun(t);
  repo.setStage('implement');
  repo.config({ commands: { unit: 'exit 1', lint: 'exit 0' } });
  fails(repo.run(['done', 'implement']), /unit failed \(exit 1\)/);
  repo.config({ commands: { unit: 'exit 0', lint: 'exit 2' } });
  fails(repo.run(['done', 'implement']), /lint failed \(exit 2\)/);
  repo.config({ commands: { unit: 'exit 0', lint: '' } });
  assert.equal(repo.run(['done', 'implement']).status, 0);
  assert.equal(repo.state().current.stage, 'review');
});

test('review: open high / decision-needed findings block verify', (t) => {
  const { repo } = withRun(t);
  repo.setStage('review');
  fails(repo.run(['done', 'review', '--result', 'review.md']), /missing review output: review\.md/);
  repo.file('review.md', '- [high] SQL injection in handler\n');
  fails(repo.run(['done', 'review', '--result', 'review.md']), /review still has open high \/ decision-needed findings/);
  repo.file('review.md', '- [decision-needed] pick a queue\n');
  fails(repo.run(['done', 'review', '--result', 'review.md']), /review still has open high/);
  repo.file('review.md', '- [medium] rename helper\nopen: 0\n');
  assert.equal(repo.run(['done', 'review', '--result', 'review.md']).status, 0);
  assert.equal(repo.state().current.stage, 'verify');
});

test('review: "no findings tagged", or any of resolved / fixed / closed, lets the stage through', (t) => {
  const { repo } = withRun(t);
  for (const text of [
    'no findings tagged high\n',
    '- [high] bug\nresolved in round 2\n',
    '- [high] bug fixed\n',
    'all good\n',
  ]) {
    repo.setStage('review');
    repo.file('review.md', text);
    assert.equal(repo.run(['done', 'review', '--result', 'review.md']).status, 0, text);
  }
});

test('verify: runs every tier and needs a non-empty evidence bundle', (t) => {
  const { repo, id } = withRun(t);
  repo.setStage('verify');
  repo.config({ commands: { unit: 'exit 0', lint: 'exit 0', complexity: '', e2e: 'exit 4', a11y: '' } });
  fails(repo.run(['done', 'verify']), /e2e failed \(exit 4\)/);
  repo.config({ commands: { e2e: '' } });
  fails(repo.run(['done', 'verify']), /missing evidence bundle: .*runs\/.*\/evidence/);
  const evidence = path.join(repo.wfDir, 'runs', id, 'evidence');
  fs.mkdirSync(evidence, { recursive: true });
  fails(repo.run(['done', 'verify']), /evidence directory is empty/);
  fs.writeFileSync(path.join(evidence, 'shot.png'), 'x');
  assert.equal(repo.run(['done', 'verify']).status, 0);
  assert.equal(repo.state().current.stage, 'gate2');
  assert.match(repo.state().current.next_action, /^Human: \/wf-approve-manual/);
});

test('verify: an explicit --result path overrides the default evidence dir', (t) => {
  const { repo } = withRun(t);
  repo.setStage('verify');
  repo.config({ commands: { unit: '', lint: '', complexity: '', e2e: '', a11y: '' } });
  repo.file('out/evidence.txt', 'x');
  assert.equal(repo.run(['done', 'verify', '--result', 'out/evidence.txt']).status, 0);
});

test('pr: exactly one commit since the baseline, then the run is done', (t) => {
  const { repo } = withRun(t);
  repo.setStage('pr');
  fails(repo.run(['done', 'pr']), /expected exactly 1 commit since [0-9a-f]{40}, found 0/);
  repo.commit('one');
  repo.commit('two');
  fails(repo.run(['done', 'pr']), /found 2/);
  repo.update((s) => { s.run.baseline_sha = repo.git('rev-parse', 'HEAD~1').stdout.trim(); });
  assert.equal(repo.run(['done', 'pr']).status, 0);
  const s = repo.state();
  assert.equal(s.current.stage, 'done');
  assert.equal(s.current.next_action, 'Run complete. No further pipeline action.');
});

test('pr: an unknown baseline counts as -1 commits', (t) => {
  const { repo } = withRun(t);
  repo.setStage('pr');
  repo.update((s) => { s.run.baseline_sha = 'deadbeef'; });
  fails(repo.run(['done', 'pr']), /found -1/);
});

test('stage order matches workflow.json', (t) => {
  const { repo } = withRun(t);
  const wf = JSON.parse(fs.readFileSync(path.join(repo.wfDir, 'workflow.json'), 'utf8'));
  assert.deepEqual(
    wf.stages.map((s) => s.id),
    ['grill_spec', 'feasibility', 'test_plan', 'gate1', 'tests', 'implement', 'review', 'verify', 'gate2', 'pr'],
  );
  assert.deepEqual(
    wf.stages.filter((s) => s.executor === 'human').map((s) => s.id),
    ['gate1', 'gate2'],
  );
});

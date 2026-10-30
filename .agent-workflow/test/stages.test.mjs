// Characterization: `done <stage>` postconditions and stage transitions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ADR, AXES, VALID_APPROACH, VALID_SRS, VALID_SPEC, withRun } from './helpers.mjs';

const fails = (res, re) => {
  assert.equal(res.status, 1, res.stdout);
  assert.match(res.stderr, re);
};

test('done needs an active run, the current stage, and a non-human stage', (t) => {
  const { repo } = withRun(t);
  fails(repo.run(['done', 'feasibility']), /current stage is planning, not feasibility/);
  fails(repo.run(['done', 'bogus']), /current stage is planning, not bogus/);
  repo.setStage('gate_spec');
  fails(repo.run(['done', 'gate_spec']), /human gates use wf approve, not wf done/);
  repo.setStage('nonexistent');
  fails(repo.run(['done', 'nonexistent']), /unknown stage nonexistent/);
  repo.run(['abort']);
  fails(repo.run(['done', 'planning']), /no active run/);
});

test('planning: needs SRS.md, questions, tickets, REQ ids and success lines', (t) => {
  const { repo, id } = withRun(t);
  const srs = `specs/spec-${id}/SRS.md`;
  fails(repo.run(['done', 'planning']), /postcondition failed: missing specs\/spec-.*\/SRS\.md/);
  repo.file(srs, `${VALID_SRS}\n[OPEN QUESTION] who?\n`);
  fails(repo.run(['done', 'planning']), /SRS\.md still contains \[OPEN QUESTION\] markers/);
  repo.file(srs, VALID_SRS);
  fails(repo.run(['done', 'planning']), /missing grill\/questions\.json/);
  repo.seedPlanning(id);
  const ok = repo.run(['done', 'planning', '--result', srs]);
  assert.equal(ok.status, 0, ok.stderr);
  const s = repo.state();
  assert.equal(s.current.stage, 'gate_spec');
  assert.equal(s.current.attempt, 1);
  assert.equal(s.stages.planning.status, 'done');
  assert.equal(s.stages.planning.result, srs);
  assert.ok(s.stages.planning.finished_at);
  assert.match(s.current.next_action, /^Human: review SRS\.md/);
  assert.deepEqual(repo.events().at(-1), {
    ts: repo.events().at(-1).ts,
    type: 'done',
    stage: 'planning',
    next: 'gate_spec',
    result: srs,
    human_escalations: 1,
  });
});

test('planning: every REQ needs its own success line', (t) => {
  const { repo, id } = withRun(t);
  repo.seedPlanning(id);
  const bad = VALID_SRS.replace(
    '## 7 Traceability',
    '- **REQ-2** second\n  intent: more\n  detail only\n## 7 Traceability',
  );
  repo.file(`specs/spec-${id}/SRS.md`, bad);
  fails(repo.run(['done', 'planning']), /REQ-2 is missing a success condition/);
});

test('feasibility: verdict, two approaches, single-commit line', (t) => {
  const { repo, id } = withRun(t);
  repo.setStage('feasibility');
  const p = `specs/spec-${id}/approach.md`;
  fails(repo.run(['done', 'feasibility']), /missing specs\/spec-.*\/approach\.md/);
  repo.file(p, `# Approach\n## A\n## B\none commit\n${ADR}`);
  fails(repo.run(['done', 'feasibility']), /approach\.md needs a verdict: as-is \/ with-changes \/ not-satisfiable/);
  repo.file(p, `# Approach\nVerdict: as-is\n## Only one\none commit\n${ADR}`);
  fails(repo.run(['done', 'feasibility']), /approach\.md needs at least 2 approaches/);
  repo.file(p, `# Approach\nVerdict: as-is\n## A\n## B\n${ADR}`);
  fails(repo.run(['done', 'feasibility']), /approach\.md needs a single-commit-fit line/);
  repo.file(p, VALID_APPROACH);
  assert.equal(repo.run(['done', 'feasibility', '--result', p]).status, 0);
  assert.equal(repo.state().current.stage, 'gate_approach');
});

test('feasibility: two named approaches count even without headings', (t) => {
  const { repo, id } = withRun(t);
  repo.setStage('feasibility');
  repo.file(`specs/spec-${id}/approach.md`, `Verdict: as-is\nApproach A is small. Approach B is big. one commit.\n${ADR}`);
  assert.equal(repo.run(['done', 'feasibility']).status, 0);
});

test('tests: new tests must fail and cite an id, then the freeze hash is stored', (t) => {
  const { repo } = withRun(t);
  repo.setStage('tests');
  repo.config({ commands: { unit: 'exit 0' } });
  fails(repo.run(['done', 'tests']), /new tests must fail \(the unit tier exited 0\)/);
  repo.config({ commands: { unit: 'echo boom; exit 1' } });
  fails(repo.run(['done', 'tests']), /failing tests must cite REQ \/ TECH \/ PRD ids/);
  repo.config({ commands: { unit: 'echo "FAILED REQ-1 happy"; exit 1' } });
  repo.file('tests/test_a.py', 'A');
  assert.equal(repo.run(['done', 'tests', '--result', 'tests']).status, 0);
  const s = repo.state();
  assert.equal(s.current.stage, 'gate_tests');
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

test('review: open high findings block, decision-needed goes to the gate', (t) => {
  const { repo } = withRun(t);
  repo.setStage('review');
  fails(repo.run(['done', 'review', '--result', 'review.md']), /missing review output: review\.md/);
  repo.file('review.md', `${AXES}- [high] SQL injection in handler\n`);
  fails(repo.run(['done', 'review', '--result', 'review.md']), /review still has open high findings \(1\): - \[high\] SQL injection/);
  repo.file('review.md', `${AXES}- [medium] rename helper\n- [decision-needed] pick a queue\n`);
  assert.equal(repo.run(['done', 'review', '--result', 'review.md']).status, 0);
  assert.equal(repo.state().current.stage, 'gate_review');
});

test('review: each high finding is judged on its own line', (t) => {
  const { repo } = withRun(t);
  const blocked = [
    '- [high] src/a.py:3 - injection - use params\n',
    '- [high] bug\nresolved in round 2\n',
    '- [high] bug fixed\n',
    '- [high][resolved] a\n* **high**: b\n',
    'no findings tagged\n- [high] still here\n',
  ];
  for (const text of blocked) {
    repo.setStage('review');
    repo.file('review.md', AXES + text);
    fails(repo.run(['done', 'review', '--result', 'review.md']), /review still has open high findings/);
  }
  for (const text of [
    'no findings tagged high\n',
    '- [high][resolved] src/a.py:3 - injection - use params\n',
    '- [low] high memory use in a loop\n',
    'all good\n',
  ]) {
    repo.setStage('review');
    repo.file('review.md', AXES + text);
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
  assert.equal(repo.state().current.stage, 'gate_final');
  assert.match(repo.state().current.next_action, /^Human: read the evidence bundle/);
  assert.deepEqual(repo.state().stages.verify.tiers.map((t) => [t.tier, t.skipped, t.code]), [
    ['unit', false, 0], ['lint', false, 0], ['typecheck', true, 0], ['format', true, 0], ['complexity', true, 0], ['e2e', true, 0], ['a11y', true, 0],
  ]);
});

test('verify: an explicit --result path overrides the default evidence dir', (t) => {
  const { repo } = withRun(t);
  repo.setStage('verify');
  repo.config({ commands: { unit: '', lint: '', complexity: '', e2e: '', a11y: '' } });
  repo.file('out/evidence.txt', 'x');
  assert.equal(repo.run(['done', 'verify', '--result', 'out/evidence.txt']).status, 0);
});

const PR_URL = 'https://github.com/acme/app/pull/12';

test('pr: result must be a GitHub PR URL and there must be a commit since the baseline', (t) => {
  const { repo } = withRun(t);
  repo.setStage('pr');
  fails(repo.run(['done', 'pr']), /pr result must be the GitHub PR URL/);
  fails(repo.run(['done', 'pr', '--result', 'abc123']), /pr result must be the GitHub PR URL/);
  fails(repo.run(['done', 'pr', '--result', 'https://gerrit.example.com/c/1']), /pr result must be the GitHub PR URL/);
  fails(repo.run(['done', 'pr', '--result', PR_URL]), /expected at least 1 commit since [0-9a-f]{40}, found 0/);
  repo.commit('one');
  repo.commit('two');
  assert.equal(repo.run(['done', 'pr', '--result', PR_URL]).status, 0);
  const s = repo.state();
  assert.equal(s.current.stage, 'done');
  assert.equal(s.current.next_action, 'Run complete. No further pipeline action.');
});

test('pr: an unknown baseline counts as -1 commits', (t) => {
  const { repo } = withRun(t);
  repo.setStage('pr');
  repo.update((s) => { s.run.baseline_sha = 'deadbeef'; });
  fails(repo.run(['done', 'pr', '--result', PR_URL]), /found -1/);
});

test('stage order matches workflow.json', (t) => {
  const { repo } = withRun(t);
  const wf = JSON.parse(fs.readFileSync(path.join(repo.wfDir, 'workflow.json'), 'utf8'));
  assert.deepEqual(
    wf.stages.map((s) => s.id),
    [
      'planning', 'gate_spec', 'feasibility', 'gate_approach', 'tests', 'gate_tests',
      'implement', 'review', 'gate_review', 'verify', 'gate_final', 'pr',
    ],
  );
  assert.deepEqual(
    wf.stages.filter((s) => s.executor === 'human').map((s) => s.id),
    ['gate_spec', 'gate_approach', 'gate_tests', 'gate_review', 'gate_final'],
  );
  // implementation is the only working stage whose exit has no human gate
  const ids = wf.stages.map((x) => x.id);
  assert.equal(wf.stages[ids.indexOf('implement') + 1].id, 'review');
});

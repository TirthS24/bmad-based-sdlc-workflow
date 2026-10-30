// Stage 6: run profiles (full, pm, dev, docs) — doctor rules, stage skipping, rejection targets,
// goto, `wf profile`, scoped writes and derived review sections.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertOk, fresh, runFile, withRun } from './helpers.mjs';

const REAL_WORKFLOW = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'workflow.json');

// A repo with the real skills, agents and capability manifest, so doctor checks only the profiles.
function doctorRepo(t) {
  const repo = fresh(t);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  for (const d of ['.cursor/skills', '.cursor/agents']) fs.cpSync(path.join(root, d), path.join(repo.root, d), { recursive: true });
  for (const f of ['capabilities.json', 'standards.md']) fs.copyFileSync(path.join(root, '.agent-workflow', f), path.join(repo.wfDir, f));
  return repo;
}

// Start a run under a profile in a fresh repo (the fixture's config has blank unit/lint commands).
function startProfileRun(t, profile, source = 'task') {
  const repo = fresh(t);
  repo.config({ commands: { unit: '', lint: '' } });
  assertOk(repo.run(['run', '--profile', profile, source]));
  return repo;
}

// ---- doctor: each validation rule in 4a.1 fails with its message ----------------------------

test('doctor: each profile validation rule is reported', (t) => {
  const cases = [
    ['pm skips the planning stage', (wf) => { wf.profiles.pm.skip.push('planning'); }, /profile pm: planning cannot be skipped/],
    ['pm skips gate_spec', (wf) => { wf.profiles.pm.skip.push('gate_spec'); }, /profile pm: gate_spec cannot be skipped/],
    ['an auto key that is not a gate', (wf) => { wf.profiles.dev.auto.planning = 'planning_clean'; }, /profile dev: auto planning is not a gate/],
    ['an unknown condition', (wf) => { wf.profiles.dev.auto.gate_tests = 'nope'; }, /profile dev: gate_tests has unknown condition nope/],
    ['gate_final auto under another condition', (wf) => { wf.profiles.pm.auto.gate_final = 'planning_clean'; }, /gate_final may only auto-pass under specs_only_unchanged/],
    ['specs_only_unchanged without pr_paths', (wf) => { delete wf.profiles.pm.pr_paths; }, /profile pm: specs_only_unchanged needs pr_paths/],
    ['writes for an unknown stage', (wf) => { wf.profiles.docs.writes.nope = ['x']; }, /profile docs: writes for unknown stage nope/],
    ['an unknown write token', (wf) => { wf.profiles.docs.writes.implement = ['<bogus>']; }, /profile docs: unknown write token <bogus>/],
    ['an unknown verify tier', (wf) => { wf.profiles.docs.verify_tiers = ['magic']; }, /profile docs: unknown verify tier magic/],
    ['full with a skip', (wf) => { wf.profiles.full.skip = ['tests']; }, /profile full must not skip or auto-pass anything/],
  ];
  for (const [name, edit, msg] of cases) {
    const repo = doctorRepo(t);
    const wf = JSON.parse(fs.readFileSync(REAL_WORKFLOW, 'utf8'));
    edit(wf);
    fs.writeFileSync(path.join(repo.wfDir, 'workflow.json'), JSON.stringify(wf, null, 2));
    const res = repo.run(['doctor']);
    assert.equal(res.status, 1, `${name}: expected doctor to fail`);
    assert.match(res.stderr, msg, name);
  }
});

// ---- pm: tickets only; the run skips straight to gate_final -----------------------------------

test('pm: after gate_spec the run skips to gate_final, which auto-passes when only specs changed', (t) => {
  const repo = startProfileRun(t, 'pm', 'docs only');
  repo.seedPlanning(repo.state().run.id);
  assertOk(repo.run(['done', 'planning']));
  assertOk(repo.run(['approve', 'gate_spec']));
  const s = repo.state();
  assert.equal(s.stages.feasibility.status, 'skipped');
  assert.equal(s.gates.gate_approach.status, 'skipped');
  assert.match(repo.run(['status']).stdout, /^profile: pm$/m);
  // gate_final auto-passes: only specs changed, and the SRS and tickets match gate_spec.
  assert.equal(s.current.stage, 'pr');
  assert.equal(s.gates.gate_final.approved_by, 'auto');
  assert.equal(s.gates.gate_final.condition, 'specs_only_unchanged');
});

test('pm: goto refuses a stage the profile skips', (t) => {
  const repo = startProfileRun(t, 'pm', 'docs only');
  repo.seedPlanning(repo.state().run.id);
  assertOk(repo.run(['done', 'planning']));
  assertOk(repo.run(['approve', 'gate_spec']));
  const res = repo.run(['goto', 'tests']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /tests is skipped by profile pm/);
});

test('wf profile: changes during planning are recorded; refused once gate_spec is approved', (t) => {
  const { repo } = withRun(t);
  assertOk(repo.run(['profile', 'docs']));
  assert.equal(repo.state().run.profile, 'docs');
  assert.equal(repo.state().run.profile_changes.length, 1);
  repo.seedPlanning(repo.state().run.id);
  assertOk(repo.run(['done', 'planning']));
  assertOk(repo.run(['approve', 'gate_spec']));
  const res = repo.run(['profile', 'full']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /profile is fixed once gate_spec is approved/);
});

// ---- docs: writes scoped to docs, tests skipped, review without the code axes -----------------

test('docs: implement writes docs only; review needs Standards and Spec conformance and nothing else', (t) => {
  const repo = startProfileRun(t, 'docs', 'handover docs');
  repo.seedPlanning(repo.state().run.id);
  assertOk(repo.run(['done', 'planning']));
  assertOk(repo.run(['approve', 'gate_spec']));
  const s = repo.state();
  assert.equal(s.current.stage, 'implement');
  assert.equal(s.stages.tests.status, 'skipped');

  repo.file('backend/payments.py', 'x = 1\n');
  assert.match(repo.run(['done', 'implement']).stderr, /writes stay in scope: found backend\/payments\.py/);
  fs.rmSync(path.join(repo.root, 'backend/payments.py'));
  repo.file('docs/handover.md', '# Handover\n');
  assertOk(repo.run(['done', 'implement']));
  assert.equal(repo.state().current.stage, 'review');

  repo.file(runFile(repo, 'review.md'), '## Standards\n- open: 0\n## Spec conformance\n- open: 0\n');
  assertOk(repo.run(['done', 'review', '--result', runFile(repo, 'review.md')]));
  // gate_review auto-passes: no open high or decision-needed findings.
  assert.equal(repo.state().current.stage, 'verify');
  assert.equal(repo.state().gates.gate_review.approved_by, 'auto');
});

test('docs: verify with blank tiers still passes and writes tiers.md saying so', (t) => {
  const repo = startProfileRun(t, 'docs', 'handover docs');
  repo.setStage('verify');
  assertOk(repo.run(['done', 'verify']));
  const tiers = fs.readFileSync(path.join(repo.wfDir, 'runs', repo.state().run.id, 'evidence', 'tiers.md'), 'utf8');
  assert.match(tiers, /No automated checks configured for this profile/);
});

// ---- dev: one approach is enough -------------------------------------------------------------

test('dev: feasibility accepts one approach', (t) => {
  const repo = startProfileRun(t, 'dev', 'alpha bug');
  repo.setStage('feasibility');
  repo.file(`specs/spec-${repo.state().run.id}/approach.md`, [
    'Verdict: as-is',
    '## Approach A',
    'Fix the guard in the shared helper. Fits one commit.',
    '## Decision',
    'Approach A.',
    '## Non-functional',
    'None.',
    '## Risks',
    'Low.',
    '## Rollback',
    'Revert.',
  ].join('\n'));
  assertOk(repo.run(['done', 'feasibility']));
});

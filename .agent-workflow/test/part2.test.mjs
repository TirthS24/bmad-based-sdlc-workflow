// Phase 1B part 2: doctor, goto, escalation, brief, the new artifact checks, PR decision record.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ADR, AXES, VALID_APPROACH, VALID_SRS, VALID_SPEC, fresh, withRun } from './helpers.mjs';

const REAL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fails = (res, re) => {
  assert.equal(res.status, 1, res.stdout);
  assert.match(res.stderr, re);
};

// ---- doctor ------------------------------------------------------------------------------

function doctorRepo(t) {
  const repo = fresh(t);
  for (const d of ['.cursor/skills', '.cursor/agents']) {
    fs.cpSync(path.join(REAL_ROOT, d), path.join(repo.root, d), { recursive: true });
  }
  for (const f of ['capabilities.json', 'standards.md']) {
    fs.copyFileSync(path.join(REAL_ROOT, '.agent-workflow', f), path.join(repo.wfDir, f));
  }
  return repo;
}
const manifest = (repo, fn) => {
  const file = path.join(repo.wfDir, 'capabilities.json');
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  fn(m);
  fs.writeFileSync(file, JSON.stringify(m));
};

test('doctor: the shipped capability set is consistent', (t) => {
  const repo = doctorRepo(t);
  const res = repo.run(['doctor']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /consistent/);
});

test('doctor: each kind of inconsistency is reported', (t) => {
  const cases = [
    ['a stage with no capability', (r) => manifest(r, (m) => { delete m.stages.verify; }), /stage verify has no capability/],
    ['a manifest skill that is missing', (r) => fs.rmSync(path.join(r.root, '.cursor/skills/wf-verify'), { recursive: true }), /skill wf-verify not found/],
    ['a manifest agent that is missing', (r) => fs.rmSync(path.join(r.root, '.cursor/agents/verifier.md')), /agent verifier not found/],
    ['an unreferenced skill', (r) => r.file('.cursor/skills/wf-orphan/SKILL.md', '---\nname: wf-orphan\n---\n'), /skill wf-orphan is not referenced/],
    ['an unreferenced agent', (r) => r.file('.cursor/agents/orphan.md', '---\nname: orphan\n---\n'), /agent orphan is not referenced/],
    ['a read-only agent with a write tool', (r) => r.file('.cursor/agents/code-reviewer.md', '---\nname: code-reviewer\nreadonly: true\ntools: Read, Write\n---\n'), /readonly but lists a write tool/],
    ['a duplicate skill name', (r) => r.file('.agents/skills/wf-verify/SKILL.md', '---\nname: wf-verify\n---\n'), /duplicate skill wf-verify/],
    ['an oversized wf skill', (r) => r.file('.cursor/skills/wf-verify/SKILL.md', `${'x\n'.repeat(160)}`), /wf-verify\/SKILL\.md is over 150 lines/],
    ['a retired term (Gerrit)', (r) => r.file('.cursor/skills/wf-pr/SKILL.md', 'Push to refs/for/main for Gerrit\n'), /retired term/],
    ['a retired term (gate1)', (r) => r.file('.cursor/agents/verifier.md', '---\nname: verifier\n---\nafter gate1\n'), /retired term \(gate1\)/],
    ['a rule section that does not exist', (r) => manifest(r, (m) => { m.stages.pr.rules = ['No Such Section']; }), /no "No Such Section" section/],
    ['an unknown stage in the manifest', (r) => manifest(r, (m) => { m.stages.bogus = { skills: ['wf-pr'] }; }), /unknown stage bogus/],
    ['an executor agent missing from its capability', (r) => manifest(r, (m) => { m.stages.implement.agents = []; }), /executor agent implementer is not in its capability/],
  ];
  for (const [name, mutate, re] of cases) {
    const repo = doctorRepo(t);
    mutate(repo);
    const res = repo.run(['doctor']);
    assert.equal(res.status, 1, name);
    assert.match(res.stderr, re, name);
  }
});

// ---- goto --------------------------------------------------------------------------------

test('goto: forward over a checked artifact stops at the next gate and never skips one', (t) => {
  const { repo, id } = withRun(t);
  fails(repo.run(['goto', 'feasibility']), /cannot jump over planning: missing/);
  repo.seedPlanning(id);
  fails(repo.run(['goto', 'feasibility']), /gate_spec is not approved/);
  assert.equal(repo.run(['goto', 'gate_spec']).status, 0);
  assert.equal(repo.state().current.stage, 'gate_spec');
  assert.equal(repo.state().stages.planning.result, 'goto');
  assert.equal(repo.run(['approve', 'gate_spec']).status, 0);
  fails(repo.run(['goto', 'tests']), /cannot jump over feasibility: missing/);
  repo.file(`specs/spec-${id}/approach.md`, VALID_APPROACH);
  fails(repo.run(['goto', 'tests']), /gate_approach is not approved/);
  assert.ok(repo.events().some((e) => e.type === 'goto' && e.direction === 'forward'));
});

test('goto: cannot jump over a stage that is not a file check', (t) => {
  const { repo } = withRun(t);
  repo.update((s) => {
    s.current.stage = 'tests';
    for (const g of ['gate_spec', 'gate_approach']) s.gates[g] = { status: 'approved' };
  });
  fails(repo.run(['goto', 'implement']), /tests has not been done and cannot be jumped over/);
  fails(repo.run(['goto', 'implement']), /tests has not been done/);
});

test('goto: backwards always works and resets what follows', (t) => {
  const { repo } = withRun(t);
  repo.update((s) => {
    s.current.stage = 'implement';
    for (const g of ['gate_spec', 'gate_approach', 'gate_tests']) s.gates[g] = { status: 'approved' };
    for (const st of ['planning', 'feasibility', 'tests']) s.stages[st] = { status: 'done' };
    s.freeze.test_files_hash = 'abc';
    s.loops.implement = { round: 3, last_failing: ['REQ-1'] };
    s.escalations = [{ level: 'CRITICAL', stage: 'implement', reason: 'x', at: 'now' }];
  });
  assert.equal(repo.run(['goto', 'feasibility']).status, 0);
  const s = repo.state();
  assert.equal(s.current.stage, 'feasibility');
  assert.deepEqual(Object.keys(s.stages), ['planning']);
  assert.equal(s.gates.gate_spec.status, 'approved');
  assert.equal(s.gates.gate_approach.status, 'pending');
  assert.equal(s.gates.gate_tests.status, 'pending');
  assert.equal(s.freeze.test_files_hash, null);
  assert.deepEqual(s.loops.implement, { round: 0, last_failing: [] });
  assert.deepEqual(s.escalations, []);
  assert.ok(repo.events().some((e) => e.type === 'goto' && e.direction === 'back' && e.to === 'feasibility'));
});

test('goto: unknown stage, same stage and no run are refused', (t) => {
  const repo = fresh(t);
  fails(repo.run(['goto', 'tests']), /no active run/);
  repo.startRun('feat');
  fails(repo.run(['goto', 'nope']), /unknown stage nope/);
  fails(repo.run(['goto', 'planning']), /already at planning/);
});

// ---- escalation --------------------------------------------------------------------------

const stuck = (repo) => repo.update((s) => {
  s.current.stage = 'implement';
  s.loops.implement = { round: 5, last_failing: ['REQ-1'] };
  s.escalations = [{ level: 'CRITICAL', stage: 'implement', reason: 'implement loop cap hit', at: '2026-01-01' }];
  s.gates.gate_tests = { status: 'approved' };
  s.stages.tests = { status: 'done' };
});

test('escalation list shows pending stops', (t) => {
  const { repo } = withRun(t);
  assert.match(repo.run(['escalation', 'list']).stdout, /no escalations/);
  stuck(repo);
  assert.match(repo.run(['escalation', 'list']).stdout, /#1 CRITICAL implement: implement loop cap hit/);
  assert.equal(repo.run(['status', '--check']).status, 1);
});

test('escalation retry clears the stop, resets the loop and logs the note', (t) => {
  const { repo } = withRun(t);
  stuck(repo);
  assert.equal(repo.run(['escalation', 'retry', '--reason', 'tests were flaky']).status, 0);
  const s = repo.state();
  assert.deepEqual(s.loops.implement, { round: 0, last_failing: [] });
  assert.deepEqual(s.escalations, []);
  assert.match(s.current.next_action, /Retry after escalation \("tests were flaky"\)/);
  assert.equal(repo.run(['status', '--check']).status, 0);
  assert.ok(repo.events().some((e) => e.type === 'escalation_retry' && e.note === 'tests were flaky'));
});

test('escalation reject sends the run back to the previous gate and records why', (t) => {
  const { repo } = withRun(t);
  stuck(repo);
  fails(repo.run(['escalation', 'reject']), /requires --reason/);
  assert.equal(repo.run(['escalation', 'reject', '--reason', 'tests assert the wrong thing']).status, 0);
  const s = repo.state();
  assert.equal(s.current.stage, 'tests');
  assert.equal(s.gates.gate_tests.status, 'rejected');
  assert.deepEqual(s.escalations, []);
  assert.equal(s.stages.tests, undefined);
  assert.match(s.rejections.at(-1).reason, /^escalation: tests assert the wrong thing/);
  assert.ok(repo.events().some((e) => e.type === 'escalation_reject' && e.gate === 'gate_tests'));
});

test('escalation abort ends the run; retry and reject need a pending escalation', (t) => {
  const { repo } = withRun(t);
  fails(repo.run(['escalation', 'retry']), /no escalation pending/);
  fails(repo.run(['escalation', 'reject', '--reason', 'x']), /no escalation pending/);
  stuck(repo);
  assert.equal(repo.run(['escalation', 'abort']).status, 0);
  assert.equal(repo.hasState(), false);
  assert.ok(repo.events().some((e) => e.type === 'escalation_abort'));
  fails(repo.run(['escalation', 'bogus']), /no active run/);
});

// ---- brief -------------------------------------------------------------------------------

test('brief: facts for a gate, change tracking and rejection history', (t) => {
  const { repo, id } = withRun(t);
  repo.file(`specs/spec-${id}/SRS.md`, `${VALID_SRS}\n[OPEN QUESTION] who?\n`);
  repo.setStage('gate_spec');
  const first = repo.run(['brief']).stdout;
  assert.match(first, /gate: gate_spec/);
  assert.match(first, /changed since last brief: first brief/);
  assert.match(first, /- requirements: 1/);
  assert.match(first, /- open_questions: 1/);
  assert.match(first, /- has_non_goals: true/);
  assert.match(first, /rejections: 0/);
  assert.match(repo.run(['brief']).stdout, /changed since last brief: no/);
  repo.file(`specs/spec-${id}/SRS.md`, VALID_SRS);
  assert.match(repo.run(['brief', 'gate_spec']).stdout, /changed since last brief: yes/);
  assert.equal(repo.run(['reject', 'gate_spec', '--reason', 'goals unclear']).status, 0);
  repo.setStage('gate_spec');
  const again = repo.run(['brief']).stdout;
  assert.match(again, /rejections: 1/);
  assert.match(again, /goals unclear/);
});

test('brief: approach, plan, review and final gates; refuses a non-gate', (t) => {
  const { repo, id } = withRun(t);
  repo.file(`specs/spec-${id}/approach.md`, `${VALID_APPROACH}\n[ASSUMPTION] db is postgres\n`);
  repo.setStage('gate_approach');
  const a = repo.run(['brief']).stdout;
  assert.match(a, /- assumptions: 1/);
  assert.match(a, /- verdict: with-changes/);
  repo.seedPlanning(id);
  assert.match(repo.run(['brief', 'gate_spec']).stdout, /SRS\.md/);
  repo.file(`.agent-workflow/runs/${id}/review.md`, `${AXES}- [decision-needed] pick a queue\n- [high][resolved] x\n`);
  const r = repo.run(['brief', 'gate_review']).stdout;
  assert.match(r, /- decision_needed: 1/);
  assert.match(r, /- high: 1/);
  repo.file(`.agent-workflow/runs/${id}/evidence/e2e-summary.md`, '| PRD-1.1 | t | flaky |\n');
  repo.update((s) => { s.stages.verify = { status: 'done', tiers: [{ tier: 'unit', skipped: false, code: 0 }, { tier: 'e2e', skipped: true, code: 0 }] }; });
  const f = repo.run(['brief', 'gate_final']).stdout;
  assert.match(f, /- checks: unit:ok e2e:skipped/);
  assert.match(f, /- flaky: 1/);
  fails(repo.run(['brief', 'implement']), /implement is not a gate/);
});

// ---- new artifact checks -----------------------------------------------------------------

test('planning: needs a Non-goals section', (t) => {
  const { repo, id } = withRun(t);
  repo.seedPlanning(id);
  repo.file(`specs/spec-${id}/SRS.md`, VALID_SRS.replace(/## 6 Non-goals[\s\S]*## 7 Traceability/, '## 7 Traceability'));
  fails(repo.run(['done', 'planning']), /SRS\.md needs a Non-goals section|missing section heading matching.*Non-goals/);
});

test('planning: research.md needs its three groups and a URL on every Sourced claim', (t) => {
  const { repo, id } = withRun(t);
  repo.seedPlanning(id);
  const r = `specs/spec-${id}/research.md`;
  repo.file(r, '## Sourced\n- a claim\n');
  fails(repo.run(['done', 'planning']), /research\.md needs a Inferred section/);
  repo.file(r, '## Sourced\n- a claim\n## Inferred\n- x\n## Unknown\n- y\n');
  fails(repo.run(['done', 'planning']), /Sourced claim has no URL: - a claim/);
  repo.file(r, '## Sourced\n- a claim https://example.com (2026-10-28)\n## Inferred\n- x\n## Unknown\n- y\n');
  assert.equal(repo.run(['done', 'planning']).status, 0);
});

test('feasibility: needs decision, non-functional, risks and rollback', (t) => {
  const { repo, id } = withRun(t);
  repo.setStage('feasibility');
  const p = `specs/spec-${id}/approach.md`;
  const base = '# Approach\nVerdict: as-is\n## A\n## B\none commit\n';
  for (const part of ['Decision', 'Non-functional', 'Risks', 'Rollback']) {
    repo.file(p, base + ADR.replace(new RegExp(`## ${part}\\n[^#]*`), ''));
    fails(repo.run(['done', 'feasibility']), new RegExp(`approach\\.md needs a ${part} section`));
  }
  repo.file(p, base + ADR);
  assert.equal(repo.run(['done', 'feasibility']).status, 0);
});

test('review: needs a section per axis and a severity tag on every finding', (t) => {
  const { repo } = withRun(t);
  repo.setStage('review');
  repo.file('review.md', '## Standards\nopen: 0\n');
  fails(repo.run(['done', 'review', '--result', 'review.md']), /review\.md needs a section for Spec conformance/);
  repo.file('review.md', `${AXES}- src/a.py:3 - rename this\n`);
  fails(repo.run(['done', 'review', '--result', 'review.md']), /review finding has no severity tag: - src\/a\.py:3/);
  repo.file('review.md', `${AXES}- [low] src/a.py:3 - rename this\n`);
  assert.equal(repo.run(['done', 'review', '--result', 'review.md']).status, 0);
});

// ---- PR decision record ------------------------------------------------------------------

test('pr body copies the decision record, two lines at most', (t) => {
  const { repo, id } = withRun(t, 'Add items');
  repo.file(`.agent-workflow/runs/${id}/pr-summary.md`, 'Adds items.');
  repo.seedSpecs(id);
  repo.file(`specs/spec-${id}/approach.md`, `${VALID_APPROACH.split('## Decision')[0]}## Decision\nApproach B: reuse the queue.\nIt avoids a new service.\nThird line is dropped.\n## Risks\nx\n`);
  repo.commit('feat');
  repo.update((s) => { s.current.stage = 'pr'; s.gates.gate_final = { status: 'approved' }; });
  const out = repo.run(['pr', '--dry-run']).stdout;
  assert.match(out, /## Decision\n\nApproach B: reuse the queue\.\nIt avoids a new service\.\n\n## What changed/);
  assert.doesNotMatch(out, /Third line/);
});

// ---- adr ---------------------------------------------------------------------------------

test('adr: writes a numbered file once, and pr insists it is committed', (t) => {
  const { repo, id } = withRun(t, 'Add items');
  fails(repo.run(['adr']), /no Decision section/);
  repo.seedSpecs(id);
  const first = repo.run(['adr']).stdout.trim();
  assert.match(first, /^docs\/adr\/0001-add-items\.md$/);
  assert.match(repo.read(first), new RegExp(`Run: ${id}\\n[\\s\\S]*Approach A: smallest change that works\\.`));
  assert.equal(repo.run(['adr']).stdout.trim(), first, 'second call reuses the file');
  repo.file('docs/adr/0007-other.md', '# other\n');
  repo.update((s) => { s.run.id = 'second-run'; s.run.source = 'Second'; });
  repo.file('specs/spec-second-run/approach.md', VALID_APPROACH);
  assert.match(repo.run(['adr']).stdout.trim(), /^docs\/adr\/0008-second-run\.md$/);
});

test('pr: refuses until the ADR is committed on the branch', (t) => {
  const { repo, id } = withRun(t, 'Add items');
  const remote = repo.addRemoteAndFakeGh();
  t.after(remote.cleanup);
  repo.seedSpecs(id);
  repo.file(`.agent-workflow/runs/${id}/pr-summary.md`, 'Adds items.');
  repo.commit('feat: items');
  repo.update((s) => { s.current.stage = 'pr'; s.gates.gate_final = { status: 'approved' }; });
  fails(repo.run(['pr']), /run `node \.agent-workflow\/wf\.mjs adr`/);
  repo.run(['adr']);
  fails(repo.run(['pr']), /run `node \.agent-workflow\/wf\.mjs adr`/);
  repo.commit('docs: adr');
  assert.equal(repo.run(['pr']).status, 0);
});

test('brief: gate_tests lists the frozen product tests', (t) => {
  const { repo } = withRun(t);
  repo.config({ product_test_globs: ['E2E/tests/**'] });
  repo.file('E2E/tests/a.spec.ts', 'x');
  repo.update((s) => { s.current.stage = 'gate_tests'; s.freeze.test_files_hash = 'f'.repeat(64); });
  const out = repo.run(['brief']).stdout;
  assert.match(out, /- E2E\/tests\/a\.spec\.ts \(1 bytes/);
  assert.match(out, /- freeze_hash: f{64}/);
});

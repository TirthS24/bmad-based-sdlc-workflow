// Characterization: run lifecycle, status, pause/resume/abort, prune, events, CLI usage.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fresh, withRun } from './helpers.mjs';

test('run creates state, spec dir, run dir and a run event', (t) => {
  const repo = fresh(t);
  const res = repo.run(['run', 'My Feature!']);
  assert.equal(res.status, 0);
  const s = repo.state();
  assert.match(s.run.id, /^\d{8}-my-feature$/);
  assert.equal(s.current.stage, 'grill_spec');
  assert.equal(s.current.attempt, 1);
  assert.equal(s.gates.gate1.status, 'pending');
  assert.equal(s.gates.gate2.status, 'pending');
  assert.deepEqual(s.loops, {
    implement: { round: 0, last_failing: [] },
    review: { round: 0 },
    verify_fix: { round: 0 },
  });
  assert.match(s.run.baseline_sha, /^[0-9a-f]{40}$/);
  assert.ok(repo.exists(`specs/spec-${s.run.id}`));
  assert.ok(repo.exists(`.agent-workflow/runs/${s.run.id}`));
  assert.match(res.stdout, /stage: grill_spec/);
  assert.match(res.stdout, /next_action: Run \/wf-start/);
  assert.ok(res.stdout.includes(`specs/spec-${s.run.id}/SPEC.md`), '<id> placeholder is filled');
  assert.deepEqual(repo.events().map((e) => e.type), ['run']);
});

test('run without a description uses the adhoc slug', (t) => {
  const repo = fresh(t);
  assert.equal(repo.run(['run']).status, 0);
  assert.match(repo.state().run.id, /^\d{8}-adhoc$/);
});

test('a second run is refused while one is active', (t) => {
  const { repo } = withRun(t);
  const res = repo.run(['run', 'other']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /a run is already active/);
});

test('status without a run explains how to start one', (t) => {
  const repo = fresh(t);
  const res = repo.run(['status']);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /No active workflow run\. For a new feature or bug fix, start one: \/wf-run/);
});

test('status --hook wraps the text as additional_context', (t) => {
  const repo = fresh(t);
  const none = JSON.parse(repo.run(['status', '--hook']).stdout);
  assert.match(none.additional_context, /No active workflow run/);
  repo.startRun('feat');
  const active = JSON.parse(repo.run(['status', '--hook']).stdout);
  assert.match(active.additional_context, /stage: grill_spec/);
});

test('status prints run, branch, stage, gates, loop, writes and next_action', (t) => {
  const { repo, id } = withRun(t);
  const out = repo.run(['status']).stdout;
  assert.ok(out.includes(`run: ${id}`));
  assert.match(out, /^branch: \S+$/m);
  assert.match(out, /^stage: grill_spec$/m);
  assert.match(out, /^attempt: 1$/m);
  assert.match(out, /^gate1: pending$/m);
  assert.match(out, /^gate2: pending$/m);
  assert.match(out, /^loop: 0$/m);
  assert.match(out, /^writes: allowed: specs\/\*\* \/ blocked: protected$/m);
  assert.match(out, /^next_action: /m);
});

test('status writes hint marks frozen tests in implement and review', (t) => {
  const { repo } = withRun(t);
  repo.setStage('implement');
  const impl = repo.run(['status']).stdout;
  assert.match(impl, /writes: allowed: src\/\*\* \/ blocked: .*tests\/\*\*\/\*\.py.* frozen-tests/);
  repo.setStage('review');
  assert.match(repo.run(['status']).stdout, / frozen-tests$/m);
  repo.setStage('verify');
  assert.match(repo.run(['status']).stdout, /writes: allowed: \(none\) \/ blocked: protected$/m);
});

test('status --check exits 0 with no run or a healthy run', (t) => {
  const repo = fresh(t);
  assert.equal(repo.run(['status', '--check']).status, 0);
  repo.startRun('feat');
  assert.equal(repo.run(['status', '--check']).status, 0);
});

test('status --check fails on the implement cap and on pending escalations', (t) => {
  const { repo } = withRun(t);
  repo.update((s) => { s.current.stage = 'implement'; s.loops.implement.round = 5; });
  const cap = repo.run(['status', '--check']);
  assert.equal(cap.status, 1);
  assert.match(cap.stderr, /implement loop cap hit/);
  repo.update((s) => { s.loops.implement.round = 0; s.escalations.push({ level: 'CRITICAL' }); });
  const esc = repo.run(['status', '--check']);
  assert.equal(esc.status, 1);
  assert.match(esc.stderr, /escalation pending/);
});

test('pause archives state, resume restores it', (t) => {
  const { repo, id } = withRun(t);
  const paused = repo.run(['pause']);
  assert.equal(paused.status, 0);
  assert.match(paused.stdout, new RegExp(`Paused ${id}\\. Resume with: node \\.agent-workflow/wf\\.mjs resume ${id}`));
  assert.equal(repo.hasState(), false);
  assert.ok(repo.exists(`.agent-workflow/runs/${id}/paused.state.json`));
  const resumed = repo.run(['resume']);
  assert.equal(resumed.status, 0);
  assert.equal(repo.state().run.id, id);
  assert.match(resumed.stdout, /stage: grill_spec/);
  assert.deepEqual(repo.events().map((e) => e.type), ['run', 'pause', 'resume']);
});

test('resume refuses an active run, an unknown id, and ambiguity', (t) => {
  const { repo, id } = withRun(t);
  assert.match(repo.run(['resume']).stderr, /a run is already active/);
  repo.run(['pause']);
  assert.match(repo.run(['resume', 'nope']).stderr, /no paused state at /);
  assert.equal(repo.run(['resume', id]).status, 0);
  repo.run(['pause']);
  fs.mkdirSync(path.join(repo.wfDir, 'runs', 'other'), { recursive: true });
  fs.copyFileSync(path.join(repo.wfDir, 'runs', id, 'paused.state.json'), path.join(repo.wfDir, 'runs', 'other', 'paused.state.json'));
  assert.match(repo.run(['resume']).stderr, /pass a run id: wf resume <run-id>/);
});

test('pause and abort need an active run', (t) => {
  const repo = fresh(t);
  assert.match(repo.run(['pause']).stderr, /no active run/);
  assert.match(repo.run(['abort']).stderr, /no active run/);
});

test('abort archives state and events then clears the run', (t) => {
  const { repo, id } = withRun(t);
  const res = repo.run(['abort']);
  assert.equal(res.status, 0);
  assert.match(res.stdout, new RegExp(`Aborted ${id}\\. Choose keep, stash, or discard`));
  assert.equal(repo.hasState(), false);
  const archived = fs.readdirSync(path.join(repo.wfDir, 'runs', id));
  assert.ok(archived.some((f) => /^abort-.*\.state\.json$/.test(f)));
  assert.ok(archived.some((f) => /^abort-.*\.events\.jsonl$/.test(f)));
  assert.deepEqual(repo.events().map((e) => e.type), ['run', 'abort']);
});

test('abort --force says the working tree was left as-is', (t) => {
  const { repo, id } = withRun(t);
  const res = repo.run(['abort', '--force']);
  assert.match(res.stdout, new RegExp(`Aborted ${id}\\. Working tree left as-is \\(--force\\)\\.`));
  assert.equal(repo.events().at(-1).force, true);
});

test('prune keeps allowlisted bmad skills and removes the rest', (t) => {
  const repo = fresh(t);
  fs.writeFileSync(path.join(repo.wfDir, 'bmad-allowlist.json'), JSON.stringify({ keep: ['bmad-keep'] }));
  repo.file('.agents/skills/bmad-keep/SKILL.md', 'k');
  repo.file('.agents/skills/bmad-drop/SKILL.md', 'd');
  repo.file('.cursor/skills/not-bmad/SKILL.md', 'n');
  const dry = repo.run(['prune', '--dry-run']);
  assert.match(dry.stdout, /^kept: \.agents\/skills\/bmad-keep$/m);
  assert.match(dry.stdout, /^would remove: \.agents\/skills\/bmad-drop$/m);
  assert.ok(repo.exists('.agents/skills/bmad-drop'));
  const real = repo.run(['prune']);
  assert.match(real.stdout, /^removed: \.agents\/skills\/bmad-drop$/m);
  assert.equal(repo.exists('.agents/skills/bmad-drop'), false);
  assert.ok(repo.exists('.agents/skills/bmad-keep'));
  assert.ok(repo.exists('.cursor/skills/not-bmad'));
});

test('verify reports each tier and exits with the failing tier code', (t) => {
  const repo = fresh(t);
  repo.config({ commands: { unit: 'exit 0', lint: '', complexity: '', e2e: '', a11y: '' } });
  const ok = repo.run(['verify']);
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, 'unit: ok\nlint: skip\ncomplexity: skip\ne2e: skip\na11y: skip\n');
  repo.config({ commands: { unit: 'echo boom; exit 3' } });
  const bad = repo.run(['verify']);
  assert.equal(bad.status, 3);
  assert.match(bad.stdout, /unit: fail\(3\)\nboom/);
});

test('CLI usage and unknown commands', (t) => {
  const repo = fresh(t);
  const none = repo.run([]);
  assert.equal(none.status, 1);
  assert.match(none.stdout, /^usage: wf\.mjs <run\|status\|done\|approve\|verify\|guard\|log\|prune\|abort\|pause\|resume> \[args\]$/m);
  assert.equal(repo.run(['help']).status, 0);
  assert.equal(repo.run(['--help']).status, 0);
  const bad = repo.run(['frobnicate']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /unknown command frobnicate/);
});

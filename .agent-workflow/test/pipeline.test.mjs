// End-to-end walk of the whole pipeline through the CLI, with stub agents (files written by the test).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { AXES, VALID_APPROACH, VALID_SRS, fresh, runFile, assertOk } from './helpers.mjs';

test('spec to PR: six human gates, none between implement and review', (t) => {
  const repo = fresh(t);
  const remote = repo.addRemoteAndFakeGh();
  t.after(remote.cleanup);
  const ok = (args) => {
    const res = repo.run(args);
    assert.equal(res.status, 0, `${args.join(' ')}: ${res.stderr}`);
    return res;
  };
  const stage = () => repo.state().current.stage;
  const trail = [];
  const at = (s) => { assert.equal(stage(), s); trail.push(s); };

  ok(['run', 'Items endpoint']);
  const id = repo.state().run.id;
  const dir = `specs/spec-${id}`;

  at('planning');
  repo.seedPlanning(id);
  ok(['done', 'planning', '--result', `${dir}/SRS.md`]);
  at('gate_spec');
  assert.equal(repo.run(['done', 'gate_spec']).status, 1, 'agents cannot pass a gate with done');
  ok(['approve', 'gate_spec']);

  at('feasibility');
  repo.file(`${dir}/approach.md`, VALID_APPROACH);
  ok(['done', 'feasibility']);
  at('gate_approach');
  ok(['approve', 'gate_approach', '--approach', 'A']);

  at('tests');
  repo.config({ commands: { unit: 'echo "FAILED REQ-1"; exit 1', lint: '' } });
  repo.file('tests/test_items.py', 'def test_x(): assert False');
  ok(['done', 'tests']);
  at('gate_tests');
  ok(['approve', 'gate_tests']);

  at('implement');
  repo.config({ commands: { unit: 'exit 0', lint: '' } });
  repo.file('src/items.py', 'ok = True');
  ok(['done', 'implement']);
  at('review');
  repo.file(runFile(repo, 'review.md'), `${AXES}- [low] naming\n`);
  ok(['done', 'review', '--result', runFile(repo, 'review.md')]);
  at('gate_review');
  ok(['approve', 'gate_review']);

  at('verify');
  fs.mkdirSync(path.join(repo.wfDir, 'runs', id, 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(repo.wfDir, 'runs', id, 'evidence', 'shot.txt'), 'x');
  ok(['done', 'verify']);
  at('gate_final');
  assert.equal(repo.guard('beforeShellExecution', { command: 'git commit -m x' }).status, 2, 'commit blocked before the final gate');
  ok(['approve', 'gate_final']);

  at('pr');
  assert.equal(repo.guard('beforeShellExecution', { command: 'git commit -m x' }).status, 0, 'commit allowed after the final gate');
  ok(['adr']);
  repo.git('add', '-A');
  repo.git('commit', '-q', '-m', 'feat: items endpoint');
  assert.equal(repo.run(['pr']).status, 1, 'no change summary yet');
  fs.writeFileSync(path.join(repo.wfDir, 'runs', id, 'pr-summary.md'), 'Adds the items endpoint.\n');
  const out = ok(['pr']).stdout.trim();
  assert.equal(out, 'https://github.com/acme/app/pull/7');
  at('done');

  assert.deepEqual(trail, [
    'planning', 'gate_spec', 'feasibility', 'gate_approach', 'tests', 'gate_tests',
    'implement', 'review', 'gate_review', 'verify', 'gate_final', 'pr', 'done',
  ]);
  const gates = repo.events().filter((e) => e.type === 'approve').map((e) => e.gate);
  assert.deepEqual(gates, ['gate_spec', 'gate_approach', 'gate_tests', 'gate_review', 'gate_final']);
});

test('implement may write whatever src_globs says', (t) => {
  const repo = fresh(t);
  repo.config({ src_globs: ['app/**', 'lib/**'] });
  repo.startRun('feat');
  repo.setStage('implement');
  const w = (file) => repo.guard('preToolUse', { tool_name: 'Write', tool_input: { file_path: file } }).status;
  assert.equal(w('app/main.py'), 0);
  assert.equal(w('lib/x.py'), 0);
  assert.equal(w('src/main.py'), 2, 'default src/ no longer applies once configured');
});

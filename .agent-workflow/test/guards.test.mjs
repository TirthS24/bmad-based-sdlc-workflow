// Characterization: hook guards (preToolUse, beforeShellExecution, stop, afterFileEdit).
import assert from 'node:assert/strict';
import test from 'node:test';
import { fresh, withRun } from './helpers.mjs';

const edit = (file) => ({ tool_name: 'Write', tool_input: { file_path: file } });

const expectAllow = (res) => {
  assert.equal(res.status, 0, res.stdout);
  assert.deepEqual(res.body, { permission: 'allow' });
};

const expectDeny = (res, re) => {
  assert.equal(res.status, 2, res.stdout);
  assert.equal(res.body.permission, 'deny');
  assert.match(res.body.user_message, re);
  assert.equal(res.body.agent_message, res.body.user_message);
};

test('preToolUse: protected workflow files are denied even with no run', (t) => {
  const repo = fresh(t);
  expectDeny(repo.guard('preToolUse', edit('.agent-workflow/state.json')), /protected file: \.agent-workflow\/state\.json \(only wf\.mjs may write workflow state\)/);
  expectDeny(repo.guard('preToolUse', edit('.agent-workflow/workflow.json')), /protected file/);
  expectDeny(repo.guard('preToolUse', edit(`${repo.root}/.agent-workflow/state.json`)), /protected file/);
});

test('preToolUse: with no run any other write is allowed', (t) => {
  const repo = fresh(t);
  expectAllow(repo.guard('preToolUse', edit('src/app.py')));
});

test('preToolUse: planning may write only under specs/', (t) => {
  const { repo, id } = withRun(t);
  expectAllow(repo.guard('preToolUse', edit(`specs/spec-${id}/SPEC.md`)));
  expectDeny(repo.guard('preToolUse', edit('src/app.py')), /stage planning cannot write src\/app\.py\. Allowed: specs\/\*\*/);
});

test('preToolUse: implement writes src/ but never frozen tests', (t) => {
  const { repo } = withRun(t);
  repo.setStage('implement');
  expectAllow(repo.guard('preToolUse', edit('src/app.py')));
  for (const f of ['tests/test_a.py', 'web/x.test.ts', 'lib/y.test.js', 'E2E/tests/flow.spec.ts']) {
    expectDeny(repo.guard('preToolUse', edit(f)), new RegExp(`frozen tests: ${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is in product_test_globs for stage implement`));
  }
  expectDeny(repo.guard('preToolUse', edit('docs/readme.md')), /stage implement cannot write docs\/readme\.md/);
});

test('preToolUse: review freezes tests too, verify and gates write nothing', (t) => {
  const { repo } = withRun(t);
  repo.setStage('review');
  expectDeny(repo.guard('preToolUse', edit('tests/test_a.py')), /frozen tests: tests\/test_a\.py is in product_test_globs for stage review/);
  expectAllow(repo.guard('preToolUse', edit('src/app.py')));
  for (const stage of ['verify', 'gate_spec', 'gate_final', 'pr']) {
    repo.setStage(stage);
    expectDeny(repo.guard('preToolUse', edit('src/app.py')), new RegExp(`stage ${stage} cannot write src/app\\.py\\. Allowed: (\\(none\\)|\\.agent-workflow\\/runs\\/)`));
  }
});

test('preToolUse: tests stage may write only the test globs', (t) => {
  const { repo } = withRun(t);
  repo.setStage('tests');
  expectAllow(repo.guard('preToolUse', edit('tests/test_a.py')));
  expectDeny(repo.guard('preToolUse', edit('src/app.py')), /stage tests cannot write src\/app\.py/);
});

test('preToolUse: calls without a file path are allowed, and path keys are flexible', (t) => {
  const { repo } = withRun(t);
  repo.setStage('verify');
  expectAllow(repo.guard('preToolUse', { tool_name: 'Read' }));
  expectAllow(repo.guard('preToolUse', { tool_name: 'Grep', tool_input: {} }));
  expectAllow(repo.guard('preToolUse', {}));
  expectDeny(repo.guard('preToolUse', { toolName: 'Edit', toolInput: { filePath: 'src/a.py' } }), /cannot write/);
  expectDeny(repo.guard('preToolUse', { tool: 'Edit', input: { path: 'src/a.py' } }), /cannot write/);
  expectDeny(repo.guard('preToolUse', { file_path: 'src/a.py' }), /cannot write/);
  expectDeny(repo.guard('preToolUse', { filePath: 'src/a.py' }), /cannot write/);
  expectDeny(repo.guard('preToolUse', { path: 'src/a.py' }), /cannot write/);
  expectDeny(repo.guard('preToolUse', { tool_name: 'MultiEdit', tool_input: { file_path: ['src/a.py'] } }), /cannot write/);
});

test('preToolUse: the event name can come from the payload', (t) => {
  const { repo } = withRun(t);
  repo.setStage('verify');
  const res = repo.run(['guard'], { input: JSON.stringify({ hook_event_name: 'preToolUse', ...edit('src/a.py') }) });
  assert.equal(res.status, 2);
});

test('guard: unknown events and empty payloads answer {}', (t) => {
  const repo = fresh(t);
  const res = repo.run(['guard', 'somethingElse'], { input: '' });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '{}\n');
  assert.equal(repo.run(['guard', 'preToolUse'], { input: 'not json' }).status, 0);
});

test('beforeShellExecution: commit, push and PR creation wait for the final gate', (t) => {
  const { repo } = withRun(t);
  for (const command of ['git commit -m x', '  git   commit -am y', 'git push origin HEAD', 'git push -u origin wf/x', 'gh pr create --fill']) {
    expectDeny(repo.guard('beforeShellExecution', { command }), /blocked until the final gate is approved: /);
  }
  // Agents chain commands; the guard looks for the subcommand at the start of any segment.
  for (const command of [
    'cd src && git commit -m x', 'true; git push origin HEAD', 'make || git commit -am y', 'echo ok | git commit -F -',
    '(git commit -m x)', 'x=$(git commit -m x)', 'git -C . commit -m x', 'git -c user.name=a commit -m x',
    'git --no-pager push', 'npm test && gh pr create --fill',
  ]) {
    expectDeny(repo.guard('beforeShellExecution', { command }), /blocked until the final gate is approved: /);
  }
  for (const command of ['git status', 'git pull', 'ls', 'echo git commit', 'git log --grep commit', 'git commit-graph write', 'grep -r "git push" docs', '']) {
    expectAllow(repo.guard('beforeShellExecution', { command }));
  }
  expectDeny(repo.guard('beforeShellExecution', { tool_input: { command: 'git commit -m x' } }), /blocked until the final gate/);
  expectDeny(repo.guard('beforeShellExecution', { command_line: 'git commit -m x' }), /blocked until the final gate/);
});

test('beforeShellExecution: allowed after the final gate, and when no run is active', (t) => {
  const { repo } = withRun(t);
  repo.update((s) => { s.gates.gate_final.status = 'approved'; });
  expectAllow(repo.guard('beforeShellExecution', { command: 'git commit -m x' }));
  repo.run(['abort']);
  expectAllow(repo.guard('beforeShellExecution', { command: 'git commit -m x' }));
});

test('stop: does nothing without a run or outside implement', (t) => {
  const repo = fresh(t);
  assert.equal(repo.run(['guard', 'stop'], { input: '{}' }).stdout, '{}\n');
  repo.startRun('feat');
  assert.equal(repo.run(['guard', 'stop'], { input: '{}' }).stdout, '{}\n');
  assert.equal(repo.state().loops.implement.round, 0);
});

test('stop: implement with passing tests does nothing', (t) => {
  const { repo } = withRun(t);
  repo.setStage('implement');
  repo.config({ commands: { unit: 'exit 0' } });
  assert.equal(repo.run(['guard', 'stop'], { input: '{}' }).stdout, '{}\n');
  assert.equal(repo.state().loops.implement.round, 0);
  repo.config({ commands: { unit: '' } });
  assert.equal(repo.run(['guard', 'stop'], { input: '{}' }).stdout, '{}\n');
});

test('stop: failing tests send a follow-up with the round and failing ids', (t) => {
  const { repo } = withRun(t);
  repo.setStage('implement');
  repo.config({ commands: { unit: 'echo "FAILED REQ-2 and TECH-api"; exit 1' } });
  const res = repo.run(['guard', 'stop'], { input: '{"loop_count":0}' });
  assert.equal(res.status, 0);
  const body = JSON.parse(res.stdout);
  assert.equal(
    body.followup_message,
    'Implement loop round 1/5. Unit tests still failing. Re-run the implementer subagent for one more attempt. Do not edit frozen tests. Failing ids: REQ-2, TECH-api',
  );
  const s = repo.state();
  assert.equal(s.loops.implement.round, 1);
  assert.deepEqual(s.loops.implement.last_failing, ['REQ-2', 'TECH-api']);
  assert.deepEqual(s.escalations, []);
});

test('stop: failures without ids still loop and point at wf verify', (t) => {
  const { repo } = withRun(t);
  repo.setStage('implement');
  repo.config({ commands: { unit: 'echo boom; exit 1' } });
  const body = JSON.parse(repo.run(['guard', 'stop'], { input: '{}' }).stdout);
  assert.match(body.followup_message, /See wf verify output\.$/);
});

test('stop: the same failing set two rounds running escalates', (t) => {
  const { repo } = withRun(t);
  repo.setStage('implement');
  repo.config({ commands: { unit: 'echo "FAILED REQ-1"; exit 1' } });
  assert.ok(JSON.parse(repo.run(['guard', 'stop'], { input: '{}' }).stdout).followup_message);
  const second = repo.run(['guard', 'stop'], { input: '{}' });
  assert.equal(second.stdout, '{}\n');
  const s = repo.state();
  assert.equal(s.loops.implement.round, 2);
  assert.equal(s.escalations.length, 1);
  assert.equal(s.escalations[0].level, 'CRITICAL');
  assert.equal(s.escalations[0].stage, 'implement');
  assert.equal(s.escalations[0].reason, 'identical failing-test set two rounds running');
  assert.equal(repo.events().at(-1).type, 'escalation');
});

test('stop: reaching the round cap escalates', (t) => {
  const { repo } = withRun(t);
  repo.setStage('implement');
  repo.config({ commands: { unit: 'echo "FAILED REQ-9"; exit 1' } });
  repo.update((s) => { s.loops.implement.round = 4; s.loops.implement.last_failing = ['REQ-1']; });
  assert.equal(repo.run(['guard', 'stop'], { input: '{}' }).stdout, '{}\n');
  const s = repo.state();
  assert.equal(s.loops.implement.round, 5);
  assert.equal(s.escalations[0].reason, 'implement loop cap hit');
});

test('stop: a configured cap and the hook loop_count both apply', (t) => {
  const { repo } = withRun(t);
  repo.setStage('implement');
  repo.config({ commands: { unit: 'echo "FAILED REQ-3"; exit 1' }, loop_caps: { implement: 2 } });
  repo.update((s) => { s.loops.implement.round = 1; s.loops.implement.last_failing = ['REQ-1']; });
  assert.equal(repo.run(['guard', 'stop'], { input: '{}' }).stdout, '{}\n');
  assert.equal(repo.state().escalations.length, 1);

  const other = withRun(t, 'second');
  other.repo.setStage('implement');
  other.repo.config({ commands: { unit: 'echo "FAILED REQ-3"; exit 1' } });
  assert.equal(other.repo.run(['guard', 'stop'], { input: '{"loop_count":5}' }).stdout, '{}\n');
  assert.equal(other.repo.state().escalations.length, 1);
});

test('afterFileEdit and log append a tool/path event and answer {}', (t) => {
  const repo = fresh(t);
  const viaGuard = repo.run(['guard', 'afterFileEdit'], { input: JSON.stringify({ tool_name: 'Write', file_path: 'src/a.js' }) });
  assert.equal(viaGuard.stdout, '{}\n');
  const viaLog = repo.run(['log', 'afterFileEdit'], { input: JSON.stringify({ tool_input: { path: 'src/b.js' } }) });
  assert.equal(viaLog.stdout, '{}\n');
  const events = repo.events();
  assert.equal(events[0].type, 'afterFileEdit');
  assert.equal(events[0].tool, 'Write');
  assert.equal(events[0].path, 'src/a.js');
  assert.equal(events[1].path, 'src/b.js');
  assert.equal('tool' in events[1], false);
});

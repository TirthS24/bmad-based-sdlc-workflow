// Cursor smoke test: run every command in .cursor/hooks.json the way Cursor does and
// pin the exact stdout and exit code. Imports only helpers.mjs so the same file can be
// run against an older wf.mjs to prove the responses did not change.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { withRun } from './helpers.mjs';

const HOOKS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.cursor/hooks.json');
const PREFIX = 'node .agent-workflow/wf.mjs ';

function hookArgs() {
  const { hooks } = JSON.parse(fs.readFileSync(HOOKS, 'utf8'));
  const out = {};
  for (const [event, entries] of Object.entries(hooks)) {
    assert.equal(entries.length, 1, `one command per event: ${event}`);
    const { command } = entries[0];
    assert.ok(command.startsWith(PREFIX), command);
    out[event] = { args: command.slice(PREFIX.length).split(/\s+/), failClosed: !!entries[0].failClosed };
  }
  return out;
}

const fire = (repo, hook, payload) => repo.run(hook.args, { input: typeof payload === 'string' ? payload : JSON.stringify(payload) });
const allowOut = '{"permission":"allow"}\n';
const denyOut = (m) => `${JSON.stringify({ permission: 'deny', user_message: m, agent_message: m })}\n`;

test('every hooks.json command answers exactly as pinned', (t) => {
  const hooks = hookArgs();
  assert.deepEqual(Object.keys(hooks).sort(), ['afterFileEdit', 'beforeShellExecution', 'preToolUse', 'sessionStart', 'stop', 'subagentStart', 'subagentStop']);
  const { repo, id } = withRun(t);

  const status = repo.run(['status']).stdout.replace(/\n$/, '');
  assert.deepEqual(fire(repo, hooks.sessionStart, {}), { status: 0, stdout: `${JSON.stringify({ additional_context: status })}\n`, stderr: '' });

  const pre = (file) => fire(repo, hooks.preToolUse, { tool_name: 'Write', tool_input: { file_path: file } });
  assert.deepEqual(pre(`specs/spec-${id}/SRS.md`), { status: 0, stdout: allowOut, stderr: '' });
  assert.deepEqual(pre('src/app.py'), { status: 2, stdout: denyOut('stage planning cannot write src/app.py. Allowed: specs/**'), stderr: '' });
  assert.deepEqual(pre('.agent-workflow/state.json'), { status: 2, stdout: denyOut('protected file: .agent-workflow/state.json (only wf.mjs may write workflow state)'), stderr: '' });

  const sh = (command) => fire(repo, hooks.beforeShellExecution, { command });
  assert.deepEqual(sh('ls'), { status: 0, stdout: allowOut, stderr: '' });
  assert.deepEqual(sh('git commit -m x'), { status: 2, stdout: denyOut('blocked until the final gate is approved: git commit -m x'), stderr: '' });

  assert.deepEqual(fire(repo, hooks.afterFileEdit, { tool_name: 'Write', file_path: 'specs/x.md' }), { status: 0, stdout: '{}\n', stderr: '' });
  assert.deepEqual(repo.events().at(-1), { ts: repo.events().at(-1).ts, type: 'afterFileEdit', tool: 'Write', path: 'specs/x.md' });

  assert.deepEqual(fire(repo, hooks.stop, {}), { status: 0, stdout: '{}\n', stderr: '' });
  assert.deepEqual(fire(repo, hooks.subagentStart, { subagent_type: 'explore' }), { status: 0, stdout: allowOut, stderr: '' });
  assert.deepEqual(fire(repo, hooks.subagentStop, { subagent_type: 'explore', status: 'completed', duration_ms: 100 }), { status: 0, stdout: '{}\n', stderr: '' });
});

test('the write guard also covers Cursor\'s Delete tool', (t) => {
  const { hooks: raw } = JSON.parse(fs.readFileSync(HOOKS, 'utf8'));
  assert.ok(new RegExp(`^(${raw.preToolUse[0].matcher})$`).test('Delete'), 'matcher includes Delete');
  const { repo } = withRun(t);
  const res = fire(repo, hookArgs().preToolUse, { tool_name: 'Delete', tool_input: { target_file: '.agent-workflow/state.json' } });
  assert.equal(res.status, 2);
  assert.match(res.stdout, /protected file: \.agent-workflow\/state\.json/);
});

test('a stop the human pressed, or an error, never sends a follow-up', (t) => {
  const { repo } = withRun(t);
  repo.update((s) => { s.current.stage = 'implement'; });
  fs.writeFileSync(path.join(repo.wfDir, 'config.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(repo.wfDir, 'config.json'), 'utf8')), commands: { unit: 'exit 1' } }));
  const hooks = hookArgs();
  for (const status of ['aborted', 'error']) {
    assert.deepEqual(fire(repo, hooks.stop, { status, loop_count: 0 }), { status: 0, stdout: '{}\n', stderr: '' }, status);
  }
  assert.match(fire(repo, hooks.stop, { status: 'completed', loop_count: 0 }).stdout, /followup_message/);
});

test('a logging hook that cannot record still allows', (t) => {
  const { repo } = withRun(t);
  const events = path.join(repo.wfDir, 'events.jsonl');
  fs.rmSync(events, { force: true });
  fs.mkdirSync(events); // appending to a directory throws
  assert.deepEqual(fire(repo, hookArgs().subagentStart, { subagent_type: 'explore' }), { status: 0, stdout: allowOut, stderr: '' });
});

test('Claude Code hooks that Cursor imports do nothing when .cursor/hooks.json already wires the workflow', (t) => {
  const { repo } = withRun(t);
  const args = ['guard', 'preToolUse', '--from', 'claude-code'];
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '.agent-workflow/state.json' } });
  const before = repo.events().length;
  repo.file('.cursor/hooks.json', fs.readFileSync(HOOKS, 'utf8'));
  assert.deepEqual(repo.run(args, { input, env: { CURSOR_VERSION: '3.0.0' } }), { status: 0, stdout: '', stderr: '' }, 'skipped under Cursor');
  assert.equal(repo.events().length, before, 'nothing logged twice');
  const claude = repo.run(args, { input, env: { CURSOR_VERSION: '' } });
  assert.equal(claude.status, 2, 'still guards under Claude Code');
  assert.match(claude.stderr, /protected file/);
});

test('failClosed hooks still answer valid JSON on a malformed payload', (t) => {
  const hooks = hookArgs();
  const { repo } = withRun(t);
  for (const [event, hook] of Object.entries(hooks)) {
    if (!hook.failClosed) continue;
    const res = fire(repo, hook, 'not json');
    assert.ok([0, 2].includes(res.status), `${event} exit ${res.status}`);
    assert.doesNotThrow(() => JSON.parse(res.stdout), event);
  }
});

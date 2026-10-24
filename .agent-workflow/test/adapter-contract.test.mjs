// Adapter contract: raw harness payload -> normalized input -> core decision -> harness response.
// Phase 7 adapters (Claude Code, Hermes) must pass the same table with their own payload shapes.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as cursor from '../adapters/cursor.mjs';

test('cursor.normalize reads every supported payload shape', () => {
  const cases = [
    [{ tool_name: 'Write', tool_input: { file_path: 'a.js' } }, { tool: 'Write', filePath: 'a.js' }],
    [{ toolName: 'Edit', toolInput: { filePath: 'b.js' } }, { tool: 'Edit', filePath: 'b.js' }],
    [{ tool: 'Edit', input: { path: 'c.js' } }, { tool: 'Edit', filePath: 'c.js' }],
    [{ file_path: 'd.js' }, { tool: '', filePath: 'd.js' }],
    [{ filePath: 'e.js' }, { tool: '', filePath: 'e.js' }],
    [{ path: 'f.js' }, { tool: '', filePath: 'f.js' }],
    [{ tool_name: 'MultiEdit', tool_input: { file_path: ['g.js', 'h.js'] } }, { tool: 'MultiEdit', filePath: 'g.js' }],
    [{ tool_name: 'Read' }, { tool: 'Read', filePath: null }],
    [{ tool_input: { file_path: '' } }, { tool: '', filePath: null }],
    [{}, { tool: '', filePath: null }],
  ];
  for (const [raw, want] of cases) {
    const got = cursor.normalize('preToolUse', raw);
    assert.equal(got.tool, want.tool, JSON.stringify(raw));
    assert.equal(got.filePath, want.filePath, JSON.stringify(raw));
    assert.equal(got.event, 'preToolUse');
    assert.equal(got.raw, raw);
  }
});

test('cursor.normalize reads commands, loop count and the event name', () => {
  assert.equal(cursor.normalize('beforeShellExecution', { command: 'ls' }).command, 'ls');
  assert.equal(cursor.normalize('beforeShellExecution', { command_line: 'ls -a' }).command, 'ls -a');
  assert.equal(cursor.normalize('beforeShellExecution', { tool_input: { command: 'pwd' } }).command, 'pwd');
  assert.equal(cursor.normalize('beforeShellExecution', {}).command, '');
  assert.equal(cursor.normalize('stop', { loop_count: 3 }).loopCount, 3);
  assert.equal(cursor.normalize('stop', {}).loopCount, 0);
  assert.equal(cursor.normalize('', { hook_event_name: 'stop' }).event, 'stop');
  assert.equal(cursor.normalize(undefined, {}).event, '');
});

test('cursor.render: allow and deny for tool and shell events', () => {
  for (const event of ['preToolUse', 'beforeShellExecution']) {
    assert.deepEqual(cursor.render(event, { permission: 'allow' }), { stdout: '{"permission":"allow"}\n', exitCode: 0 });
    assert.deepEqual(
      cursor.render(event, { permission: 'deny', message: 'no' }),
      { stdout: '{"permission":"deny","user_message":"no","agent_message":"no"}\n', exitCode: 2 },
    );
  }
});

test('cursor.render: stop answers with a follow-up or {}', () => {
  assert.deepEqual(cursor.render('stop', { permission: 'allow', followup: 'again' }), { stdout: '{"followup_message":"again"}\n', exitCode: 0 });
  assert.deepEqual(cursor.render('stop', { permission: 'allow' }), { stdout: '{}\n', exitCode: 0 });
});

test('cursor.render: every other event answers {} with exit 0', () => {
  for (const event of ['afterFileEdit', 'sessionStart', 'weird', '']) {
    assert.deepEqual(cursor.render(event, { permission: 'allow' }), { stdout: '{}\n', exitCode: 0 });
  }
});

test('cursor.renderStatus wraps status text as additional_context', () => {
  assert.equal(cursor.renderStatus('a\nb'), '{"additional_context":"a\\nb"}\n');
});

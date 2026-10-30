// The contract every adapter must pass, run once per harness through the real CLI.
// Each harness supplies its payload shapes and how a deny / follow-up / status looks on the wire.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fresh } from './helpers.mjs';

const HARNESSES = {
  cursor: {
    write: (file) => ({ tool_name: 'Write', tool_input: { file_path: file } }),
    shell: (command) => ({ command }),
    denied: (res) => res.status === 2 && JSON.parse(res.stdout).permission === 'deny',
    reason: (res) => JSON.parse(res.stdout).user_message,
    allowed: (res) => res.status === 0,
    followup: (res) => JSON.parse(res.stdout).followup_message,
    status: (res) => JSON.parse(res.stdout).additional_context,
  },
  'claude-code': {
    write: (file) => ({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: file } }),
    shell: (command) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }),
    denied: (res) => res.status === 2 && res.stderr.trim().length > 0,
    reason: (res) => res.stderr,
    allowed: (res) => res.status === 0,
    followup: (res) => { const b = JSON.parse(res.stdout); assert.equal(b.decision, 'block'); return b.reason; },
    status: (res) => JSON.parse(res.stdout).hookSpecificOutput.additionalContext,
  },
};

for (const [name, h] of Object.entries(HARNESSES)) {
  const setup = (t) => {
    const repo = fresh(t);
    repo.startRun('feat');
    const call = (event, payload, extra = {}) => repo.run(['guard', event], { input: payload === undefined ? '' : JSON.stringify(payload), env: { WF_ADAPTER: name, ...extra } });
    return { repo, call };
  };

  test(`[${name}] denies a write outside the stage and allows one inside it`, (t) => {
    const { call } = setup(t);
    const outside = call('preToolUse', h.write('src/app.py'));
    assert.ok(h.denied(outside), outside.stdout + outside.stderr);
    assert.match(h.reason(outside), /stage planning cannot write src\/app\.py/);
    assert.ok(h.allowed(call('preToolUse', h.write('specs/spec-x/SPEC.md'))));
  });

  test(`[${name}] always denies protected workflow files`, (t) => {
    const { call } = setup(t);
    assert.ok(h.denied(call('preToolUse', h.write('.agent-workflow/state.json'))));
    assert.ok(h.denied(call('preToolUse', h.write('.agent-workflow/workflow.json'))));
  });

  test(`[${name}] denies frozen product tests during implement`, (t) => {
    const { repo, call } = setup(t);
    repo.setStage('implement');
    assert.ok(h.denied(call('preToolUse', h.write('E2E/tests/login.spec.ts'))));
    assert.ok(h.allowed(call('preToolUse', h.write('src/app.py'))));
  });

  test(`[${name}] blocks git commit, push and gh pr create until the final gate is approved`, (t) => {
    const { repo, call } = setup(t);
    for (const cmd of ['git commit -m x', 'git push origin main', 'gh pr create --fill']) {
      assert.ok(h.denied(call('beforeShellExecution', h.shell(cmd))), cmd);
    }
    assert.ok(h.allowed(call('beforeShellExecution', h.shell('git status'))));
    repo.update((s) => { s.gates.gate_final = { status: 'approved' }; });
    assert.ok(h.allowed(call('beforeShellExecution', h.shell('git commit -m x'))));
  });

  test(`[${name}] a blocked call emits a guard_blocked event`, (t) => {
    const { repo, call } = setup(t);
    call('preToolUse', h.write('src/app.py'));
    assert.ok(repo.events().some((e) => e.type === 'guard_blocked'));
    const queueDir = path.join(repo.wfDir, 'queue');
    const lines = fs.readdirSync(queueDir).filter((f) => f.endsWith('.jsonl')).flatMap((f) => fs.readFileSync(path.join(queueDir, f), 'utf8').split('\n').filter(Boolean));
    assert.ok(lines.some((l) => JSON.parse(l).type === 'guard_blocked'));
  });

  test(`[${name}] the stop hook asks for another implementation attempt, in this harness's format`, (t) => {
    const { repo, call } = setup(t);
    repo.config({ commands: { unit: 'echo FAILED REQ-1; exit 1' } });
    repo.setStage('implement');
    const res = call('stop', {});
    assert.equal(res.status, 0);
    assert.match(h.followup(res), /Implement loop round 1\/5/);
  });

  test(`[${name}] session start renders the status in this harness's format`, (t) => {
    const { repo } = setup(t);
    const res = repo.run(['status', '--hook'], { env: { WF_ADAPTER: name } });
    assert.equal(res.status, 0);
    assert.match(h.status(res), /stage: planning/);
  });

  test(`[${name}] empty and malformed payloads never crash a hook`, (t) => {
    const { call } = setup(t);
    for (const payload of [undefined, '{not json']) {
      const res = payload === undefined ? call('preToolUse', undefined) : call('preToolUse', undefined, {});
      assert.ok(res.status === 0 || res.status === 2, `${name}: exit ${res.status}`);
    }
    const bad = setup(t).repo.run(['guard', 'preToolUse'], { input: '{not json', env: { WF_ADAPTER: name } });
    assert.ok(bad.status === 0 || bad.status === 2);
  });
}

test('an unknown adapter name falls back to cursor rather than failing', (t) => {
  const repo = fresh(t);
  repo.startRun('feat');
  const res = repo.run(['guard', 'preToolUse'], { input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'src/x.py' } }), env: { WF_ADAPTER: 'nope' } });
  assert.equal(res.status, 2);
  assert.equal(JSON.parse(res.stdout).permission, 'deny');
});

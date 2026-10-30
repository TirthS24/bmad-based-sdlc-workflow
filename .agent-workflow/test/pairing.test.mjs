// Stage 11: sub-agent stops pair with their own starts by subagent id; the fallback is type and arrival order.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// agents.mjs reads WF_DIR when it loads, so point it at a scratch directory first.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-pair-'));
process.env.WF_DIR = dir;
process.env.REPO_ROOT = dir;
const { popSubagentStop, pushSubagentStart } = await import('../lib/telemetry/agents.mjs');

const fresh = () => fs.rmSync(path.join(dir, 'queue'), { recursive: true, force: true });

test('sequential: each stop pairs with its start', () => {
  fresh();
  pushSubagentStart('r', 'implementer', 't1', 'id1');
  assert.equal(popSubagentStop('r', 'implementer', 'id1'), 't1');
  assert.equal(popSubagentStop('r', 'implementer', 'id1'), null, 'nothing left to pair');
});

test('parallel starts of the same type pair by id, not by order', () => {
  fresh();
  pushSubagentStart('r', 'code-reviewer', 't1', 'id1');
  pushSubagentStart('r', 'code-reviewer', 't2', 'id2');
  assert.equal(popSubagentStop('r', 'code-reviewer', 'id2'), 't2');
  assert.equal(popSubagentStop('r', 'code-reviewer', 'id1'), 't1');
});

test('a stop with no start pairs with nothing and does not throw', () => {
  fresh();
  assert.equal(popSubagentStop('r', 'implementer', 'missing'), null);
  assert.equal(popSubagentStop('r', 'implementer'), null);
});

test('without ids, stops pair with the oldest start of that type', () => {
  fresh();
  pushSubagentStart('r', 'implementer', 't1');
  pushSubagentStart('r', 'implementer', 't2');
  assert.equal(popSubagentStop('r', 'implementer'), 't1');
  assert.equal(popSubagentStop('r', 'implementer'), 't2');
});

test('a stop with an id that matches no start falls back to an id-less start of its type', () => {
  fresh();
  pushSubagentStart('r', 'implementer', 't1');
  assert.equal(popSubagentStop('r', 'implementer', 'unknown'), 't1');
});

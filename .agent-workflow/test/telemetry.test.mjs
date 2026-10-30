// Phase 3: scrubber corpus, local queue, and event capture through the real CLI.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fresh, withRun } from './helpers.mjs';

// Library modules read WF_DIR at import, so point it at a scratch dir before loading them.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-tel-'));
process.env.WF_DIR = path.join(scratch, '.agent-workflow');
process.env.REPO_ROOT = scratch;
fs.mkdirSync(process.env.WF_DIR, { recursive: true });
const { scrubText, scrubValue, DEFAULT_PATTERNS } = await import('../lib/telemetry/scrub.mjs');
const q = await import('../lib/telemetry/queue.mjs');

test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const resetQueue = () => fs.rmSync(q.QUEUE_DIR, { recursive: true, force: true });

// ---- scrubber ----------------------------------------------------------------------------

const PII = [
  ['email', 'contact jane.doe+test@example.co.uk about it', 'jane.doe+test@example.co.uk'],
  ['ssn', 'ssn 123-45-6789 on file', '123-45-6789'],
  ['phone', 'call (415) 555-0132 today', '555-0132'],
  ['phone', 'call +1 415.555.0132 today', '415.555.0132'],
  ['card', 'card 4111 1111 1111 1111 declined', '4111 1111 1111 1111'],
  ['dob', 'Patient DOB: 03/14/1985 noted', '03/14/1985'],
  ['dob', 'born March 14, 1985', 'March 14, 1985'],
  ['name', 'patient name: Maria Gonzalez-Lopez was seen', 'Maria'],
  ['name', 'Client: John Smith', 'John Smith'],
  ['account', 'invoice number INV-2024-00871 is overdue', 'INV-2024-00871'],
  ['account', 'acct # 99812734 closed', '99812734'],
  ['account', 'MRN: 00123456', '00123456'],
];

test('scrubber: known PHI/PII samples never survive', () => {
  for (const [category, input, secret] of PII) {
    const { text, hits } = scrubText(input);
    assert.ok(!text.includes(secret), `${category}: "${secret}" still in "${text}"`);
    assert.ok(hits[category] >= 1, `${category} not reported for "${input}"`);
  }
});

test('scrubber: benign text passes untouched', () => {
  const benign = [
    'stage feasibility completed in 5200 ms',
    'REQ-12 PRD-1.2 TECH-api-auth',
    '2026-10-28T09:15:00.000Z',
    'run 20261028-add-items on branch wf/20261028-add-items',
    'sha 9f2c1d7 and version 18.3.1',
    'the account page shows a list of invoices',
    'src/app/main.py:3',
    'name the function clearly',
  ];
  for (const text of benign) assert.deepEqual(scrubText(text), { text, hits: {} }, text);
});

test('scrubber: labelled values are replaced, the label stays', () => {
  assert.equal(scrubText('DOB: 03/14/1985').text, 'DOB: [REDACTED:dob]');
  assert.equal(scrubText('Client: John Smith ok').text, 'Client: [REDACTED:name] ok');
});

test('scrubber: walks nested values and counts hits', () => {
  const { value, hits } = scrubValue({ a: ['x@y.com', { b: 'ssn 123-45-6789' }], n: 5 });
  assert.deepEqual(value, { a: ['[REDACTED:email]', { b: 'ssn [REDACTED:ssn]' }], n: 5 });
  assert.deepEqual(hits, { email: 1, ssn: 1 });
});

test('scrubber: a pattern file adds categories and disables others', () => {
  fs.writeFileSync(path.join(process.env.WF_DIR, 'scrub-patterns.json'), JSON.stringify({
    patterns: [{ category: 'employee', regex: 'EMP-\\d{6}' }],
    disable: ['phone'],
  }));
  return import('../lib/telemetry/scrub.mjs').then(({ loadPatterns, scrubText: st }) => {
    const p = loadPatterns();
    assert.equal(st('badge EMP-004521', p).text, 'badge [REDACTED:employee]');
    assert.equal(st('call (415) 555-0132', p).text, 'call (415) 555-0132');
    fs.rmSync(path.join(process.env.WF_DIR, 'scrub-patterns.json'));
    assert.ok(DEFAULT_PATTERNS.length >= 7);
  });
});

// ---- queue -------------------------------------------------------------------------------

const ev = (n) => ({ event_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, type: 'stage_started', ts: 't' });

test('queue: seals into batches and keeps them until acknowledged', () => {
  resetQueue();
  q.enqueue([ev(1), ev(2)]);
  const name = q.seal();
  assert.match(name, /^batch-/);
  assert.equal(q.listBatches().length, 1);
  assert.deepEqual(q.readBatch(name).map((e) => e.event_id), [ev(1).event_id, ev(2).event_id]);
  assert.equal(q.listBatches().length, 1, 'reading does not delete');
  q.ackBatch(name);
  assert.equal(q.listBatches().length, 0);
});

test('queue: a torn last line from a crash does not lose or corrupt neighbours', () => {
  resetQueue();
  q.enqueue([ev(1)]);
  fs.appendFileSync(path.join(q.QUEUE_DIR, 'current.jsonl'), '{"event_id":"torn');
  q.enqueue([ev(2)]);
  const events = q.readBatch(q.seal());
  assert.deepEqual(events.map((e) => e.event_id), [ev(1).event_id, ev(2).event_id]);
});

test('queue: duplicate event ids inside a batch collapse to one', () => {
  resetQueue();
  q.enqueue([ev(1), ev(1), ev(2)]);
  assert.equal(q.readBatch(q.seal()).length, 2);
});

test('queue: partial acknowledgement keeps only the unacknowledged events', () => {
  resetQueue();
  q.enqueue([ev(1), ev(2), ev(3)]);
  const name = q.seal();
  q.rewriteBatch(name, q.readBatch(name).filter((e) => e.event_id === ev(2).event_id));
  assert.deepEqual(q.readBatch(name).map((e) => e.event_id), [ev(2).event_id]);
  q.rewriteBatch(name, []);
  assert.equal(q.listBatches().length, 0);
});

test('queue: size cap evicts the oldest batches first and counts them', () => {
  resetQueue();
  for (let i = 1; i <= 3; i += 1) {
    q.enqueue([ev(i)]);
    q.seal();
  }
  const [oldest, ...rest] = q.listBatches();
  const one = fs.statSync(path.join(q.QUEUE_DIR, oldest)).size;
  const dropped = q.enforceCaps({ maxAgeMs: 1e12, maxBytes: one * 2 });
  assert.equal(dropped, 1);
  assert.deepEqual(q.listBatches(), rest);
  assert.equal(q.queueStats().dropped_events, 1);
});

test('queue: age cap evicts batches older than the limit', () => {
  resetQueue();
  q.enqueue([ev(1)]);
  q.seal();
  assert.equal(q.enforceCaps({ maxAgeMs: 1000, maxBytes: 1e9 }, Date.now() + 5000), 1);
  assert.equal(q.listBatches().length, 0);
});

test('queue: enforcing caps never deletes within the limits', () => {
  resetQueue();
  q.enqueue([ev(1), ev(2)]);
  assert.equal(q.enforceCaps(), 0);
  assert.equal(q.queueStats().events, 2);
});

// ---- capture through the CLI -------------------------------------------------------------

function queued(repo) {
  const dir = path.join(repo.wfDir, 'queue');
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.jsonl')) {
      for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean)) out.push(JSON.parse(l));
    }
  }
  return out;
}

test('capture: a run emits typed events with ids and no raw content', (t) => {
  const { repo, id } = withRun(t, 'Add items for patient name: Jane Roe');
  const events = queued(repo);
  const types = events.map((e) => e.type).filter((x) => x !== 'scrub_hit');
  assert.deepEqual(types.slice(0, 2), ['run_started', 'stage_started']);
  for (const e of events) {
    assert.match(e.event_id, /^[0-9a-f-]{36}$/);
    assert.equal(e.run_id, id);
    assert.equal(e.session_id, id);
  }
  assert.ok(events.some((e) => e.type === 'scrub_hit'), 'PII in the ticket text is counted');
  const text = JSON.stringify(events);
  assert.ok(!text.includes('Jane Roe'), 'ticket text never leaves the machine');
  assert.ok(!text.includes('Add items'), 'free text is not captured at all');
  const hit = events.find((e) => e.type === 'scrub_hit');
  assert.deepEqual(hit.attrs, { category: 'name', count: 1 });
});

test('capture: stage and gate transitions, durations, and a scrubbed rejection reason', (t) => {
  const { repo, id } = withRun(t);
  repo.seedPlanning(id);
  assert.equal(repo.run(['done', 'planning']).status, 0);
  assert.equal(repo.run(['reject', 'gate_spec', '--reason', 'unclear goals, ask jane@corp.com']).status, 0);
  const events = queued(repo);
  const by = (type) => events.filter((e) => e.type === type);
  assert.equal(by('stage_completed')[0].stage, 'planning');
  assert.equal(typeof by('stage_completed')[0].attrs.duration_ms, 'number');
  assert.equal(by('gate_requested')[0].attrs.gate, 'gate_spec');
  const rej = by('gate_rejected')[0];
  assert.equal(rej.attrs.gate, 'gate_spec');
  assert.equal(rej.attrs.count, 1);
  assert.equal(rej.attrs.reason, 'unclear goals, ask [REDACTED:email]');
  assert.ok(typeof rej.attrs.wait_ms === 'number');
  assert.ok(by('scrub_hit').some((e) => e.attrs.category === 'email'));
  assert.ok(!JSON.stringify(events).includes('jane@corp.com'));
});

test('capture: guard blocks, loop rounds and agent failures are typed events', (t) => {
  const { repo } = withRun(t);
  repo.guard('preToolUse', { tool_name: 'Write', tool_input: { file_path: 'src/x.py' } });
  repo.run(['report-failure', 'timeout', 'solution-architect']);
  const events = queued(repo);
  assert.ok(events.some((e) => e.type === 'guard_blocked' && e.attrs.kind === 'path'));
  assert.ok(events.some((e) => e.type === 'error' && e.attrs.error_class === 'guard_block'));
  const failed = events.find((e) => e.type === 'agent_failed');
  assert.deepEqual(failed.attrs, { agent: 'solution-architect', error_class: 'timeout' });
  assert.notEqual(repo.run(['report-failure', 'bogus']).status, 0);
});

test('capture: file paths and commands seen by hooks are scanned but never stored', (t) => {
  const { repo } = withRun(t);
  repo.setStage('implement');
  repo.guard('beforeShellExecution', { command: 'echo patient name: Carl Jones' });
  const events = queued(repo);
  assert.ok(events.some((e) => e.type === 'scrub_hit' && e.attrs.category === 'name'));
  assert.ok(!JSON.stringify(events).includes('Carl'));
  assert.ok(!fs.readFileSync(path.join(repo.wfDir, 'events.jsonl'), 'utf8').includes('Carl'));
});

test('capture: a generic harness records session_unchecked', (t) => {
  const repo = fresh(t);
  repo.file('.agent-workflow/adapter', 'generic\n');
  repo.startRun('feat');
  assert.ok(queued(repo).some((e) => e.type === 'session_unchecked' && e.attrs.harness === 'generic'));
});

test('capture: telemetry can be switched off and never blocks the workflow', (t) => {
  const repo = fresh(t);
  repo.config({ telemetry: { enabled: false } });
  repo.startRun('feat');
  assert.deepEqual(queued(repo), []);
});

test('capture: pr, abort and pause end the run', (t) => {
  const { repo } = withRun(t);
  repo.run(['pause']);
  assert.ok(queued(repo).some((e) => e.type === 'run_ended' && e.attrs.status === 'paused'));
});

test('capture: done planning emits human_escalations without question text', async () => {
  const { mapLocal } = await import('../lib/telemetry/capture.mjs');
  const ev = mapLocal(
    'done',
    { stage: 'planning', next: 'gate_spec', human_escalations: 2 },
    { run: { id: 'r1' }, gates: { gate_spec: { status: 'pending' } }, current: { stage: 'planning' } },
    50,
  );
  const he = ev.find((e) => e.type === 'human_escalations');
  assert.deepEqual(he?.attrs, { count: 2 });
  assert.ok(!JSON.stringify(ev).includes('Q-1'));
});

test('capture: subagentStop emits agent_run from duration_ms', async () => {
  const { mapLocal } = await import('../lib/telemetry/capture.mjs');
  const ended = '2026-10-30T12:00:00.000Z';
  const ev = mapLocal(
    'subagent_stop',
    { agent: 'explore', status: 'completed', durationMs: 5000, ended_at: ended },
    { run: { id: 'r1' }, current: { stage: 'planning' } },
    null,
  );
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'agent_run');
  assert.equal(ev[0].attrs.agent, 'explore');
  assert.equal(ev[0].attrs.duration_ms, 5000);
  assert.equal(ev[0].attrs.started_at, '2026-10-30T11:59:55.000Z');
});

// Stage 7: auto-pass gates (4a.6). A profile may pass a gate; a declined auto-pass says why.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ticketsHash } from '../lib/tickets.mjs';
import { VALID_TICKET_BE, assertOk, fresh, withRun } from './helpers.mjs';

const LOW_RISK = [
  'recommended: A',
  'public_contract_change: no',
  'migration: no',
  'new_dependency: no',
  'files: src/payments.py',
].join('\n');

function approachWith(block) {
  return [
    'Verdict: with-changes',
    '## Approach A', 'Small fix. Fits in one commit.',
    '## Approach B', 'Bigger fix. Fits in one commit.',
    '## Decision', block,
    '## Non-functional', 'None.',
    '## Risks', 'Low.',
    '## Rollback', 'Revert.',
  ].join('\n');
}

// A dev run with the planning inputs seeded, and one automated test case (the bug repro).
function devPlanning(t) {
  const repo = fresh(t);
  repo.config({ commands: { unit: '', lint: '' } });
  assertOk(repo.run(['run', '--profile', 'dev', 'alpha bug']));
  const id = repo.state().run.id;
  repo.seedPlanning(id);
  const ticket = JSON.parse(JSON.stringify(VALID_TICKET_BE));
  ticket.acceptance_criteria[0].test_cases[0].automation = 'automated';
  ticket.acceptance_criteria[0].test_cases[0].layer = 'e2e';
  repo.file(`specs/spec-${id}/tickets/be/TKT-BE-001.json`, `${JSON.stringify(ticket, null, 2)}\n`);
  return { repo, id };
}

test('ticketsHash ignores external.jira_key but not other ticket fields', (t) => {
  const { repo, id } = withRun(t);
  repo.seedPlanning(id);
  const file = `specs/spec-${id}/tickets/be/TKT-BE-001.json`;
  const before = ticketsHash(repo.state());
  const ticket = { ...VALID_TICKET_BE, external: { jira_key: 'ABC-1' } };
  repo.file(file, JSON.stringify(ticket));
  assert.equal(ticketsHash(repo.state()), before, 'jira_key is not a ticket change');
  repo.file(file, JSON.stringify({ ...ticket, title: 'Changed' }));
  assert.notEqual(ticketsHash(repo.state()), before, 'any other field is');
});

test('dev: planning_clean auto-passes gate_spec and the run moves to feasibility', (t) => {
  const { repo } = devPlanning(t);
  assertOk(repo.run(['done', 'planning']));
  const s = repo.state();
  assert.equal(s.gates.gate_spec.approved_by, 'auto');
  assert.equal(s.gates.gate_spec.condition, 'planning_clean');
  assert.equal(s.current.stage, 'feasibility');
});

test('dev: an escalation pending keeps gate_spec with you, and says so', (t) => {
  const { repo } = devPlanning(t);
  const s = repo.state();
  s.escalations.push({ level: 'CRITICAL', stage: 'planning', reason: 'x', at: new Date().toISOString() });
  fs.writeFileSync(path.join(repo.wfDir, 'state.json'), `${JSON.stringify(s, null, 2)}\n`);
  assertOk(repo.run(['done', 'planning']));
  const after = repo.state();
  assert.equal(after.current.stage, 'gate_spec');
  assert.equal(after.gates.gate_spec.status, 'pending');
  assert.match(after.gates.gate_spec.auto_declined.reason, /an escalation is pending/);
  assert.match(after.current.next_action, /Auto-pass not applied: an escalation is pending/);
});

test('dev: approach_low_risk auto-passes gate_approach and records the recommended approach', (t) => {
  const { repo, id } = devPlanning(t);
  assertOk(repo.run(['done', 'planning']));
  repo.file(`specs/spec-${id}/approach.md`, approachWith(LOW_RISK));
  assertOk(repo.run(['done', 'feasibility']));
  const s = repo.state();
  assert.equal(s.gates.gate_approach.approved_by, 'auto');
  assert.equal(s.gates.gate_approach.approach, 'A');
  assert.equal(s.current.stage, 'tests');
});

test('dev: a migration keeps gate_approach with you, and the reason names the flag', (t) => {
  const { repo, id } = devPlanning(t);
  assertOk(repo.run(['done', 'planning']));
  repo.file(`specs/spec-${id}/approach.md`, approachWith(LOW_RISK.replace('migration: no', 'migration: yes')));
  assertOk(repo.run(['done', 'feasibility']));
  const s = repo.state();
  assert.equal(s.current.stage, 'gate_approach');
  assert.equal(s.gates.gate_approach.status, 'pending');
  assert.match(s.gates.gate_approach.auto_declined.reason, /migration: yes/);
});

test('pm: gate_final stays with you when a file outside the specs changed', (t) => {
  const repo = fresh(t);
  repo.config({ commands: { unit: '', lint: '' } });
  assertOk(repo.run(['run', '--profile', 'pm', 'docs only']));
  repo.seedPlanning(repo.state().run.id);
  assertOk(repo.run(['done', 'planning']));
  repo.file('README.md', 'changed\n');
  assertOk(repo.run(['approve', 'gate_spec']));
  const s = repo.state();
  assert.equal(s.current.stage, 'gate_final');
  assert.match(s.gates.gate_final.auto_declined.reason, /changed outside specs: README\.md/);
});

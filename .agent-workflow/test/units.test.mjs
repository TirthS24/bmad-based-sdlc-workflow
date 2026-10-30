// Unit tests for the pure helpers (no subprocess, no filesystem).
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  expandWritePatterns, globToRegExp, matchesAnyGlob, matchesGlob, writesAllowed,
} from '../lib/globs.mjs';
import { capabilityBlock, reqIds } from '../lib/postconditions.mjs';
import { NEXT_ACTION, fillAction, formatStatus } from '../lib/state.mjs';
import { guardShell } from '../lib/guards.mjs';
import { parseArgs } from '../wf.mjs';
import { VALID_SRS, VALID_QUESTIONS, VALID_TICKET_BE, withRun } from './helpers.mjs';
import { checkQuestions, checkTickets } from '../lib/tickets.mjs';

test('globToRegExp: *, ** and escaping', () => {
  assert.ok(globToRegExp('src/*.js').test('src/a.js'));
  assert.ok(!globToRegExp('src/*.js').test('src/x/a.js'));
  assert.ok(globToRegExp('src/**').test('src/x/y/a.js'));
  assert.ok(globToRegExp('**/*.test.ts').test('a.test.ts'));
  assert.ok(globToRegExp('**/*.test.ts').test('a/b/c.test.ts'));
  assert.ok(!globToRegExp('**/*.test.ts').test('a/b/c.test.js'));
  assert.ok(!globToRegExp('a.b').test('axb'), 'dot is literal');
  assert.ok(globToRegExp('a\\b').test('a/b'), 'backslashes become slashes');
  assert.ok(globToRegExp('.agent-workflow/state.json').test('.agent-workflow/state.json'));
});

test('matchesGlob: leading ./ and the directory itself for /**', () => {
  assert.ok(matchesGlob('./src/a.js', 'src/**'));
  assert.ok(matchesGlob('src', 'src/**'));
  assert.ok(matchesGlob('src/a/b.js', 'src/**'));
  assert.ok(!matchesGlob('srcx/a.js', 'src/**'));
  assert.ok(!matchesGlob('docs/a.md', 'src/**'));
});

test('writesAllowed: later patterns win and negation blocks', () => {
  const patterns = ['src/**', '!tests/**'];
  assert.equal(writesAllowed('src/a.js', patterns), true);
  assert.equal(writesAllowed('tests/a.js', patterns), false);
  assert.equal(writesAllowed('docs/a.md', patterns), false);
  assert.equal(writesAllowed('src/a.js', ['!src/**', 'src/**']), true, 'last match wins');
  assert.equal(writesAllowed('src/a.js', []), false);
});

test('expandWritePatterns replaces <test_globs>', () => {
  const config = { test_globs: ['t/**', '**/*.spec.ts'] };
  assert.deepEqual(expandWritePatterns(['<test_globs>'], config), ['t/**', '**/*.spec.ts']);
  assert.deepEqual(expandWritePatterns(['src/**', '!<test_globs>'], config), ['src/**', '!t/**', '!**/*.spec.ts']);
  assert.deepEqual(expandWritePatterns(['x'], {}), ['x']);
  assert.deepEqual(expandWritePatterns(['<test_globs>'], {}), []);
});

test('matchesAnyGlob tolerates a missing list', () => {
  assert.equal(matchesAnyGlob('a', undefined), false);
  assert.equal(matchesAnyGlob('a.js', ['*.js']), true);
});

test('reqIds finds unique REQ ids only', () => {
  assert.deepEqual(reqIds('REQ-1 REQ-2 REQ-1 xREQ-3 REQ-x'), ['REQ-1', 'REQ-2']);
  assert.deepEqual(reqIds('nothing'), []);
});

test('capabilityBlock slices from the id to the next capability or heading', () => {
  const text = '## Caps\n- **REQ-1** one\n  - **success:** a\n- **REQ-2** two\n  - nothing\n\n## Next\nstuff\n';
  assert.match(capabilityBlock(text, 'REQ-1'), /success:/);
  assert.doesNotMatch(capabilityBlock(text, 'REQ-1'), /REQ-2/);
  assert.doesNotMatch(capabilityBlock(text, 'REQ-2'), /stuff/);
  assert.equal(capabilityBlock(text, 'REQ-9'), '');
});

test('fillAction fills <id> and has text for every stage', () => {
  assert.match(fillAction('planning', 'r1'), /specs\/spec-r1\/SRS\.md/);
  assert.equal(fillAction('nope', 'r1'), '');
  assert.deepEqual(Object.keys(NEXT_ACTION), [
    'planning', 'gate_spec', 'feasibility', 'gate_approach', 'tests', 'gate_tests',
    'implement', 'review', 'gate_review', 'verify', 'gate_final', 'pr', 'done',
  ]);
});

test('formatStatus without a run', () => {
  assert.match(formatStatus(null), /^No active workflow run/);
});

test('guardShell: decisions for guarded and free commands', () => {
  const workflow = { guarded_shell_patterns: ['^git\\s+commit', 'refs/for/'] };
  const run = { run: { id: 'r' }, gates: { gate_final: { status: 'pending' } } };
  assert.deepEqual(guardShell({ command: 'git commit -m x' }, run, workflow), { permission: 'deny', message: 'blocked until the final gate is approved: git commit -m x' });
  assert.deepEqual(guardShell({ command: 'ls' }, run, workflow), { permission: 'allow' });
  assert.deepEqual(guardShell({ command: 'git commit' }, null, workflow), { permission: 'allow' });
  const approved = { run: { id: 'r' }, gates: { gate_final: { status: 'approved' } } };
  assert.deepEqual(guardShell({ command: 'git commit' }, approved, workflow), { permission: 'allow' });
});

test('parseArgs separates flags from positionals', () => {
  assert.deepEqual(parseArgs(['done', 'tests', '--result', 'x', '--force']), {
    flags: { result: 'x', force: true },
    rest: ['done', 'tests'],
  });
  assert.deepEqual(parseArgs(['approve', 'gate1', '--approach', 'B']).flags, { approach: 'B' });
  assert.deepEqual(parseArgs(['status', '--check', '--hook', '--dry-run']).flags, { check: true, hook: true, dryRun: true });
});

test('importing wf.mjs does not run the CLI', () => {
  // Reaching this line means the import at the top of this file returned without exiting.
  assert.equal(typeof parseArgs, 'function');
});

test('checkTickets: validation cases', (t) => {
  const { repo, id } = withRun(t);
  repo.seedPlanning(id);
  const state = repo.state();
  const srs = VALID_SRS;
  const dir = `specs/spec-${id}/tickets/be`;
  assert.equal(checkTickets(state, srs).length, 0);
  repo.file(`${dir}/bad.json`, '{}');
  assert.ok(checkTickets(state, srs).some((p) => /missing id|missing persona/.test(p)));
  repo.file(`${dir}/bad.json`, `${JSON.stringify({ ...VALID_TICKET_BE, id: 'TKT-BE-001', persona: 'qa' }, null, 2)}\n`);
  assert.ok(checkTickets(state, srs).some((p) => /persona folder/.test(p)));
});

test('checkQuestions: synthesis sources and human answers', (t) => {
  const { repo, id } = withRun(t);
  repo.seedPlanning(id);
  const state = repo.state();
  assert.equal(checkQuestions(state).length, 0);
  repo.file(`specs/spec-${id}/grill/questions.json`, JSON.stringify([{
    ...VALID_QUESTIONS[0],
    answered_by: 'synthesis',
    sources: [],
  }]));
  assert.ok(checkQuestions(state).some((p) => /no sources/.test(p)));
  repo.file(`specs/spec-${id}/grill/questions.json`, JSON.stringify([{
    ...VALID_QUESTIONS[0],
    answered_by: 'synthesis',
    sources: ['https://evil.slack.com/archives/C123'],
  }]));
  assert.ok(checkQuestions(state).some((p) => /Slack-only/.test(p)));
  repo.file(`specs/spec-${id}/grill/questions.json`, JSON.stringify([{
    ...VALID_QUESTIONS[0],
    answered_by: 'human',
    sources: [],
  }]));
  assert.equal(checkQuestions(state).length, 0);
});

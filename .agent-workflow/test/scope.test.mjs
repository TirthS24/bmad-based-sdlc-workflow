// Stage 5: the diff scope check fails `done` when a stage changes files outside its writes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { withRun } from './helpers.mjs';

test('done: a file outside the stage writes fails and is named', (t) => {
  const { repo } = withRun(t);
  repo.file('docs/x.md', '# x\n');
  const res = repo.run(['done', 'planning']);
  assert.equal(res.status, 1, res.stdout);
  assert.match(res.stderr, /writes stay in scope: found docs\/x\.md/);
});

test('done: files inside the stage writes are not flagged', (t) => {
  const { repo, id } = withRun(t);
  repo.file(`specs/spec-${id}/SRS.md`, '# SRS\n');
  assert.doesNotMatch(repo.run(['done', 'planning']).stderr, /writes stay in scope/);
});

test('done implement: a file written from the shell is named, not just the postcondition', (t) => {
  const { repo } = withRun(t);
  repo.setStage('implement');
  repo.file('docs/x.md', 'x\n');
  assert.match(repo.run(['done', 'implement']).stderr, /writes stay in scope: found docs\/x\.md/);
});

test('stop hook: a stray write is reported in the follow-up and never blocks', (t) => {
  const { repo } = withRun(t);
  repo.file('docs/x.md', 'x\n');
  const res = repo.guard('stop', {});
  assert.match(res.body.followup_message, /Out-of-scope changes in planning: docs\/x\.md/);
});

test('done: a shell write to workflow config is flagged, not hidden by the engine folder', (t) => {
  const { repo } = withRun(t);
  repo.file('.agent-workflow/lib/extra.mjs', 'export {};\n');
  assert.match(repo.run(['done', 'planning']).stderr, /writes stay in scope: found .*\.agent-workflow\/lib\/extra\.mjs/);
});

test('done: unusual paths are reported verbatim (git quoting does not hide them)', (t) => {
  const { repo } = withRun(t);
  repo.file('docs/café notes.md', 'x\n');
  assert.match(repo.run(['done', 'planning']).stderr, /writes stay in scope: found docs\/café notes\.md/);
});

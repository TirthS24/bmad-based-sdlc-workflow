// Regression tests for the Stage 4 validator fixes: REQ definition matching, numbered SRS headings,
// source paths with line ranges, numbered approach headings and the review summary line.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { capabilityBlock, checkFeasibility, checkReviewToVerify } from '../lib/postconditions.mjs';
import { checkQuestions, srsSectionChecks } from '../lib/tickets.mjs';
import { formatProblem } from '../lib/problems.mjs';
import { withRun } from './helpers.mjs';

test('capabilityBlock: only the REQ definition line counts, and REQ-1 never matches REQ-10', () => {
  const text = [
    'Intro mentions REQ-1 in passing.',
    '- **REQ-1** Users sign in. **success:** 200',
    '- **REQ-10** Other feature. **success:** 404',
  ].join('\n');
  assert.match(capabilityBlock(text, 'REQ-1'), /Users sign in/);
  assert.doesNotMatch(capabilityBlock(text, 'REQ-1'), /REQ-10|Other feature/);
  assert.match(capabilityBlock(text, 'REQ-10'), /Other feature/);
  assert.equal(capabilityBlock(text, 'REQ-2'), '');
});

test('srsSectionChecks: numbered headings with a dot, a parenthesis or nothing are all accepted', () => {
  const text = [
    '## 1. Introduction', '## 2) Overall description', '## 3 Functional requirements',
    '## 4. External interfaces', '## 5) Non-functional', '## 6 Non-goals', '## 7. Traceability',
    '- **REQ-1** Users sign in. **success:** 200',
  ].join('\n');
  assert.deepEqual(srsSectionChecks(text).filter((p) => p.rule.startsWith('SRS section')), []);
  const missing = srsSectionChecks(text.replace('## 6 Non-goals', '## 6 Scope'));
  assert.ok(missing.some((p) => p.rule === 'SRS section 6'));
});

test('checkQuestions: source paths may carry a line range', (t) => {
  const { repo, id } = withRun(t);
  repo.file('docs/a.md', '# a\n');
  const q = (sources) => [{ id: 'Q1', status: 'answered', answered_by: 'synthesis', sources }];
  repo.file(`specs/spec-${id}/grill/questions.json`, JSON.stringify(q(['docs/a.md:12', 'docs/a.md:12-30', 'docs/a.md#L12-L30'])));
  assert.deepEqual(checkQuestions(repo.state()), []);
  repo.file(`specs/spec-${id}/grill/questions.json`, JSON.stringify(q(['docs/missing.md:3'])));
  const [p] = checkQuestions(repo.state());
  assert.equal(p.rule, 'synthesis source');
  assert.match(formatProblem(p), /docs\/missing\.md:3/);
});

test('checkFeasibility: the Decision and Rollback headings accept numbering', (t) => {
  const { repo, id } = withRun(t);
  repo.file(`specs/spec-${id}/approach.md`, [
    'Verdict: with-changes',
    '## Approach A', 'Small change.',
    '## Approach B', 'Bigger change. Fits in one commit.',
    '## 3. Decision', 'Pick A.',
    '## 4) Non-functional', 'Fast enough.',
    '## 5. Risks', 'Low.',
    '## 6 Rollback', 'Revert the commit.',
  ].join('\n'));
  assert.deepEqual(checkFeasibility(repo.state()), []);
});

test('checkReviewToVerify: a "- open: 0" summary line is not an untagged finding', (t) => {
  const { repo } = withRun(t);
  const file = path.join(repo.root, 'review.md');
  fs.writeFileSync(file, [
    '## Standards', '- open: 0',
    '## Spec conformance', '- [low] nit',
    '## Approach conformance', 'N/A — no feasibility stage',
    '## Test quality', '- open: 0',
  ].join('\n'));
  assert.deepEqual(checkReviewToVerify(file), []);
});

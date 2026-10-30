// Phase 2: product/unit test split, e2e exit-code mapping, report coverage, and a
// red-then-green fixture run driven by a fake Playwright that writes the JSON report.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { VALID_TICKET_BE, VALID_TEST_PLAN, withRun } from './helpers.mjs';

const edit = (file) => ({ tool_name: 'Write', tool_input: { file_path: file } });
const fails = (res, re) => {
  assert.equal(res.status, 1, res.stdout);
  assert.match(res.stderr, re);
};

const FAKE_PW = `
import fs from 'node:fs';
import path from 'node:path';
const status = process.env.FAKE_STATUS || (fs.existsSync('src/greeting.js') ? 'expected' : 'unexpected');
const title = process.env.FAKE_TITLE || 'PRD-1.1 REQ-1 greeting shows';
// FAKE_SPECS: JSON [[title, status], ...] for multi-test suites. FAKE_ERROR: extra failure text.
const specs = process.env.FAKE_SPECS ? JSON.parse(process.env.FAKE_SPECS) : [[title, status]];
const out = process.env.PLAYWRIGHT_JSON_OUTPUT_NAME;
if (out && !process.env.FAKE_NO_REPORT) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ suites: [{ file: 'greeting.spec.ts', specs: specs.map(([t, st]) => (
    { title: t, ok: st !== 'unexpected', tests: [{ status: st }] })) }] }));
}
// Like the list reporter: every title is printed, passing or not.
for (const [t, st] of specs) console.log((st === 'unexpected' ? '  x ' : '  ok ') + t);
if (process.env.FAKE_ERROR) console.log(process.env.FAKE_ERROR);
process.exit(specs.some(([, st]) => st === 'unexpected') ? 1 : 0);
`;

function setup(t) {
  const ctx = withRun(t);
  const { repo } = ctx;
  repo.config({
    product_test_globs: ['E2E/tests/**'],
    unit_test_globs: ['tests/**/*.py'],
    commands: { unit: '', lint: '', e2e: 'node fake-pw.mjs' },
  });
  repo.file('fake-pw.mjs', FAKE_PW);
  repo.seedPlanning(ctx.id);
  repo.file(`specs/spec-${ctx.id}/tickets/be/TKT-BE-001.json`, `${JSON.stringify({
    ...VALID_TICKET_BE,
    acceptance_criteria: [{
      id: 'AC-1',
      text: 'Works',
      test_cases: [{
        id: 'PRD-1.1',
        title: 'Happy path',
        given: 'system up',
        when: 'user acts',
        then: 'it works',
        layer: 'e2e',
        automation: 'automated',
      }],
    }],
  }, null, 2)}\n`);
  return ctx;
}

test('split globs: implementer may write unit tests but never product tests', (t) => {
  const { repo } = setup(t);
  repo.setStage('implement');
  assert.equal(repo.guard('preToolUse', edit('tests/test_a.py')).status, 0);
  assert.equal(repo.guard('preToolUse', edit('src/a.ts')).status, 0);
  const res = repo.guard('preToolUse', edit('E2E/tests/login.spec.ts'));
  assert.equal(res.status, 2);
  assert.match(res.body.user_message, /frozen tests: E2E\/tests\/login\.spec\.ts is in product_test_globs for stage implement/);
});

test('split globs: the tests stage writes product tests only', (t) => {
  const { repo } = setup(t);
  repo.setStage('tests');
  assert.equal(repo.guard('preToolUse', edit('E2E/tests/login.spec.ts')).status, 0);
  assert.equal(repo.guard('preToolUse', edit('tests/test_a.py')).status, 2);
});

test('freeze hash ignores unit tests and follows product tests', (t) => {
  const { repo } = setup(t);
  repo.setStage('tests');
  repo.file('E2E/tests/a.spec.ts', 'A');
  const hashFor = () => {
    repo.setStage('tests');
    assert.equal(repo.run(['done', 'tests']).status, 0);
    return repo.state().freeze.test_files_hash;
  };
  const h1 = hashFor();
  repo.file('tests/test_unit.py', 'U');
  assert.equal(hashFor(), h1);
  repo.file('E2E/tests/a.spec.ts', 'B');
  assert.notEqual(hashFor(), h1);
});

test('tests stage: e2e must fail and cite an id; exit 0 is refused', (t) => {
  const { repo } = setup(t);
  repo.setStage('tests');
  fails(repo.run(['done', 'tests'], { env: { FAKE_STATUS: 'expected' } }), /new tests are red: found the e2e tier exited 0/);
  fails(repo.run(['done', 'tests'], { env: { FAKE_TITLE: 'no ids here' } }), /failures cite ids/);
  assert.equal(repo.run(['done', 'tests']).status, 0);
});

test('verify: a failing e2e test blocks, a missing report blocks', (t) => {
  const { repo } = setup(t);
  repo.setStage('verify');
  fails(repo.run(['done', 'verify']), /e2e tier: found exit 1/);
  fails(repo.run(['done', 'verify'], { env: { FAKE_STATUS: 'expected', FAKE_NO_REPORT: '1' } }), /no JSON report/);
});

test('verify: every planned e2e scenario needs a passing test', (t) => {
  const { repo } = setup(t);
  repo.setStage('verify');
  fails(repo.run(['done', 'verify'], { env: { FAKE_STATUS: 'expected', FAKE_TITLE: 'PRD-9.9 other' } }),
    /no passing test for planned scenario PRD-1\.1/);
});

test('verify: flaky passes and is reported in the summary', (t) => {
  const { repo, id } = setup(t);
  repo.setStage('verify');
  assert.equal(repo.run(['done', 'verify'], { env: { FAKE_STATUS: 'flaky' } }).status, 0);
  const summary = fs.readFileSync(path.join(repo.wfDir, 'runs', id, 'evidence', 'e2e-summary.md'), 'utf8');
  assert.match(summary, /\| PRD-1\.1, REQ-1 \| PRD-1\.1 REQ-1 greeting shows \| flaky \|/);
  assert.match(summary, /1 flaky/);
});

test('seed runs before e2e and a failed seed fails the tier', (t) => {
  const { repo } = setup(t);
  repo.setStage('verify');
  repo.config({ commands: { seed: 'exit 7' } });
  fails(repo.run(['done', 'verify'], { env: { FAKE_STATUS: 'expected' } }), /e2e tier: found exit 7/);
});

test('fixture run: suite is red, implementer turns it green, verify records it', (t) => {
  const { repo, id } = setup(t);
  repo.file('E2E/tests/greeting.spec.ts', 'spec');
  repo.setStage('tests');
  assert.equal(repo.run(['done', 'tests']).status, 0, 'red before implementation');
  repo.setStage('implement');
  fails(repo.run(['done', 'implement']), /e2e tier: found exit 1/);
  repo.file('src/greeting.js', 'module.exports = "hello";');
  assert.equal(repo.run(['done', 'implement']).status, 0, 'green after implementation');
  repo.setStage('verify');
  assert.equal(repo.run(['done', 'verify']).status, 0);
  assert.ok(fs.existsSync(path.join(repo.wfDir, 'runs', id, 'evidence', 'e2e-results.json')));
});

test('implement loop: failing ids come from the e2e report, so progress is not a plateau', (t) => {
  const { repo } = setup(t);
  repo.setStage('implement');
  const round = (specs) => repo.run(['guard', 'stop'], { input: '{}', env: { FAKE_SPECS: JSON.stringify(specs) } });
  const first = JSON.parse(round([['PRD-1.1 REQ-1 a', 'unexpected'], ['PRD-1.2 REQ-1 b', 'unexpected']]).stdout);
  assert.match(first.followup_message, /Failing ids: PRD-1\.1, PRD-1\.2, REQ-1$/);
  const second = JSON.parse(round([['PRD-1.1 REQ-1 a', 'expected'], ['PRD-1.2 REQ-1 b', 'unexpected']]).stdout);
  assert.match(second.followup_message, /Failing ids: PRD-1\.2, REQ-1$/);
  assert.deepEqual(repo.state().escalations, []);
});

test('tests stage: red because the app or browser never started is refused', (t) => {
  const { repo } = setup(t);
  repo.setStage('tests');
  for (const err of [
    'Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3100/',
    'Error: connect ECONNREFUSED 127.0.0.1:3100',
    "Error: browserType.launch: Executable doesn't exist at /ms-playwright/chromium",
    'Error: Timed out waiting 60000ms from config.webServer.',
  ]) {
    fails(repo.run(['done', 'tests'], { env: { FAKE_ERROR: err } }), /red for the right reason/);
  }
  assert.equal(repo.state().current.stage, 'tests');
});

test('planned e2e scenarios with no e2e command are refused, not skipped', (t) => {
  const { repo } = setup(t);
  repo.config({ commands: { e2e: '', unit: 'echo "FAILED PRD-1.1"; exit 1' } });
  repo.setStage('tests');
  fails(repo.run(['done', 'tests']), /ticket ACs plan automated product scenarios \(PRD-1\.1\) but commands\.e2e is empty/);
  repo.setStage('verify');
  fails(repo.run(['done', 'verify']), /commands\.e2e is empty/);
});

test('verify: automated ui and api product scenarios need a passing test too', (t) => {
  const { repo, id } = setup(t);
  const base = `specs/spec-${id}/tickets/be`;
  const mk = (file, tcs) => repo.file(`${base}/${file}`, `${JSON.stringify({
    ...VALID_TICKET_BE,
    id: file.replace('.json', ''),
    acceptance_criteria: [{ id: 'AC-1', text: 'x', test_cases: tcs }],
  }, null, 2)}\n`);
  mk('TKT-BE-001.json', [
    { id: 'PRD-1.1', title: 'e2e', given: 'a', when: 'b', then: 'c', layer: 'e2e', automation: 'automated' },
    { id: 'PRD-1.2', title: 'ui', given: 'a', when: 'b', then: 'c', layer: 'ui', automation: 'automated' },
    { id: 'PRD-1.3', title: 'api', given: 'a', when: 'b', then: 'c', layer: 'api', automation: 'automated' },
    { id: 'PRD-1.4', title: 'manual', given: 'a', when: 'b', then: 'c', layer: 'ui', automation: 'manual' },
  ]);
  repo.setStage('verify');
  const specs = (ids) => JSON.stringify(ids.map((p) => [`${p} REQ-1 test`, 'expected']));
  fails(repo.run(['done', 'verify'], { env: { FAKE_SPECS: specs(['PRD-1.1', 'PRD-1.2']) } }),
    /no passing test for planned scenario PRD-1\.3/);
  fails(repo.run(['done', 'verify'], { env: { FAKE_SPECS: specs(['PRD-1.1', 'PRD-1.3']) } }),
    /no passing test for planned scenario PRD-1\.2/);
  assert.equal(repo.run(['done', 'verify'], { env: { FAKE_SPECS: specs(['PRD-1.1', 'PRD-1.2', 'PRD-1.3']) } }).status, 0);
});

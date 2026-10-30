// Postconditions checked by `done <stage>`. Each returns a list of problems (see problems.mjs); an
// empty list means the stage passed.
import fs from 'node:fs';
import path from 'node:path';
import { git, loadConfig, readText } from './io.mjs';
import { PATHS, REPO_ROOT, posixRel, specDir } from './paths.mjs';
import { checkE2eCoverage, e2eNotConfigured, e2eSummary, readE2eReport } from './e2e.mjs';
import { problem } from './problems.mjs';
import { checkQuestions, checkTickets, srsSectionChecks } from './tickets.mjs';
import { ALL_TIERS, combinedOutput, e2eReportPath, runVerifyTiers } from './verify.mjs';

export function reqIds(specText) {
  const ids = new Set();
  const re = /\bREQ-(\d+)\b/g;
  let m;
  while ((m = re.exec(specText))) ids.add(`REQ-${m[1]}`);
  return [...ids];
}

export function capabilityBlock(text, id) {
  const idx = text.indexOf(id);
  if (idx < 0) return '';
  const rest = text.slice(idx);
  const next = rest.search(/\n(?=- \*\*REQ-|\n## )/);
  return next < 0 ? rest : rest.slice(0, next);
}

export function checkPlanning(state) {
  const text = readText(path.join(specDir(state), 'SRS.md'));
  return [
    ...srsSectionChecks(text),
    ...checkQuestions(state),
    ...checkTickets(state, text),
    ...checkResearch(state),
  ];
}

// research.md is optional. When present, every Sourced claim needs a URL.
export function checkResearch(state) {
  const text = readText(path.join(specDir(state), 'research.md'));
  if (text == null) return [];
  const problems = [];
  for (const group of ['Sourced', 'Inferred', 'Unknown']) {
    if (!new RegExp(`^#{1,4}\\s*\\**${group}\\b`, 'im').test(text)) {
      problems.push(problem(`research.md ${group} section`, 'no such heading', `a "${group}" heading`, `## ${group}`));
    }
  }
  const sourced = /^#{1,4}\s*\*{0,2}Sourced\b[^\n]*\n([\s\S]*?)(?=^#{1,4}\s|(?![\s\S]))/im.exec(text)?.[1] || '';
  const bare = sourced.split('\n').find((l) => /^\s*[-*]\s/.test(l) && !/https?:\/\//.test(l));
  if (bare) {
    problems.push(problem('research.md Sourced claims cite a URL', `no URL in "${bare.trim().slice(0, 60)}"`, 'an https:// link on every Sourced bullet', '- Retries cap at 3. https://docs.example.com/retries'));
  }
  return problems;
}

export function checkFeasibility(state) {
  const p = path.join(specDir(state), 'approach.md');
  const text = readText(p);
  if (!text) return [problem('approach.md exists', 'no file', posixRel(p), 'approach.md with a verdict and two approaches')];
  const problems = [];
  if (!/\b(as-is|with-changes|not-satisfiable)\b/i.test(text)) {
    problems.push(problem('approach verdict', 'no verdict', 'as-is, with-changes or not-satisfiable', 'Verdict: with-changes'));
  }
  // The decision-record sections are headings too, but they are not approaches.
  const approaches = (text.match(/^#{2,3}\s+.+/gm) || []).filter((h) => !/^#{2,3}\s+\W*(Decision|Non-functional|Risks|Rollback)\b/i.test(h));
  const named = (text.match(/\bapproach\s+[ABC1-3]\b/gi) || []).length;
  if (approaches.length < 2 && named < 2) {
    problems.push(problem('two approaches', `${Math.max(approaches.length, named)}`, 'at least 2 approaches', '### Approach A: extend the existing service'));
  }
  if (!/one commit|single-commit|split/i.test(text)) {
    problems.push(problem('single-commit fit line', 'no such line', 'a line saying the change fits one commit, or how it splits', 'Fits one commit: yes'));
  }
  for (const part of ['Decision', 'Non-functional', 'Risks', 'Rollback']) {
    if (!new RegExp(`^\\s*(#{1,4}\\s*)?\\*{0,2}${part}\\b`, 'im').test(text)) {
      problems.push(problem(`${part} section`, 'no such heading', `a "${part}" heading`, `## ${part}`));
    }
  }
  return problems;
}

// Failures that say nothing about the missing behaviour: the app or the browser never ran.
const WRONG_RED = /ERR_CONNECTION_REFUSED|ECONNREFUSED|Executable doesn't exist|browserType\.launch|from config\.webServer/;

// Product tests are red when the e2e command is set; otherwise fall back to the unit tier.
export function checkTestsToImplement(state) {
  const cfg = loadConfig();
  const missing = e2eNotConfigured(state, cfg);
  if (missing) return [problem('e2e command configured', missing, 'commands.e2e in config.json', 'npx playwright test --reporter=list,json')];
  const tier = String(cfg.commands?.e2e || '').trim() ? 'e2e' : 'unit';
  const results = runVerifyTiers([tier]);
  const failed = results.filter((r) => !r.skipped && r.code !== 0);
  if (!failed.length) return [problem('new tests are red', `the ${tier} tier exited 0`, `the ${tier} tier to fail`, 'expect(login()).toBe(true) // REQ-1 fails')];
  const out = combinedOutput(failed);
  if (!/\b(REQ-\d+|TECH-[\w-]+|PRD-\d+\.\d+)\b/.test(out)) {
    return [problem('failures cite ids', 'a failure with no REQ, TECH or PRD id', 'failing tests that cite REQ / TECH / PRD ids', 'PRD-1.1 REQ-1 login returns 200')];
  }
  const wrong = WRONG_RED.exec(out);
  if (wrong) return [problem('red for the right reason', `${wrong[0]}: the app or browser did not start`, 'a failure about the missing behaviour', 'expected 200, received 404')];
  return [];
}

export function checkImplementToReview() {
  const results = runVerifyTiers(['unit', 'lint', 'typecheck', 'e2e']);
  const failed = results.find((r) => !r.skipped && r.code !== 0);
  if (failed) return [problem(`${failed.tier} tier`, `exit ${failed.code}`, 'exit 0', `npm run ${failed.tier}`)];
  return [];
}

// One bullet per finding (standards.md "Review finding format"). A finding is judged on its
// own line: only an open `high` blocks; `decision-needed` goes to gate_review for the human.
const HIGH_FINDING = /^\s*[-*]\s*(?:\[\s*high\s*\]|\*{0,2}high\*{0,2}\s*[:—-])/i;
const RESOLVED = /\[\s*resolved\s*\]/i;

const AXES = ['Standards', 'Spec conformance', 'Approach conformance', 'Test quality'];
const TAGGED = /^\s*[-*]\s*(\[\s*(low|medium|high|decision-needed)\s*\]|\*{0,2}(low|medium|high|decision-needed)\*{0,2}\s*[:—-])/i;

export function checkReviewToVerify(resultPath) {
  const text = readText(resultPath);
  if (text == null) return [problem('review output exists', `no file at ${resultPath}`, 'the code-reviewer output path', 'review.md')];
  const problems = [];
  for (const axis of AXES) {
    if (!new RegExp(`^#{1,4}\\s*\\**${axis}\\b`, 'im').test(text)) {
      problems.push(problem(`review section ${axis}`, 'no such heading', `a "${axis}" heading`, `## ${axis}`));
    }
  }
  const untagged = text.split('\n').find((l) => /^\s*[-*]\s/.test(l) && !TAGGED.test(l) && !/open:\s*0/i.test(l));
  if (untagged) {
    problems.push(problem('review finding severity', `"${untagged.trim().slice(0, 60)}"`, 'a severity tag first: low, medium, high or decision-needed', '- [medium] Handler ignores timeouts'));
  }
  const open = text.split('\n').filter((l) => HIGH_FINDING.test(l) && !RESOLVED.test(l));
  if (open.length) {
    problems.push(problem('no open high findings', `${open.length} open: ${open[0].trim().slice(0, 80)}`, 'every high finding resolved', '- [high] SQL injection in search [resolved]'));
  }
  return problems;
}

// The tier results of the last verify check, so `done verify` can record them for the PR body.
export const lastVerify = { tiers: [] };

export function checkVerifyToGate(state, resultPath) {
  const missing = e2eNotConfigured(state, loadConfig());
  if (missing) return [problem('e2e command configured', missing, 'commands.e2e in config.json', 'npx playwright test --reporter=list,json')];
  const results = runVerifyTiers(ALL_TIERS);
  lastVerify.tiers = results.map(({ tier, skipped, code }) => ({ tier, skipped, code }));
  const failed = results.find((r) => !r.skipped && r.code !== 0);
  if (failed) return [problem(`${failed.tier} tier`, `exit ${failed.code}`, 'exit 0', `npm run ${failed.tier}`)];
  if (!results.find((r) => r.tier === 'e2e').skipped) {
    const tests = readE2eReport(e2eReportPath());
    const err = checkE2eCoverage(state, tests);
    if (err) return [problem('e2e covers every automated scenario', err, 'a passing test for each PRD-n.m scenario', 'PRD-1.1 REQ-1 ...')];
    fs.writeFileSync(path.join(PATHS.runs, state.run.id, 'evidence', 'e2e-summary.md'), e2eSummary(tests));
  }
  const evidence = resultPath
    ? (path.isAbsolute(resultPath) ? resultPath : path.join(REPO_ROOT, resultPath))
    : path.join(PATHS.runs, state.run.id, 'evidence');
  if (!fs.existsSync(evidence)) return [problem('evidence bundle exists', `no ${posixRel(evidence)}`, 'the evidence directory', `.agent-workflow/runs/${state.run.id}/evidence/`)];
  if (fs.statSync(evidence).isDirectory() && !fs.readdirSync(evidence).length) {
    return [problem('evidence bundle has files', 'an empty directory', 'at least one evidence file', 'evidence/tiers.md')];
  }
  return [];
}

export function commitsSince(baseline) {
  const res = git(['rev-list', '--count', `${baseline}..HEAD`]);
  if (res.status !== 0) return -1;
  return parseInt((res.stdout || '0').trim(), 10);
}

export const PR_URL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/;

export function checkPrToDone(state, resultPath) {
  const problems = [];
  if (!PR_URL.test(resultPath || '')) {
    problems.push(problem('pr result is the PR URL', `${resultPath || 'nothing'}`, 'https://github.com/<owner>/<repo>/pull/<n>', 'https://github.com/acme/app/pull/12'));
  }
  const n = commitsSince(state.run.baseline_sha);
  if (n < 1) problems.push(problem('at least one commit', `${n} since ${state.run.baseline_sha}`, 'at least 1 commit on the run branch', 'git commit -m "..."'));
  return problems;
}

// Stages that have a postcondition; the list is the same order as the workflow.
export function postcondition(fromStage, state, resultPath) {
  switch (fromStage) {
    case 'planning':
      return checkPlanning(state);
    case 'feasibility':
      return checkFeasibility(state);
    case 'tests':
      return checkTestsToImplement(state);
    case 'implement':
      return checkImplementToReview();
    case 'review':
      return checkReviewToVerify(resultPath);
    case 'verify':
      return checkVerifyToGate(state, resultPath);
    case 'pr':
      return checkPrToDone(state, resultPath);
    default:
      return [problem('postcondition', `no check for ${fromStage}`, 'a stage with a postcondition', 'planning')];
  }
}

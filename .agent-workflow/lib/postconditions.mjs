// Postconditions checked by `done <stage>`. Each returns null when satisfied, else a message.
import fs from 'node:fs';
import path from 'node:path';
import { git, loadConfig, readText } from './io.mjs';
import { PATHS, REPO_ROOT, posixRel, specDir } from './paths.mjs';
import { checkE2eCoverage, e2eNotConfigured, e2eSummary, readE2eReport } from './e2e.mjs';
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
  const srsPath = path.join(specDir(state), 'SRS.md');
  const text = readText(srsPath);
  const sectionProblems = srsSectionChecks(text);
  if (sectionProblems.length) {
    const first = sectionProblems[0];
    if (first === 'missing SRS.md') return `missing ${posixRel(srsPath)}`;
    return first;
  }
  const qProblems = checkQuestions(state);
  if (qProblems.length) return qProblems[0];
  const tProblems = checkTickets(state, text);
  if (tProblems.length) return tProblems[0];
  return checkResearch(state);
}

// research.md is optional. When present, every Sourced claim needs a URL.
export function checkResearch(state) {
  const text = readText(path.join(specDir(state), 'research.md'));
  if (text == null) return null;
  for (const group of ['Sourced', 'Inferred', 'Unknown']) {
    if (!new RegExp(`^#{1,4}\\s*\\**${group}\\b`, 'im').test(text)) return `research.md needs a ${group} section`;
  }
  const sourced = /^#{1,4}\s*\*{0,2}Sourced\b[^\n]*\n([\s\S]*?)(?=^#{1,4}\s|(?![\s\S]))/im.exec(text)?.[1] || '';
  const bare = sourced.split('\n').find((l) => /^\s*[-*]\s/.test(l) && !/https?:\/\//.test(l));
  return bare ? `research.md Sourced claim has no URL: ${bare.trim().slice(0, 60)}` : null;
}

export function checkFeasibility(state) {
  const p = path.join(specDir(state), 'approach.md');
  const text = readText(p);
  if (!text) return `missing ${posixRel(p)}`;
  if (!/\b(as-is|with-changes|not-satisfiable)\b/i.test(text)) {
    return 'approach.md needs a verdict: as-is / with-changes / not-satisfiable';
  }
  // The decision-record sections are headings too, but they are not approaches.
  const approaches = (text.match(/^#{2,3}\s+.+/gm) || []).filter((h) => !/^#{2,3}\s+\W*(Decision|Non-functional|Risks|Rollback)\b/i.test(h));
  const named = (text.match(/\bapproach\s+[ABC1-3]\b/gi) || []).length;
  if (approaches.length < 2 && named < 2) return 'approach.md needs at least 2 approaches';
  if (!/one commit|single-commit|split/i.test(text)) {
    return 'approach.md needs a single-commit-fit line';
  }
  for (const part of ['Decision', 'Non-functional', 'Risks', 'Rollback']) {
    if (!new RegExp(`^\\s*(#{1,4}\\s*)?\\*{0,2}${part}\\b`, 'im').test(text)) return `approach.md needs a ${part} section`;
  }
  return null;
}

// Failures that say nothing about the missing behaviour: the app or the browser never ran.
const WRONG_RED = /ERR_CONNECTION_REFUSED|ECONNREFUSED|Executable doesn't exist|browserType\.launch|from config\.webServer/;

// Product tests are red when the e2e command is set; otherwise fall back to the unit tier.
export function checkTestsToImplement(state) {
  const cfg = loadConfig();
  const missing = e2eNotConfigured(state, cfg);
  if (missing) return missing;
  const tier = String(cfg.commands?.e2e || '').trim() ? 'e2e' : 'unit';
  const results = runVerifyTiers([tier]);
  const failed = results.filter((r) => !r.skipped && r.code !== 0);
  if (!failed.length) return `new tests must fail (the ${tier} tier exited 0)`;
  const out = combinedOutput(failed);
  if (!/\b(REQ-\d+|TECH-[\w-]+|PRD-\d+\.\d+)\b/.test(out)) {
    return 'failing tests must cite REQ / TECH / PRD ids (not an unrelated crash)';
  }
  const wrong = WRONG_RED.exec(out);
  if (wrong) return `tests are red for the wrong reason (${wrong[0]}): the app or browser did not start`;
  return null;
}

export function checkImplementToReview() {
  const results = runVerifyTiers(['unit', 'lint', 'typecheck', 'e2e']);
  const failed = results.find((r) => !r.skipped && r.code !== 0);
  if (failed) return `${failed.tier} failed (exit ${failed.code})`;
  return null;
}

// One bullet per finding (standards.md "Review finding format"). A finding is judged on its
// own line: only an open `high` blocks; `decision-needed` goes to gate_review for the human.
const HIGH_FINDING = /^\s*[-*]\s*(?:\[\s*high\s*\]|\*{0,2}high\*{0,2}\s*[:\u2014-])/i;
const RESOLVED = /\[\s*resolved\s*\]/i;

const AXES = ['Standards', 'Spec conformance', 'Approach conformance', 'Test quality'];
const TAGGED = /^\s*[-*]\s*(\[\s*(low|medium|high|decision-needed)\s*\]|\*{0,2}(low|medium|high|decision-needed)\*{0,2}\s*[:\u2014-])/i;

export function checkReviewToVerify(resultPath) {
  const text = readText(resultPath);
  if (text == null) return `missing review output: ${resultPath}`;
  for (const axis of AXES) {
    if (!new RegExp(`^#{1,4}\\s*\\**${axis}\\b`, 'im').test(text)) return `review.md needs a section for ${axis}`;
  }
  const untagged = text.split('\n').find((l) => /^\s*[-*]\s/.test(l) && !TAGGED.test(l) && !/open:\s*0/i.test(l));
  if (untagged) return `review finding has no severity tag: ${untagged.trim().slice(0, 60)}`;
  const open = text.split('\n').filter((l) => HIGH_FINDING.test(l) && !RESOLVED.test(l));
  if (open.length) return `review still has open high findings (${open.length}): ${open[0].trim().slice(0, 80)}`;
  return null;
}

// The tier results of the last verify check, so `done verify` can record them for the PR body.
export const lastVerify = { tiers: [] };

export function checkVerifyToGate(state, resultPath) {
  const missing = e2eNotConfigured(state, loadConfig());
  if (missing) return missing;
  const results = runVerifyTiers(ALL_TIERS);
  lastVerify.tiers = results.map(({ tier, skipped, code }) => ({ tier, skipped, code }));
  const failed = results.find((r) => !r.skipped && r.code !== 0);
  if (failed) return `${failed.tier} failed (exit ${failed.code})`;
  if (!results.find((r) => r.tier === 'e2e').skipped) {
    const tests = readE2eReport(e2eReportPath());
    const err = checkE2eCoverage(state, tests);
    if (err) return err;
    fs.writeFileSync(path.join(PATHS.runs, state.run.id, 'evidence', 'e2e-summary.md'), e2eSummary(tests));
  }
  const evidence = resultPath
    ? (path.isAbsolute(resultPath) ? resultPath : path.join(REPO_ROOT, resultPath))
    : path.join(PATHS.runs, state.run.id, 'evidence');
  if (!fs.existsSync(evidence)) return `missing evidence bundle: ${evidence}`;
  const stat = fs.statSync(evidence);
  if (stat.isDirectory()) {
    const files = fs.readdirSync(evidence);
    if (!files.length) return 'evidence directory is empty';
  }
  return null;
}

export function commitsSince(baseline) {
  const res = git(['rev-list', '--count', `${baseline}..HEAD`]);
  if (res.status !== 0) return -1;
  return parseInt((res.stdout || '0').trim(), 10);
}

export const PR_URL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/;

export function checkPrToDone(state, resultPath) {
  if (!PR_URL.test(resultPath || '')) {
    return 'pr result must be the GitHub PR URL (https://github.com/<owner>/<repo>/pull/<n>)';
  }
  const n = commitsSince(state.run.baseline_sha);
  if (n < 1) return `expected at least 1 commit since ${state.run.baseline_sha}, found ${n}`;
  return null;
}

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
      return `no postcondition for ${fromStage}`;
  }
}

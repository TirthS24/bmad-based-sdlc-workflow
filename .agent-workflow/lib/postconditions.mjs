// Postconditions checked by `done <stage>`. Each returns null when satisfied, else a message.
import fs from 'node:fs';
import path from 'node:path';
import { git, readText } from './io.mjs';
import { PATHS, REPO_ROOT, posixRel, specDir } from './paths.mjs';
import { combinedOutput, runVerifyTiers } from './verify.mjs';

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

export function checkGrillSpec(state) {
  const specPath = path.join(specDir(state), 'SPEC.md');
  const text = readText(specPath);
  if (!text) return `missing ${posixRel(specPath)}`;
  if (/\[OPEN QUESTION\]/i.test(text)) return 'SPEC.md still contains [OPEN QUESTION] markers';
  const ids = reqIds(text);
  if (!ids.length) return 'SPEC.md has no numbered REQ-n IDs';
  for (const id of ids) {
    const block = capabilityBlock(text, id);
    if (!block || !/\*\*success:\*\*|success:/i.test(block)) {
      return `${id} is missing a success condition`;
    }
  }
  return null;
}

export function checkFeasibility(state) {
  const p = path.join(specDir(state), 'approach.md');
  const text = readText(p);
  if (!text) return `missing ${posixRel(p)}`;
  if (!/\b(as-is|with-changes|not-satisfiable)\b/i.test(text)) {
    return 'approach.md needs a verdict: as-is / with-changes / not-satisfiable';
  }
  const approaches = text.match(/^#{2,3}\s+.+/gm) || [];
  const named = (text.match(/\bapproach\s+[ABC1-3]\b/gi) || []).length;
  if (approaches.length < 2 && named < 2) return 'approach.md needs at least 2 approaches';
  if (!/one commit|single-commit|split/i.test(text)) {
    return 'approach.md needs a single-commit-fit line';
  }
  return null;
}

export function checkTestPlan(state) {
  const spec = readText(path.join(specDir(state), 'SPEC.md'));
  const plan = readText(path.join(specDir(state), 'test-plan.md'));
  if (!spec) return 'missing SPEC.md';
  if (!plan) return 'missing test-plan.md';
  const ids = reqIds(spec);
  for (const id of ids) {
    if (!plan.includes(id)) return `test-plan.md has no scenario for ${id}`;
  }
  const scenarioLines = plan.split('\n').filter((l) => /\b(PRD-\d+\.\d+|TECH-[\w-]+)\b/.test(l));
  if (!scenarioLines.length) return 'test-plan.md has no PRD-n.m or TECH-* scenarios';
  for (const line of scenarioLines) {
    if (!/\b(unit|integration|e2e|api|ui|manual)\b/i.test(line)) {
      return `scenario missing layer: ${line.trim().slice(0, 80)}`;
    }
    if (!/\b(automated|manual|n\/a)\b/i.test(line)) {
      return `scenario missing automated/manual/N/A tag: ${line.trim().slice(0, 80)}`;
    }
  }
  return null;
}

export function checkTestsToImplement() {
  const results = runVerifyTiers(['unit']);
  const failed = results.filter((r) => !r.skipped && r.code !== 0);
  if (!failed.length) return 'new tests must fail (wf verify unit exited 0)';
  const out = combinedOutput(failed);
  if (!/\b(REQ-\d+|TECH-[\w-]+|PRD-\d+\.\d+)\b/.test(out)) {
    return 'failing tests must cite REQ / TECH / PRD ids (not an unrelated crash)';
  }
  return null;
}

export function checkImplementToReview() {
  const results = runVerifyTiers(['unit', 'lint']);
  const failed = results.find((r) => !r.skipped && r.code !== 0);
  if (failed) return `${failed.tier} failed (exit ${failed.code})`;
  return null;
}

export function checkReviewToVerify(resultPath) {
  const text = readText(resultPath);
  if (text == null) return `missing review output: ${resultPath}`;
  if (/\b(high|decision-needed)\b/i.test(text) && !/open:\s*0|no findings tagged/i.test(text)) {
    const openHigh = /(^|\n)\s*[-*].*\b(high|decision-needed)\b/i.test(text);
    if (openHigh && !/resolved|fixed|closed/i.test(text)) {
      return 'review still has open high / decision-needed findings';
    }
  }
  return null;
}

export function checkVerifyToGate2(state, resultPath) {
  const results = runVerifyTiers(['unit', 'lint', 'complexity', 'e2e', 'a11y']);
  const failed = results.find((r) => !r.skipped && r.code !== 0);
  if (failed) return `${failed.tier} failed (exit ${failed.code})`;
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

export function checkPrToDone(state) {
  const n = commitsSince(state.run.baseline_sha);
  if (n !== 1) return `expected exactly 1 commit since ${state.run.baseline_sha}, found ${n}`;
  return null;
}

export function postcondition(fromStage, state, resultPath) {
  switch (fromStage) {
    case 'grill_spec':
      return checkGrillSpec(state);
    case 'feasibility':
      return checkFeasibility(state);
    case 'test_plan':
      return checkTestPlan(state);
    case 'tests':
      return checkTestsToImplement();
    case 'implement':
      return checkImplementToReview();
    case 'review':
      return checkReviewToVerify(resultPath);
    case 'verify':
      return checkVerifyToGate2(state, resultPath);
    case 'pr':
      return checkPrToDone(state);
    default:
      return `no postcondition for ${fromStage}`;
  }
}

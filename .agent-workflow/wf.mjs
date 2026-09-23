#!/usr/bin/env node
/**
 * Deterministic workflow state machine. Agents call commands; they do not
 * edit state.json. Postconditions are functions, not model memory.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const WF_DIR = path.resolve(process.env.WF_DIR || THIS_DIR);
const REPO_ROOT = path.resolve(process.env.REPO_ROOT || path.dirname(WF_DIR));

const PATHS = {
  workflow: path.join(WF_DIR, 'workflow.json'),
  config: path.join(WF_DIR, 'config.json'),
  state: path.join(WF_DIR, 'state.json'),
  events: path.join(WF_DIR, 'events.jsonl'),
  allowlist: path.join(WF_DIR, 'bmad-allowlist.json'),
  runs: path.join(WF_DIR, 'runs'),
};

const NEXT_ACTION = {
  grill_spec: 'Run /wf-start. Grill one question at a time. Write specs/spec-<id>/SPEC.md via bmad-spec using REQ-n ids. Then: node .agent-workflow/wf.mjs done grill_spec --result specs/spec-<id>/SPEC.md',
  feasibility: 'Run /wf-feasibility (dispatches feasibility-analyst). Write approach.md. Then: node .agent-workflow/wf.mjs done feasibility --result specs/spec-<id>/approach.md',
  test_plan: 'Run /wf-test-plan (test-architect plan mode). Write test-plan.md. Then: node .agent-workflow/wf.mjs done test_plan --result specs/spec-<id>/test-plan.md',
  gate1: 'Human: choose approach A|B|C, then /wf-approve-spec',
  tests: 'Run /wf-tests (test-architect atdd). Then: node .agent-workflow/wf.mjs done tests --result <test path or dir>',
  implement: 'Run /wf-implement (one attempt). The stop hook re-submits until green or the cap.',
  review: 'Run /wf-review on the main thread with spec and baseline supplied. Then: node .agent-workflow/wf.mjs done review --result <review output path>',
  verify: 'Run /wf-verify. Then: node .agent-workflow/wf.mjs done verify --result .agent-workflow/runs/<id>/evidence/',
  gate2: 'Human: /wf-approve-manual after reading the evidence bundle',
  pr: 'Run /wf-pr: one commit (husky Change-Id), then git push gerrit HEAD:refs/for/<branch>. Then: node .agent-workflow/wf.mjs done pr --result <commit-sha>',
  done: 'Run complete. No further pipeline action.',
};

function die(msg, code = 1) {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
}

function loadWorkflow() {
  const wf = readJson(PATHS.workflow);
  if (!wf?.stages) die(`missing workflow: ${PATHS.workflow}`);
  return wf;
}

function loadConfig() {
  const cfg = readJson(PATHS.config);
  if (!cfg) die(`missing config: ${PATHS.config}`);
  return cfg;
}

function loadState() {
  return readJson(PATHS.state, null);
}

function saveState(state) {
  writeJson(PATHS.state, state);
}

function appendEvent(type, extra = {}) {
  fs.mkdirSync(path.dirname(PATHS.events), { recursive: true });
  const line = JSON.stringify({ ts: new Date().toISOString(), type, ...extra });
  fs.appendFileSync(PATHS.events, `${line}\n`);
}

function stageById(workflow, id) {
  return workflow.stages.find((s) => s.id === id);
}

function specDir(state) {
  return path.join(REPO_ROOT, 'specs', `spec-${state.run.id}`);
}

function sha256Bytes(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256File(file) {
  return sha256Bytes(fs.readFileSync(file));
}

function posixRel(file) {
  return path.relative(REPO_ROOT, path.resolve(REPO_ROOT, file)).split(path.sep).join('/');
}

function globToRegExp(glob) {
  const g = glob.replace(/\\/g, '/');
  let out = '';
  for (let i = 0; i < g.length; i += 1) {
    if (g.startsWith('**/', i)) {
      out += '(?:.*/)?';
      i += 2;
      continue;
    }
    if (g.startsWith('**', i)) {
      out += '.*';
      i += 1;
      continue;
    }
    if (g[i] === '*') {
      out += '[^/]*';
      continue;
    }
    if (/[.+^${}()|[\]\\]/.test(g[i])) out += `\\${g[i]}`;
    else out += g[i];
  }
  return new RegExp(`^${out}$`);
}

function expandWritePatterns(patterns, config) {
  const out = [];
  for (const p of patterns) {
    if (p === '<test_globs>' || p === '!<test_globs>') {
      const neg = p.startsWith('!');
      for (const g of config.test_globs || []) out.push(neg ? `!${g}` : g);
    } else {
      out.push(p);
    }
  }
  return out;
}

function matchesGlob(rel, glob) {
  const r = rel.replace(/^\.\//, '');
  const re = globToRegExp(glob);
  if (re.test(r)) return true;
  if (glob.endsWith('/**') && (r === glob.slice(0, -3) || r.startsWith(glob.slice(0, -2)))) {
    return true;
  }
  return false;
}

function writesAllowed(rel, allowPatterns) {
  let allowed = false;
  for (const p of allowPatterns) {
    const negated = p.startsWith('!');
    const g = negated ? p.slice(1) : p;
    if (matchesGlob(rel, g)) allowed = !negated;
  }
  return allowed;
}

function matchesAnyGlob(rel, globs) {
  return (globs || []).some((g) => matchesGlob(rel, g));
}

function git(args, opts = {}) {
  return spawnSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    ...opts,
  });
}

function emptyState(run) {
  return {
    schema: 1,
    run,
    current: { stage: 'grill_spec', next_action: fillAction('grill_spec', run.id), attempt: 1 },
    gates: {
      gate1: {
        status: 'pending',
        approach: null,
        spec_hash: null,
        approach_hash: null,
        test_plan_hash: null,
      },
      gate2: { status: 'pending' },
    },
    stages: {},
    loops: {
      implement: { round: 0, last_failing: [] },
      review: { round: 0 },
      verify_fix: { round: 0 },
    },
    escalations: [],
    freeze: { test_files_hash: null },
    deferred: [],
  };
}

function fillAction(stage, runId) {
  return (NEXT_ACTION[stage] || '').replaceAll('<id>', runId);
}

function formatStatus(state, { hook = false } = {}) {
  if (!state || !state.run?.id) {
    const text = 'No active workflow run. For a new feature or bug fix, start one: /wf-run <ticket-id-or-description>';
    return hook ? { additional_context: text } : text;
  }
  const g1 = state.gates.gate1.status;
  const g2 = state.gates.gate2.status;
  const loop = state.current.stage === 'implement'
    ? state.loops.implement.round
    : state.current.stage === 'review'
      ? state.loops.review.round
      : state.loops.verify_fix.round;
  const lines = [
    `run: ${state.run.id}`,
    `branch: ${state.run.branch}`,
    `stage: ${state.current.stage}`,
    `attempt: ${state.current.attempt}`,
    `gate1: ${g1}${state.gates.gate1.approach ? ` (${state.gates.gate1.approach})` : ''}`,
    `gate2: ${g2}`,
    `loop: ${loop}`,
    `writes: ${writeHint(state)}`,
    `next_action: ${state.current.next_action}`,
  ];
  const text = lines.join('\n');
  if (hook) return { additional_context: text };
  return text;
}

function writeHint(state) {
  const wf = loadWorkflow();
  const cfg = loadConfig();
  const stg = stageById(wf, state.current.stage);
  const patterns = expandWritePatterns(stg?.writes || [], cfg);
  const allow = patterns.filter((p) => !p.startsWith('!')).join(', ') || '(none)';
  const block = patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1)).join(', ');
  const frozen = state.current.stage === 'implement' || state.current.stage === 'review' ? ' frozen-tests' : '';
  return `allowed: ${allow} / blocked: ${block || 'protected'}${frozen}`;
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function parseHookPayload(raw) {
  const text = (raw || '').trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}

function extractFilePath(payload) {
  const input = payload.tool_input || payload.toolInput || payload.input || {};
  const candidates = [
    payload.file_path,
    payload.filePath,
    payload.path,
    input.path,
    input.file_path,
    input.filePath,
    Array.isArray(input.file_path) ? input.file_path[0] : null,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c) return c;
  }
  return null;
}

function extractCommand(payload) {
  const input = payload.tool_input || payload.toolInput || payload.input || {};
  return payload.command || payload.command_line || input.command || '';
}

function extractToolName(payload) {
  return payload.tool_name || payload.toolName || payload.tool || '';
}

function deny(message) {
  const body = {
    permission: 'deny',
    user_message: message,
    agent_message: message,
  };
  process.stdout.write(`${JSON.stringify(body)}\n`);
  process.exit(2);
}

function allow(extra = {}) {
  process.stdout.write(`${JSON.stringify({ permission: 'allow', ...extra })}\n`);
  process.exit(0);
}

function collectTestFiles(config) {
  const files = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === '.next') continue;
      if (ent.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(REPO_ROOT);
  return files
    .map((f) => posixRel(f))
    .filter((rel) => matchesAnyGlob(rel, config.test_globs))
    .sort();
}

function freezeHash(config) {
  const files = collectTestFiles(config);
  const h = crypto.createHash('sha256');
  for (const rel of files) {
    const full = path.join(REPO_ROOT, rel);
    h.update(rel);
    h.update('\0');
    h.update(fs.readFileSync(full));
    h.update('\0');
  }
  return h.digest('hex');
}

function readText(relOrAbs) {
  const full = path.isAbsolute(relOrAbs) ? relOrAbs : path.join(REPO_ROOT, relOrAbs);
  if (!fs.existsSync(full)) return null;
  return fs.readFileSync(full, 'utf8');
}

function reqIds(specText) {
  const ids = new Set();
  const re = /\bREQ-(\d+)\b/g;
  let m;
  while ((m = re.exec(specText))) ids.add(`REQ-${m[1]}`);
  return [...ids];
}

function checkGrillSpec(state) {
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

function capabilityBlock(text, id) {
  const idx = text.indexOf(id);
  if (idx < 0) return '';
  const rest = text.slice(idx);
  const next = rest.search(/\n(?=- \*\*REQ-|\n## )/);
  return next < 0 ? rest : rest.slice(0, next);
}

function checkFeasibility(state) {
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

function checkTestPlan(state) {
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

function runVerifyTiers(tiers) {
  const cfg = loadConfig();
  const results = [];
  for (const tier of tiers) {
    const cmd = (cfg.commands || {})[tier];
    if (!cmd || !String(cmd).trim()) {
      results.push({ tier, skipped: true, code: 0, stdout: '', stderr: '' });
      continue;
    }
    const res = spawnSync(cmd, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      shell: true,
      env: process.env,
    });
    results.push({
      tier,
      skipped: false,
      code: res.status ?? 1,
      stdout: res.stdout || '',
      stderr: res.stderr || '',
    });
  }
  return results;
}

function combinedOutput(results) {
  return results.map((r) => `${r.stdout}\n${r.stderr}`).join('\n');
}

function checkTestsToImplement() {
  const results = runVerifyTiers(['unit']);
  const failed = results.filter((r) => !r.skipped && r.code !== 0);
  if (!failed.length) return 'new tests must fail (wf verify unit exited 0)';
  const out = combinedOutput(failed);
  if (!/\b(REQ-\d+|TECH-[\w-]+|PRD-\d+\.\d+)\b/.test(out)) {
    return 'failing tests must cite REQ / TECH / PRD ids (not an unrelated crash)';
  }
  return null;
}

function checkImplementToReview() {
  const results = runVerifyTiers(['unit', 'lint']);
  const failed = results.find((r) => !r.skipped && r.code !== 0);
  if (failed) return `${failed.tier} failed (exit ${failed.code})`;
  return null;
}

function checkReviewToVerify(resultPath) {
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

function checkVerifyToGate2(state, resultPath) {
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

function commitsSince(baseline) {
  const res = git(['rev-list', '--count', `${baseline}..HEAD`]);
  if (res.status !== 0) return -1;
  return parseInt((res.stdout || '0').trim(), 10);
}

function checkPrToDone(state) {
  const n = commitsSince(state.run.baseline_sha);
  if (n !== 1) return `expected exactly 1 commit since ${state.run.baseline_sha}, found ${n}`;
  return null;
}

function postcondition(fromStage, state, resultPath) {
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

function cmdRun(source) {
  if (loadState()?.run?.id) {
    die('a run is already active; /wf-abort or /wf-pause first');
  }
  const slug = String(source || 'adhoc')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'adhoc';
  const id = `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${slug}`;
  const head = git(['rev-parse', 'HEAD']);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const run = {
    id,
    source: String(source || ''),
    baseline_sha: (head.stdout || '').trim(),
    branch: (branch.stdout || '').trim(),
    started_at: new Date().toISOString(),
  };
  fs.mkdirSync(specDir({ run }), { recursive: true });
  fs.mkdirSync(path.join(PATHS.runs, id), { recursive: true });
  const state = emptyState(run);
  saveState(state);
  appendEvent('run', { id, source: run.source });
  process.stdout.write(`${formatStatus(state)}\n`);
}

function cmdStatus(flags) {
  const state = loadState();
  if (flags.check) {
    if (!state?.run?.id) process.exit(0);
    const cfg = loadConfig();
    const stg = state.current.stage;
    if (stg === 'implement' && state.loops.implement.round >= (cfg.loop_caps.implement || 5)) {
      process.stderr.write('implement loop cap hit\n');
      process.exit(1);
    }
    if (state.escalations?.length) {
      process.stderr.write('escalation pending\n');
      process.exit(1);
    }
    process.exit(0);
  }
  if (flags.hook) {
    process.stdout.write(`${JSON.stringify(formatStatus(state, { hook: true }))}\n`);
    return;
  }
  process.stdout.write(`${formatStatus(state)}\n`);
}

function cmdDone(stage, resultPath) {
  const workflow = loadWorkflow();
  const state = loadState();
  if (!state?.run?.id) die('no active run');
  if (state.current.stage !== stage) {
    die(`current stage is ${state.current.stage}, not ${stage}`);
  }
  const stg = stageById(workflow, stage);
  if (!stg) die(`unknown stage ${stage}`);
  if (stg.executor === 'human') die('human gates use wf approve, not wf done');
  const err = postcondition(stage, state, resultPath);
  if (err) die(`postcondition failed: ${err}`);
  if (stage === 'tests') {
    state.freeze.test_files_hash = freezeHash(loadConfig());
  }
  state.stages[stage] = {
    status: 'done',
    result: resultPath || null,
    finished_at: new Date().toISOString(),
  };
  const next = stg.next;
  state.current.stage = next;
  state.current.attempt = 1;
  state.current.next_action = fillAction(next, state.run.id);
  saveState(state);
  appendEvent('done', { stage, next, result: resultPath || null });
  process.stdout.write(`${formatStatus(state)}\n`);
}

function fileHashIfExists(rel) {
  const full = path.join(REPO_ROOT, rel);
  if (!fs.existsSync(full)) return null;
  return sha256File(full);
}

function cmdApprove(gate, approach) {
  const state = loadState();
  if (!state?.run?.id) die('no active run');
  const workflow = loadWorkflow();
  if (gate === 'gate1') {
    if (state.current.stage !== 'gate1') die(`current stage is ${state.current.stage}, not gate1`);
    if (!['A', 'B', 'C'].includes(approach)) die('gate1 requires --approach A|B|C');
    const dir = `specs/spec-${state.run.id}`;
    state.gates.gate1 = {
      status: 'approved',
      approach,
      spec_hash: fileHashIfExists(`${dir}/SPEC.md`),
      approach_hash: fileHashIfExists(`${dir}/approach.md`),
      test_plan_hash: fileHashIfExists(`${dir}/test-plan.md`),
    };
    const next = stageById(workflow, 'gate1').next;
    state.current.stage = next;
    state.current.next_action = fillAction(next, state.run.id);
    saveState(state);
    appendEvent('approve', { gate: 'gate1', approach });
    process.stdout.write(`${formatStatus(state)}\n`);
    return;
  }
  if (gate === 'gate2') {
    if (state.current.stage !== 'gate2') die(`current stage is ${state.current.stage}, not gate2`);
    state.gates.gate2 = { status: 'approved' };
    const next = stageById(workflow, 'gate2').next;
    state.current.stage = next;
    state.current.next_action = fillAction(next, state.run.id);
    saveState(state);
    appendEvent('approve', { gate: 'gate2' });
    process.stdout.write(`${formatStatus(state)}\n`);
    return;
  }
  die(`unknown gate ${gate}`);
}

function cmdVerify() {
  const results = runVerifyTiers(['unit', 'lint', 'complexity', 'e2e', 'a11y']);
  let worst = 0;
  for (const r of results) {
    const label = r.skipped ? 'skip' : r.code === 0 ? 'ok' : `fail(${r.code})`;
    process.stdout.write(`${r.tier}: ${label}\n`);
    if (!r.skipped && r.code !== 0) {
      process.stdout.write(r.stdout);
      process.stderr.write(r.stderr);
      worst = r.code || 1;
    }
  }
  process.exit(worst);
}

function isProtected(rel, workflow) {
  return (workflow.protected_files || []).some((p) => posixRel(p) === rel || p === rel);
}

function gate2Approved(state) {
  return state?.gates?.gate2?.status === 'approved';
}

function commandIsGuarded(command, workflow) {
  const cmd = String(command || '').trim();
  if (!cmd) return false;
  for (const pat of workflow.guarded_shell_patterns || []) {
    const re = new RegExp(pat);
    if (re.test(cmd)) return true;
  }
  return false;
}

function guardPreToolUse(payload, state, workflow, config) {
  const tool = extractToolName(payload);
  const editTools = /^(Write|MultiEdit|Edit|StrReplace|Delete)$/i;
  if (tool && !editTools.test(tool) && !extractFilePath(payload)) {
    allow();
  }
  const filePath = extractFilePath(payload);
  if (!filePath) allow();
  const rel = posixRel(filePath);
  if (isProtected(rel, workflow)) {
    deny(`protected file: ${rel} (only wf.mjs may write workflow state)`);
  }
  if (!state?.run?.id) allow();
  const stg = stageById(workflow, state.current.stage);
  const patterns = expandWritePatterns(stg?.writes || [], config);
  if ((state.current.stage === 'implement' || state.current.stage === 'review')
    && matchesAnyGlob(rel, config.test_globs)) {
    deny(`frozen tests: ${rel} is in test_globs for stage ${state.current.stage}`);
  }
  if (!writesAllowed(rel, patterns)) {
    deny(`stage ${state.current.stage} cannot write ${rel}. Allowed: ${patterns.join(', ') || '(none)'}`);
  }
  allow();
}

function guardShell(payload, state, workflow) {
  const command = extractCommand(payload);
  if (!state?.run?.id) allow();
  if (!commandIsGuarded(command, workflow)) allow();
  if (gate2Approved(state)) allow();
  deny(`blocked until Gate 2 is approved: ${command}`);
}

function failingNamesFromVerify() {
  const results = runVerifyTiers(['unit']);
  const out = combinedOutput(results);
  const names = new Set();
  const re = /\b(REQ-\d+|TECH-[\w-]+|PRD-\d+\.\d+)\b/g;
  let m;
  while ((m = re.exec(out))) names.add(m[1]);
  return { failed: results.some((r) => !r.skipped && r.code !== 0), names: [...names].sort(), out };
}

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

function guardStop(payload, state) {
  const loopCount = payload.loop_count ?? 0;
  if (!state?.run?.id) {
    process.stdout.write('{}\n');
    process.exit(0);
  }
  if (state.current.stage !== 'implement') {
    process.stdout.write('{}\n');
    process.exit(0);
  }
  const cfg = loadConfig();
  const cap = cfg.loop_caps?.implement ?? 5;
  const { failed, names } = failingNamesFromVerify();
  if (!failed) {
    process.stdout.write('{}\n');
    process.exit(0);
  }
  const last = state.loops.implement.last_failing || [];
  const plateau = last.length && sameSet(last, names);
  state.loops.implement.round = (state.loops.implement.round || 0) + 1;
  state.loops.implement.last_failing = names;
  if (plateau || state.loops.implement.round >= cap || loopCount >= cap) {
    state.escalations.push({
      level: 'CRITICAL',
      stage: 'implement',
      reason: plateau ? 'identical failing-test set two rounds running' : 'implement loop cap hit',
      at: new Date().toISOString(),
    });
    saveState(state);
    appendEvent('escalation', { stage: 'implement' });
    process.stdout.write('{}\n');
    process.exit(0);
  }
  saveState(state);
  const msg = [
    `Implement loop round ${state.loops.implement.round}/${cap}. Unit tests still failing.`,
    'Re-run the implementer subagent for one more attempt. Do not edit frozen tests.',
    names.length ? `Failing ids: ${names.join(', ')}` : 'See wf verify output.',
  ].join(' ');
  process.stdout.write(`${JSON.stringify({ followup_message: msg })}\n`);
  process.exit(0);
}

function cmdGuard(event) {
  const payload = parseHookPayload(readStdin());
  const state = loadState();
  const workflow = loadWorkflow();
  const config = loadConfig();
  const name = event || payload.hook_event_name || '';
  if (name === 'preToolUse') return guardPreToolUse(payload, state, workflow, config);
  if (name === 'beforeShellExecution') return guardShell(payload, state, workflow);
  if (name === 'stop') return guardStop(payload, state);
  if (name === 'afterFileEdit') return cmdLog('afterFileEdit', payload);
  process.stdout.write('{}\n');
  process.exit(0);
}

function cmdLog(event, payload) {
  const p = payload || parseHookPayload(readStdin());
  appendEvent(event, {
    tool: extractToolName(p) || undefined,
    path: extractFilePath(p) || undefined,
  });
  process.stdout.write('{}\n');
}

function skillSearchRoots() {
  return [
    path.join(REPO_ROOT, '.cursor', 'skills'),
    path.join(REPO_ROOT, '.agents', 'skills'),
    path.join(REPO_ROOT, '.claude', 'skills'),
  ];
}

function cmdPrune({ dryRun = false } = {}) {
  const allow = new Set(readJson(PATHS.allowlist, { keep: [] }).keep || []);
  const removed = [];
  const kept = [];
  for (const root of skillSearchRoots()) {
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root)) {
      if (!name.startsWith('bmad-')) continue;
      const full = path.join(root, name);
      if (!fs.statSync(full).isDirectory()) continue;
      if (allow.has(name)) {
        kept.push(posixRel(full));
        continue;
      }
      removed.push(posixRel(full));
      if (!dryRun) fs.rmSync(full, { recursive: true, force: true });
    }
  }
  process.stdout.write(`kept: ${kept.join(', ') || '(none)'}\n`);
  process.stdout.write(`${dryRun ? 'would remove' : 'removed'}: ${removed.join(', ') || '(none)'}\n`);
}

function archiveRun(state, label) {
  const dest = path.join(PATHS.runs, state.run.id);
  fs.mkdirSync(dest, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(PATHS.state, path.join(dest, `${label}-${stamp}.state.json`));
  if (fs.existsSync(PATHS.events)) {
    fs.copyFileSync(PATHS.events, path.join(dest, `${label}-${stamp}.events.jsonl`));
  }
}

function cmdAbort({ force = false } = {}) {
  const state = loadState();
  if (!state?.run?.id) die('no active run');
  archiveRun(state, 'abort');
  fs.rmSync(PATHS.state, { force: true });
  appendEvent('abort', { id: state.run.id, force });
  const msg = force
    ? `Aborted ${state.run.id}. Working tree left as-is (--force).`
    : `Aborted ${state.run.id}. Choose keep, stash, or discard the working tree before continuing.`;
  process.stdout.write(`${msg}\n`);
}

function cmdPause() {
  const state = loadState();
  if (!state?.run?.id) die('no active run');
  const dest = path.join(PATHS.runs, state.run.id, 'paused.state.json');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(PATHS.state, dest);
  fs.rmSync(PATHS.state, { force: true });
  appendEvent('pause', { id: state.run.id });
  process.stdout.write(`Paused ${state.run.id}. Resume with: node .agent-workflow/wf.mjs resume ${state.run.id}\n`);
}

function cmdResume(runId) {
  if (loadState()?.run?.id) die('a run is already active');
  let id = runId;
  if (!id) {
    const ids = fs.existsSync(PATHS.runs) ? fs.readdirSync(PATHS.runs) : [];
    const paused = ids.filter((d) => fs.existsSync(path.join(PATHS.runs, d, 'paused.state.json')));
    if (paused.length !== 1) die('pass a run id: wf resume <run-id>');
    id = paused[0];
  }
  const src = path.join(PATHS.runs, id, 'paused.state.json');
  if (!fs.existsSync(src)) die(`no paused state at ${src}`);
  fs.copyFileSync(src, PATHS.state);
  appendEvent('resume', { id });
  process.stdout.write(`${formatStatus(loadState())}\n`);
}

function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--check') flags.check = true;
    else if (a === '--hook') flags.hook = true;
    else if (a === '--force') flags.force = true;
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--result') flags.result = argv[++i];
    else if (a === '--approach') flags.approach = argv[++i];
    else rest.push(a);
  }
  return { flags, rest };
}

function main() {
  const { flags, rest } = parseArgs(process.argv.slice(2));
  const cmd = rest[0];
  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') {
    process.stdout.write(`usage: wf.mjs <run|status|done|approve|verify|guard|log|prune|abort|pause|resume> [args]\n`);
    process.exit(cmd ? 0 : 1);
  }
  if (cmd === 'run') return cmdRun(rest.slice(1).join(' '));
  if (cmd === 'status') return cmdStatus(flags);
  if (cmd === 'done') return cmdDone(rest[1], flags.result);
  if (cmd === 'approve') return cmdApprove(rest[1], flags.approach);
  if (cmd === 'verify') return cmdVerify();
  if (cmd === 'guard') return cmdGuard(rest[1]);
  if (cmd === 'log') return cmdLog(rest[1]);
  if (cmd === 'prune') return cmdPrune({ dryRun: flags.dryRun });
  if (cmd === 'abort') return cmdAbort({ force: flags.force });
  if (cmd === 'pause') return cmdPause();
  if (cmd === 'resume') return cmdResume(rest[1]);
  die(`unknown command ${cmd}`);
}

main();

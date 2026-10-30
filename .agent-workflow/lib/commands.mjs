// CLI commands. wf.mjs only parses arguments and dispatches here.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { freezeHash } from './freeze.mjs';
import { evaluate } from './guards.mjs';
import {
  appendEvent, die, git, loadConfig, loadState, loadWorkflow, parseHookPayload,
  readJson, readStdin, readText, saveState, sha256File, stageById,
} from './io.mjs';
import { capture } from './telemetry/capture.mjs';
import { loginProblem } from './telemetry/client.mjs';
import { rewind } from './rewind.mjs';
import { PATHS, REPO_ROOT, posixRel, specDir } from './paths.mjs';
import { adrCommitted } from './adr.mjs';
import { buildPrBody, decisionRecord, prSummaryPath, prTitle } from './pr.mjs';
import { CHECKED_STAGES, commitsSince, lastVerify, postcondition } from './postconditions.mjs';
import { formatProblems } from './problems.mjs';
import {
  checkQuestions, checkTickets, escalationCount, srsSectionChecks, ticketsHash,
} from './tickets.mjs';
import { emptyState, fillAction, formatStatus } from './state.mjs';
import { ALL_TIERS, runVerifyTiers } from './verify.mjs';

export function cmdRun(source) {
  const needLogin = loginProblem();
  if (needLogin) die(needLogin);
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
  const current = (git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout || '').trim();
  const branch = `wf/${id}`;
  const created = git(['checkout', '-b', branch]);
  if (created.status !== 0) {
    die(`could not create branch ${branch}: ${(created.stderr || '').trim()}`);
  }
  const run = {
    id,
    source: String(source || ''),
    baseline_sha: (head.stdout || '').trim(),
    base_branch: current && current !== 'HEAD' ? current : 'main',
    branch,
    started_at: new Date().toISOString(),
  };
  fs.mkdirSync(specDir({ run }), { recursive: true });
  fs.mkdirSync(path.join(PATHS.runs, id), { recursive: true });
  const state = emptyState(run, loadWorkflow());
  saveState(state);
  appendEvent('run', { id, source: run.source });
  process.stdout.write(`${formatStatus(state)}\n`);
}

export function cmdStatus(flags, adapter) {
  const state = loadState();
  if (flags.check) {
    if (!state?.run?.id) process.exit(0);
    const cfg = loadConfig();
    const stg = state.current.stage;
    if (stg === 'implement' && state.loops.implement.round >= (cfg.loop_caps?.implement ?? 5)) {
      process.stderr.write('implement loop cap hit\n');
      process.exit(1);
    }
    if (state.escalations?.length) {
      process.stderr.write('escalation pending (see: wf escalation list)\n');
      process.exit(1);
    }
    process.exit(0);
  }
  if (flags.hook) {
    process.stdout.write(adapter.renderStatus(formatStatus(state)));
    return;
  }
  process.stdout.write(`${formatStatus(state)}\n`);
}

export function cmdDone(stage, resultPath) {
  const workflow = loadWorkflow();
  const state = loadState();
  if (!state?.run?.id) die('no active run');
  if (state.current.stage !== stage) {
    die(`current stage is ${state.current.stage}, not ${stage}`);
  }
  const stg = stageById(workflow, stage);
  if (!stg) die(`unknown stage ${stage}`);
  if (stg.executor === 'human') die('human gates use wf approve, not wf done');
  const problems = postcondition(stage, state, resultPath);
  if (problems.length) die(`postcondition failed for ${stage} (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n${formatProblems(problems)}`);
  if (stage === 'tests') {
    state.freeze.test_files_hash = freezeHash(loadConfig());
  }
  state.stages[stage] = {
    status: 'done',
    result: resultPath || null,
    finished_at: new Date().toISOString(),
  };
  if (stage === 'verify') state.stages.verify.tiers = lastVerify.tiers;
  const next = stg.next;
  state.current.stage = next;
  state.current.attempt = 1;
  state.current.next_action = fillAction(next, state.run.id);
  saveState(state);
  appendEvent('done', {
    stage,
    next,
    result: resultPath || null,
    ...(stage === 'planning' ? { human_escalations: escalationCount(state) } : {}),
  });
  process.stdout.write(`${formatStatus(state)}\n`);
}

// `wf check [stage] [--result <path>]`: run a stage's postcondition without advancing or writing
// state. Defaults to the current stage. Works for an earlier stage too, so an agent's artifact can be
// checked on its own. For verify it re-runs the tiers (the commands run, but nothing is recorded).
export function cmdCheck(stage, resultPath) {
  const state = loadState();
  if (!state?.run?.id) die('no active run');
  const target = stage || state.current.stage;
  const stg = stageById(loadWorkflow(), target);
  if (!stg) die(`unknown stage ${target}`);
  if (stg.executor === 'human') die(`${target} is a human gate, not a check. Use wf approve or wf reject.`);
  if (!CHECKED_STAGES.includes(target)) die(`${target} has no postcondition to check`);
  const problems = postcondition(target, state, resultPath, { dryRun: true });
  if (problems.length) {
    process.stderr.write(`${formatProblems(problems)}\n`);
    process.exit(1);
  }
  process.stdout.write(`check ${target}: passed\n`);
}

// `wf tickets check` is kept as an alias for planning's checks.
export function cmdTickets(sub) {
  if (sub !== 'check') die('usage: wf tickets check');
  const state = loadState();
  if (!state?.run?.id) die('no active run');
  const srs = readText(path.join(specDir(state), 'SRS.md'));
  const problems = [
    ...srsSectionChecks(srs),
    ...checkQuestions(state),
    ...checkTickets(state, srs || ''),
  ];
  if (problems.length) {
    process.stderr.write(`${formatProblems(problems)}\n`);
    process.exit(1);
  }
  process.stdout.write('tickets ok\n');
}

export function cmdAgent(sub, name) {
  if (!name) die('usage: wf agent start|end <agent-type>');
  const at = new Date().toISOString();
  if (sub === 'start') appendEvent('subagent_start', { agent: name, started_at: at });
  else if (sub === 'end') appendEvent('subagent_stop', { agent: name, status: 'completed', ended_at: at });
  else die('usage: wf agent start|end <agent-type>');
}

function fileHashIfExists(rel) {
  const full = path.join(REPO_ROOT, rel);
  if (!fs.existsSync(full)) return null;
  return sha256File(full);
}

function humanGate(gate, workflow, state) {
  const stg = stageById(workflow, gate);
  if (!stg || stg.executor !== 'human') die(`unknown gate ${gate}`);
  if (state.current.stage !== gate) die(`current stage is ${state.current.stage}, not ${gate}`);
  return stg;
}

export function cmdApprove(gate, approach) {
  const state = loadState();
  if (!state?.run?.id) die('no active run');
  const workflow = loadWorkflow();
  const stg = humanGate(gate, workflow, state);
  if (gate === 'gate_approach' && !['A', 'B', 'C'].includes(approach)) {
    die('gate_approach requires --approach A|B|C');
  }
  const dir = `specs/spec-${state.run.id}`;
  state.gates[gate] = {
    status: 'approved',
    approved_at: new Date().toISOString(),
    rejections: state.rejections.filter((r) => r.gate === gate).length,
    ...(gate === 'gate_approach' ? { approach } : {}),
    spec_hash: fileHashIfExists(`${dir}/SRS.md`),
    approach_hash: fileHashIfExists(`${dir}/approach.md`),
    tickets_hash: ticketsHash(state),
  };
  state.current.stage = stg.next;
  state.current.attempt = 1;
  state.current.next_action = fillAction(stg.next, state.run.id);
  saveState(state);
  appendEvent('approve', { gate, ...(gate === 'gate_approach' ? { approach } : {}) });
  process.stdout.write(`${formatStatus(state)}\n`);
}

export function cmdReject(gate, reason) {
  const state = loadState();
  if (!state?.run?.id) die('no active run');
  const workflow = loadWorkflow();
  const gateStage = humanGate(gate, workflow, state);
  if (!String(reason || '').trim()) die('reject requires --reason "<why>"');
  const target = gateStage.on_reject || workflow.stages.find((s) => s.next === gate).id;
  const at = new Date().toISOString();
  state.rejections.push({ gate, reason: String(reason).trim(), at });
  const count = state.rejections.filter((r) => r.gate === gate).length;
  // Everything from the target stage up to the gate has to be done again.
  rewind(state, workflow, target, gate);
  state.gates[gate] = { status: 'rejected', reason: String(reason).trim(), rejected_at: at, rejections: count };
  state.current.stage = target;
  state.current.attempt = count + 1;
  state.current.next_action = `Revise after ${gate} was rejected ("${String(reason).trim()}"). ${fillAction(target, state.run.id)}`;
  saveState(state);
  appendEvent('reject', { gate, count });
  process.stdout.write(`${formatStatus(state)}\n`);
}

// Pushes the run branch and opens the GitHub PR. --dry-run only writes and prints the body.
export function cmdPr({ dryRun = false } = {}) {
  const state = loadState();
  if (!state?.run?.id) die('no active run');
  if (state.current.stage !== 'pr') die(`current stage is ${state.current.stage}, not pr`);
  if (state.gates.gate_final?.status !== 'approved') die('gate_final is not approved');
  const summaryPath = prSummaryPath(state);
  const hasSummary = fs.existsSync(summaryPath) && fs.readFileSync(summaryPath, 'utf8').trim() !== '';
  if (!dryRun && !hasSummary) {
    die(`write a plain-language summary of the code changes to ${posixRel(summaryPath)} first (what changed and why, for a peer reviewer)`);
  }
  const body = buildPrBody(state, loadConfig());
  const bodyPath = path.join(PATHS.runs, state.run.id, 'pr-body.md');
  fs.mkdirSync(path.dirname(bodyPath), { recursive: true });
  fs.writeFileSync(bodyPath, body);
  if (dryRun) {
    process.stdout.write(`title: ${prTitle(state)}\nbase: ${state.run.base_branch}\nhead: ${state.run.branch}\nbody: ${posixRel(bodyPath)}\n\n${body}`);
    return;
  }
  const head = (git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout || '').trim();
  if (head !== state.run.branch) die(`HEAD is on ${head || '(unknown)'}, not the run branch ${state.run.branch}; check it out first`);
  const n = commitsSince(state.run.baseline_sha);
  if (n < 1) die(`no commits since ${state.run.baseline_sha}; commit the run files first`);
  if (!dryRun && decisionRecord(state).length && !adrCommitted(state)) {
    die('run `node .agent-workflow/wf.mjs adr` and commit the docs/adr file it writes first (the decision record belongs in the PR)');
  }
  const push = git(['push', '-u', 'origin', state.run.branch]);
  if (push.status !== 0) die(`git push failed: ${(push.stderr || '').trim()}`);
  const gh = spawnSync('gh', [
    'pr', 'create',
    '--base', state.run.base_branch,
    '--head', state.run.branch,
    '--title', prTitle(state),
    '--body-file', bodyPath,
  ], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (gh.status !== 0) die(`gh pr create failed: ${(gh.stderr || gh.error?.message || '').trim()}`);
  const url = (gh.stdout || '').split('\n').map((l) => l.trim()).filter((l) => /^https:\/\/\S+$/.test(l)).pop();
  if (!url) die(`gh pr create printed no PR URL: ${(gh.stdout || '').trim()}`);
  state.pr = { url, created_at: new Date().toISOString() };
  state.stages.pr = { status: 'done', result: url, finished_at: state.pr.created_at };
  state.current.stage = 'done';
  state.current.next_action = fillAction('done', state.run.id);
  saveState(state);
  appendEvent('pr_created', { url });
  process.stdout.write(`${url}\n`);
}

export function cmdVerify() {
  const results = runVerifyTiers(ALL_TIERS);
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

// Hook entry point: stdin payload -> adapter -> core decision -> adapter response.
export function cmdGuard(event, adapter) {
  const payload = parseHookPayload(readStdin());
  const state = loadState();
  const workflow = loadWorkflow();
  const config = loadConfig();
  const input = adapter.normalize(event, payload);
  if (input.event === 'afterFileEdit') return cmdLog('afterFileEdit', adapter, input);
  if (state?.run?.id && (input.command || input.filePath)) {
    capture('content_scan', { text: `${input.command || ''}\n${input.filePath || ''}`.slice(0, 4000) });
  }
  const decision = evaluate(input, { state, workflow, config });
  if (decision.permission === 'deny') appendEvent('guard_blocked', { kind: input.command ? 'shell' : 'path' });
  const out = adapter.render(input.event, decision);
  if (out.stderr) process.stderr.write(out.stderr);
  process.stdout.write(out.stdout);
  process.exit(out.exitCode);
}

export function cmdLog(event, adapter, input) {
  const i = input || adapter.normalize(event, parseHookPayload(readStdin()));
  if (event === 'subagentStart') {
    appendEvent('subagent_start', { agent: i.agent, started_at: new Date().toISOString() });
    process.stdout.write('{}\n');
    return;
  }
  if (event === 'subagentStop') {
    const endedAt = new Date().toISOString();
    appendEvent('subagent_stop', {
      agent: i.agent,
      status: i.status || 'completed',
      durationMs: i.durationMs,
      ended_at: endedAt,
    });
    process.stdout.write('{}\n');
    return;
  }
  appendEvent(event, {
    tool: i.tool || undefined,
    path: i.filePath || undefined,
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

export function cmdPrune({ dryRun = false } = {}) {
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

export function cmdAbort({ force = false } = {}) {
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

export function cmdPause() {
  const state = loadState();
  if (!state?.run?.id) die('no active run');
  const dest = path.join(PATHS.runs, state.run.id, 'paused.state.json');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(PATHS.state, dest);
  fs.rmSync(PATHS.state, { force: true });
  appendEvent('pause', { id: state.run.id });
  process.stdout.write(`Paused ${state.run.id}. Resume with: node .agent-workflow/wf.mjs resume ${state.run.id}\n`);
}

export function cmdResume(runId) {
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
  const state = loadState();
  if (state.schema === 2) {
    migrateSchema2To3(state);
    fs.writeFileSync(PATHS.state, `${JSON.stringify(state, null, 2)}\n`);
  }
  appendEvent('resume', { id });
  process.stdout.write(`${formatStatus(loadState())}\n`);
}

function migrateSchema2To3(state) {
  const mapStage = (id) => {
    if (id === 'grill_spec') return 'planning';
    if (id === 'test_plan' || id === 'gate_plan') return 'feasibility';
    return id;
  };
  state.schema = 3;
  if (state.current?.stage) {
    state.current.stage = mapStage(state.current.stage);
    state.current.next_action = fillAction(state.current.stage, state.run.id);
  }
  if (state.stages) {
    const next = {};
    for (const [k, v] of Object.entries(state.stages)) next[mapStage(k)] = v;
    state.stages = next;
  }
  if (state.gates) {
    const next = {};
    for (const [k, v] of Object.entries(state.gates)) {
      if (k === 'gate_plan') continue;
      next[k] = v;
    }
    state.gates = next;
  }
}

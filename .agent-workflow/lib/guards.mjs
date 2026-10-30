// Harness-neutral guard logic. Takes a normalized input and returns a decision:
//   { permission: 'allow' | 'deny', message?, followup? }
// Rendering the decision for a specific harness is the adapter's job.
import { appendEvent, git, saveState, stageById } from './io.mjs';
import { expandWritePatterns, matchesAnyGlob, productGlobs, writesAllowed } from './globs.mjs';
import { posixRel } from './paths.mjs';
import { readE2eReport } from './e2e.mjs';
import { combinedOutput, e2eReportPath, runVerifyTiers } from './verify.mjs';

const allow = (extra = {}) => ({ permission: 'allow', ...extra });
const deny = (message) => ({ permission: 'deny', message });

function isProtected(rel, workflow) {
  return (workflow.protected_files || []).some((p) => posixRel(p) === rel || p === rel);
}

function finalApproved(state) {
  return state?.gates?.gate_final?.status === 'approved';
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

export function guardPreToolUse(input, state, workflow, config) {
  if (!input.filePath) return allow();
  const rel = posixRel(input.filePath);
  if (isProtected(rel, workflow)) {
    return deny(`protected file: ${rel} (only wf.mjs may write workflow state)`);
  }
  if (!state?.run?.id) return allow();
  const stg = stageById(workflow, state.current.stage);
  const patterns = expandWritePatterns(stg?.writes || [], config, state.run.id);
  if ((state.current.stage === 'implement' || state.current.stage === 'review')
    && matchesAnyGlob(rel, productGlobs(config))) {
    return deny(`frozen tests: ${rel} is in product_test_globs for stage ${state.current.stage}`);
  }
  if (!writesAllowed(rel, patterns)) {
    return deny(`stage ${state.current.stage} cannot write ${rel}. Allowed: ${patterns.join(', ') || '(none)'}`);
  }
  return allow();
}

export function guardShell(input, state, workflow) {
  if (!state?.run?.id) return allow();
  if (!commandIsGuarded(input.command, workflow)) return allow();
  if (finalApproved(state)) return allow();
  return deny(`blocked until the final gate is approved: ${input.command}`);
}

// Ids of what is still failing. Playwright's list reporter prints every title, passing
// or not, so e2e failures come from its JSON report; other tiers fall back to a scan
// of their own output, and only when that tier failed.
function failingNamesFromVerify() {
  const results = runVerifyTiers(['unit', 'e2e']);
  const failed = results.filter((r) => !r.skipped && r.code !== 0);
  const names = new Set();
  for (const r of failed) {
    const tests = r.tier === 'e2e' ? readE2eReport(e2eReportPath()) : null;
    if (tests) {
      for (const t of tests) if (t.outcome === 'failed') t.ids.forEach((id) => names.add(id));
      continue;
    }
    for (const m of combinedOutput([r]).matchAll(/\b(REQ-\d+|TECH-[\w-]+|PRD-\d+\.\d+)\b/g)) names.add(m[1]);
  }
  return { failed: failed.length > 0, names: [...names].sort() };
}

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

function implementStop(input, state, config) {
  const loopCount = input.loopCount ?? 0;
  if (!state?.run?.id) return allow();
  if (state.current.stage !== 'implement') return allow();
  const cap = config.loop_caps?.implement ?? 5;
  const { failed, names } = failingNamesFromVerify();
  if (!failed) return allow();
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
    return allow();
  }
  saveState(state);
  appendEvent('loop_round', { stage: 'implement', round: state.loops.implement.round, cap });
  const followup = [
    `Implement loop round ${state.loops.implement.round}/${cap}. Unit tests still failing.`,
    'Re-run the implementer subagent for one more attempt. Do not edit frozen tests.',
    names.length ? `Failing ids: ${names.join(', ')}` : 'See wf verify output.',
  ].join(' ');
  return allow({ followup });
}

// Files the run may change: the writes of every stage up to the current one, plus the run's artifacts.
export function allowedScope(state, workflow, config) {
  const patterns = [];
  for (const stg of workflow.stages) {
    // Negations are for the current stage only (frozen tests), so they are not unioned.
    patterns.push(...expandWritePatterns(stg.writes || [], config, state.run.id).filter((p) => !p.startsWith('!')));
    if (stg.id === state.current.stage) break;
  }
  return [...patterns, `specs/spec-${state.run.id}/**`, `.agent-workflow/runs/${state.run.id}/**`];
}

// Workflow runtime files change on every wf command, so they are not product changes.
const RUNTIME = /^\.agent-workflow\/(state\.json|events\.jsonl|queue\/|runs\/)/;

// Tracked changes since the baseline plus untracked files, as NUL-separated git output so quoted
// or unusual paths survive. Throws when git cannot read the baseline: a silent pass would hide writes.
export function changedFiles(state) {
  const base = state.run.baseline_sha;
  if (!base) throw new Error('run has no baseline_sha');
  const diff = git(['diff', '-z', '--name-only', base]);
  if (diff.status !== 0) throw new Error(`git diff against ${base} failed: ${(diff.stderr || '').trim()}`);
  const untracked = git(['ls-files', '-z', '--others', '--exclude-standard']);
  const files = new Set([...(diff.stdout || '').split('\0'), ...(untracked.stdout || '').split('\0')].filter(Boolean));
  return [...files].filter((rel) => !RUNTIME.test(rel));
}

export function scopeViolations(state, workflow, config) {
  if (!state?.run?.id) return [];
  const patterns = allowedScope(state, workflow, config);
  return changedFiles(state).filter((rel) => !writesAllowed(rel, patterns));
}

// Stop hook: a stray write is reported in the same turn. It adds to the follow-up and never blocks.
export function guardStop(input, state, config, workflow) {
  const res = implementStop(input, state, config);
  let out;
  try {
    out = scopeViolations(state, workflow, config);
  } catch (err) {
    return allow({ followup: [res.followup, `Could not check write scope: ${err.message}.`].filter(Boolean).join(' ') });
  }
  if (!out.length) return res;
  const note = `Out-of-scope changes in ${state.current.stage}: ${out.join(', ')}. Revert them, or ask the human if they are needed.`;
  return allow({ followup: [note, res.followup].filter(Boolean).join(' ') });
}

export function evaluate(input, { state, workflow, config }) {
  if (input.event === 'preToolUse') return guardPreToolUse(input, state, workflow, config);
  if (input.event === 'beforeShellExecution') return guardShell(input, state, workflow);
  if (input.event === 'stop') return guardStop(input, state, config, workflow);
  return allow();
}

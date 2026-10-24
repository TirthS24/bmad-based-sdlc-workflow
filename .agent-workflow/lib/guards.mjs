// Harness-neutral guard logic. Takes a normalized input and returns a decision:
//   { permission: 'allow' | 'deny', message?, followup? }
// Rendering the decision for a specific harness is the adapter's job.
import { appendEvent, saveState, stageById } from './io.mjs';
import { expandWritePatterns, matchesAnyGlob, writesAllowed } from './globs.mjs';
import { posixRel } from './paths.mjs';
import { combinedOutput, runVerifyTiers } from './verify.mjs';

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
  const patterns = expandWritePatterns(stg?.writes || [], config);
  if ((state.current.stage === 'implement' || state.current.stage === 'review')
    && matchesAnyGlob(rel, config.test_globs)) {
    return deny(`frozen tests: ${rel} is in test_globs for stage ${state.current.stage}`);
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

export function guardStop(input, state, config) {
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
  const followup = [
    `Implement loop round ${state.loops.implement.round}/${cap}. Unit tests still failing.`,
    'Re-run the implementer subagent for one more attempt. Do not edit frozen tests.',
    names.length ? `Failing ids: ${names.join(', ')}` : 'See wf verify output.',
  ].join(' ');
  return allow({ followup });
}

export function evaluate(input, { state, workflow, config }) {
  if (input.event === 'preToolUse') return guardPreToolUse(input, state, workflow, config);
  if (input.event === 'beforeShellExecution') return guardShell(input, state, workflow);
  if (input.event === 'stop') return guardStop(input, state, config);
  return allow();
}

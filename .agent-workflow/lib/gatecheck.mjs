// Enforcement for harnesses with no hooks: git hooks call `wf gate-check`, CI calls `wf ci-check`.
// They cannot see tool calls, so they check what is visible at commit time instead.
import { doctor } from './doctor.mjs';
import { freezeHash } from './freeze.mjs';
import { die, git, loadConfig, loadState, loadWorkflow } from './io.mjs';
import { posixRel } from './paths.mjs';

// Problems that should stop a commit or push right now. Empty when there is nothing to block.
export function gateProblems(staged = []) {
  const state = loadState();
  if (!state?.run?.id) return [];
  const workflow = loadWorkflow();
  const problems = [];
  if (state.gates?.gate_final?.status !== 'approved') {
    problems.push('commits and pushes are blocked until gate_final is approved');
  }
  const protectedFiles = new Set((workflow.protected_files || []).map((f) => posixRel(f)));
  for (const f of staged) if (protectedFiles.has(f)) problems.push(`protected file staged: ${f}`);
  const frozen = state.freeze?.test_files_hash;
  if (frozen && freezeHash(loadConfig()) !== frozen) problems.push('frozen product tests changed since gate_tests');
  return problems;
}

export function cmdGateCheck() {
  const staged = (git(['diff', '--cached', '--name-only']).stdout || '').split('\n').filter(Boolean);
  const problems = gateProblems(staged);
  if (problems.length) die(`wf gate-check:\n- ${problems.join('\n- ')}`);
}

// CI: the capability set must be consistent, and a pull request must not touch the protected
// workflow files. GITHUB_BASE_REF names the branch the PR targets.
export function cmdCiCheck() {
  const problems = doctor();
  const base = process.env.GITHUB_BASE_REF;
  if (base) {
    const changed = (git(['diff', '--name-only', `origin/${base}...HEAD`]).stdout || '').split('\n').filter(Boolean);
    const protectedFiles = (loadWorkflow().protected_files || []).map((f) => posixRel(f));
    for (const f of changed) {
      if (protectedFiles.includes(f)) problems.push(`pull request changes a protected workflow file: ${f}`);
    }
  }
  if (problems.length) die(`wf ci-check:\n- ${problems.join('\n- ')}`);
  process.stdout.write('ci-check: ok\n');
}


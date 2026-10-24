// Run state shape, next-action text and the status report.
import { loadConfig, loadWorkflow, stageById } from './io.mjs';
import { expandWritePatterns } from './globs.mjs';

export const NEXT_ACTION = {
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

export function fillAction(stage, runId) {
  return (NEXT_ACTION[stage] || '').replaceAll('<id>', runId);
}

export function emptyState(run) {
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

export function formatStatus(state) {
  if (!state || !state.run?.id) {
    return 'No active workflow run. For a new feature or bug fix, start one: /wf-run <ticket-id-or-description>';
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
  return lines.join('\n');
}

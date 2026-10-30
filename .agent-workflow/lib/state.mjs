// Run state shape, next-action text and the status report.
import { loadConfig, loadWorkflow, stageById } from './io.mjs';
import { expandWritePatterns } from './globs.mjs';

export const NEXT_ACTION = {
  planning: 'Run /wf-start. … Then: node .agent-workflow/wf.mjs done planning --result specs/spec-<id>/SRS.md',
  gate_spec: 'Human: review SRS.md and persona tickets, then /wf-approve gate_spec (or /wf-reject gate_spec <reason>)',
  feasibility: 'Run /wf-feasibility (dispatches solution-architect). Write approach.md. Then: node .agent-workflow/wf.mjs done feasibility --result specs/spec-<id>/approach.md',
  gate_approach: 'Human: review approach.md, choose A|B|C, then /wf-approve gate_approach --approach <A|B|C> (or /wf-reject gate_approach <reason>)',
  tests: 'Run /wf-tests (test-architect atdd). Then: node .agent-workflow/wf.mjs done tests --result <test path or dir>',
  gate_tests: 'Human: review the new failing tests, then /wf-approve gate_tests (or /wf-reject gate_tests <reason>)',
  implement: 'Run /wf-implement (one attempt). The stop hook re-submits until green or the cap.',
  review: 'Run /wf-review (dispatches code-reviewer; fixes go to implementer). Then: node .agent-workflow/wf.mjs done review --result <review output path>',
  gate_review: 'Human: read review.md (decision-needed items), then /wf-approve gate_review (or /wf-reject gate_review <reason>, which returns to implement)',
  verify: 'Run /wf-verify. Then: node .agent-workflow/wf.mjs done verify --result .agent-workflow/runs/<id>/evidence/',
  gate_final: 'Human: read the evidence bundle, then /wf-approve gate_final. This unlocks commit, push and the PR (or /wf-reject gate_final <reason>)',
  pr: 'Run /wf-pr: commit the run files on the run branch, write .agent-workflow/runs/<id>/pr-summary.md (plain-language summary of the code changes), then: node .agent-workflow/wf.mjs pr (add --dry-run to preview the PR body)',
  done: 'Run complete. No further pipeline action.',
};

export function fillAction(stage, runId) {
  return (NEXT_ACTION[stage] || '').replaceAll('<id>', runId);
}

export function emptyState(run, workflow) {
  const gates = {};
  for (const s of workflow.stages) {
    if (s.executor === 'human') gates[s.id] = { status: 'pending' };
  }
  return {
    schema: 3,
    run,
    current: { stage: 'planning', next_action: fillAction('planning', run.id), attempt: 1 },
    gates,
    rejections: [],
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
  const gates = Object.entries(state.gates)
    .map(([id, g]) => `${id.replace(/^gate_/, '')}=${g.status}`)
    .join(' ');
  const approach = state.gates.gate_approach?.approach;
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
    `gates: ${gates}`,
    ...(approach ? [`approach: ${approach}`] : []),
    `loop: ${loop}`,
    `writes: ${writeHint(state)}`,
    `next_action: ${state.current.next_action}`,
  ];
  return lines.join('\n');
}

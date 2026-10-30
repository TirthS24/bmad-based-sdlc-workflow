// Sends a run back to an earlier stage: forget the stage records from there on.
// Shared by gate rejection, `escalation reject` and `goto`.
import { fillAction } from './state.mjs';

// `end` is the first stage id to keep (a rejected gate), or null to forget everything after target.
export function rewind(state, workflow, target, end = null) {
  const ids = workflow.stages.map((s) => s.id);
  const from = ids.indexOf(target);
  const to = end ? ids.indexOf(end) : ids.length;
  for (const id of ids.slice(from, to)) {
    if (state.stages[id]?.status === 'skipped' || state.gates[id]?.status === 'skipped') continue;
    delete state.stages[id];
    if (state.gates[id]) state.gates[id] = { status: 'pending', human: true };
  }
  if (from <= ids.indexOf('tests')) state.freeze.test_files_hash = null;
  if (from <= ids.indexOf('implement')) {
    state.loops.implement = { round: 0, last_failing: [] };
    state.loops.review = { round: 0 };
  }
  if (from <= ids.indexOf('verify')) state.loops.verify_fix = { round: 0 };
  state.escalations = [];
  state.current.stage = target;
  state.current.attempt = 1;
  state.current.next_action = fillAction(target, state.run.id);
}

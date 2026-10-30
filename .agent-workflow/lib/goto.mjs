// `wf goto <stage>`: human-only jump. Backwards always works. Forwards only over stages whose
// artifact passes its check, and never over a gate that has not been approved.
import { appendEvent, die, loadState, loadWorkflow, saveState } from './io.mjs';
import { checkFeasibility, checkPlanning } from './postconditions.mjs';
import { formatProblems } from './problems.mjs';
import { rewind } from './rewind.mjs';
import { profileOf } from './profiles.mjs';
import { fillAction, formatStatus } from './state.mjs';

// Stages whose output is a file, so a check can run without a result path. The rest must really be done.
const FILE_CHECKS = { planning: checkPlanning, feasibility: checkFeasibility };

export function cmdGoto(target) {
  const state = loadState();
  if (!state?.run?.id) die('no active run');
  const workflow = loadWorkflow();
  const ids = workflow.stages.map((s) => s.id);
  const from = ids.indexOf(state.current.stage);
  const to = ids.indexOf(target);
  if (to < 0) die(`unknown stage ${target} (one of: ${ids.join(', ')})`);
  if (to === from) die(`already at ${target}`);
  const profile = profileOf(state, workflow);
  if ((profile.skip || []).includes(target)) die(`${target} is skipped by profile ${profile.name}`);

  if (to < from) {
    rewind(state, workflow, target);
  } else {
    const at = new Date().toISOString();
    for (const id of ids.slice(from, to)) {
      if (profile.skip?.includes(id)) continue; // a skipped stage counts as done
      const stg = workflow.stages.find((s) => s.id === id);
      if (stg.executor === 'human') {
        if (state.gates[id]?.status !== 'approved') die(`${id} is not approved; goto never skips a gate. Reach it and /wf-approve ${id}.`);
      } else if (state.stages[id]?.status !== 'done') {
        const check = FILE_CHECKS[id];
        if (!check) die(`${id} has not been done and cannot be jumped over`);
        const problems = check(state);
        if (problems.length) die(`cannot jump over ${id}:\n${formatProblems(problems)}`);
        state.stages[id] = { status: 'done', result: 'goto', finished_at: at };
      }
    }
    state.current.stage = target;
    state.current.attempt = 1;
    state.current.next_action = fillAction(target, state.run.id);
  }
  saveState(state);
  appendEvent('goto', { from: ids[from], to: target, direction: to < from ? 'back' : 'forward' });
  process.stdout.write(`${formatStatus(state)}\n`);
}

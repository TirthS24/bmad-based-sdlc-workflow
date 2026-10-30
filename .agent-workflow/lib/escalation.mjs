import { rejectTarget } from './profiles.mjs';
// `wf escalation list|retry|reject|abort`: the human's way out of a loop-cap or stuck-loop stop.
import { appendEvent, die, loadState, loadWorkflow, saveState } from './io.mjs';
import { cmdAbort } from './commands.mjs';
import { rewind } from './rewind.mjs';
import { formatStatus } from './state.mjs';

const RESET = {
  implement: (s) => { s.loops.implement = { round: 0, last_failing: [] }; },
  review: (s) => { s.loops.review = { round: 0 }; },
  verify: (s) => { s.loops.verify_fix = { round: 0 }; },
};

export function cmdEscalation(action, note) {
  const state = loadState();
  if (!state?.run?.id) die('no active run');
  const list = state.escalations || [];

  if (action === 'list' || !action) {
    process.stdout.write(list.length
      ? `${list.map((e, i) => `#${i + 1} ${e.level} ${e.stage}: ${e.reason} (${e.at})`).join('\n')}\n`
      : 'no escalations\n');
    return;
  }
  if (action === 'abort') {
    appendEvent('escalation_abort', { stage: state.current.stage });
    return cmdAbort({});
  }
  if (!list.length) die('no escalation pending');

  if (action === 'retry') {
    (RESET[state.current.stage] || (() => {}))(state);
    state.escalations = [];
    state.current.next_action = `Retry after escalation${note ? ` ("${note}")` : ''}. ${state.current.next_action}`;
    saveState(state);
    appendEvent('escalation_retry', { stage: state.current.stage, note: note || null });
    process.stdout.write(`${formatStatus(state)}\n`);
    return;
  }

  if (action === 'reject') {
    if (!String(note || '').trim()) die('escalation reject requires --reason "<why>"');
    const workflow = loadWorkflow();
    const ids = workflow.stages.map((s) => s.id);
    const gate = ids.slice(0, ids.indexOf(state.current.stage)).reverse()
      .find((id) => workflow.stages.find((s) => s.id === id).executor === 'human');
    if (!gate) die('no earlier gate to send the run back to');
    const gateStage = workflow.stages.find((s) => s.id === gate);
    const target = rejectTarget(gate, state, workflow);
    if (!target) die('no stage to send the run back to');
    const at = new Date().toISOString();
    state.rejections.push({ gate, reason: `escalation: ${String(note).trim()}`, at });
    const count = state.rejections.filter((r) => r.gate === gate).length;
    rewind(state, workflow, target);
    state.gates[gate] = { status: 'rejected', reason: String(note).trim(), rejected_at: at, rejections: count };
    state.current.attempt = count + 1;
    state.current.next_action = `Revise after escalation ("${String(note).trim()}"). ${state.current.next_action}`;
    saveState(state);
    appendEvent('escalation_reject', { gate, target });
    process.stdout.write(`${formatStatus(state)}\n`);
    return;
  }
  die(`unknown escalation action ${action} (list|retry|reject|abort)`);
}

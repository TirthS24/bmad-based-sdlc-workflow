// Run profiles (full, pm, dev, docs): which stages run, and what each stage may write.
// Stage order is resolved here so every caller skips the same stages.
import { appendEvent, stageById } from './io.mjs';
import { expandWritePatterns } from './globs.mjs';

export const DEFAULT_PROFILE = 'full';

export const profileNames = (workflow) => Object.keys(workflow.profiles || {});

export function profileName(state) {
  return state?.run?.profile || DEFAULT_PROFILE;
}

// The profile's settings, with its name. Runs from before profiles existed resolve to `full`.
export function profileOf(state, workflow) {
  const name = profileName(state);
  return { name, ...(workflow.profiles?.[name] || {}) };
}

const skipsStage = (profile, id) => (profile.skip || []).includes(id);

// The stage or gate after `fromId`, skipping whatever the profile skips. Skipped records are kept
// in state so the status and the PR body can show them.
export function nextStage(fromId, state, workflow) {
  const profile = profileOf(state, workflow);
  let id = stageById(workflow, fromId).next;
  while (skipsStage(profile, id)) {
    const stg = stageById(workflow, id);
    if (stg.executor === 'human') {
      if (state.gates[id]?.status !== 'approved') state.gates[id] = { status: 'skipped' };
    } else if (state.stages[id]?.status !== 'skipped') {
      state.stages[id] = { status: 'skipped', reason: `profile ${profile.name}` };
      appendEvent('stage_skipped', { stage: id });
    }
    id = stg.next;
  }
  return id;
}

// Where a rejected gate sends the run: its on_reject if the profile keeps it, else the nearest
// earlier stage that is neither a gate nor skipped.
export function rejectTarget(gate, state, workflow) {
  const profile = profileOf(state, workflow);
  const gateStage = stageById(workflow, gate);
  if (gateStage.on_reject && !skipsStage(profile, gateStage.on_reject)) return gateStage.on_reject;
  const ids = workflow.stages.map((s) => s.id);
  for (let i = ids.indexOf(gate) - 1; i >= 0; i -= 1) {
    const s = workflow.stages[i];
    if (s.executor !== 'human' && !skipsStage(profile, s.id)) return s.id;
  }
  return null;
}

// The write patterns that apply to a stage in this profile, with tokens expanded.
export function effectiveWrites(stageId, state, workflow, config) {
  const profile = profileOf(state, workflow);
  const raw = profile.writes?.[stageId] ?? stageById(workflow, stageId)?.writes ?? [];
  return expandWritePatterns(raw, config, state.run?.id);
}

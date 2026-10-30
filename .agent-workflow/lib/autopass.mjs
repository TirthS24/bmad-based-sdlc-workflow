// Auto-pass gates (4a.6). A profile may pass a gate without you when the common rules and the
// gate's condition hold. A declined auto-pass leaves the gate with you, and says why.
import fs from 'node:fs';
import path from 'node:path';
import { appendEvent, readText, sha256File, stageById } from './io.mjs';
import { matchesAnyGlob, productGlobs, writesAllowed } from './globs.mjs';
import { changedFiles } from './guards.mjs';
import { specDir } from './paths.mjs';
import { checkFeasibility, checkPlanning, checkReviewToVerify } from './postconditions.mjs';
import { effectiveWrites, nextStage, profileOf } from './profiles.mjs';
import { fillAction } from './state.mjs';
import { ticketsHash } from './tickets.mjs';

const ok = (reason, extra = {}) => ({ ok: true, reason, ...extra });
const no = (reason) => ({ ok: false, reason });
const sha = (file) => (fs.existsSync(file) ? sha256File(file) : null);

// `files:` entries may be globs. Check the directory part against the write patterns.
const sample = (f) => (f.includes('*') ? `${f.replace(/\*+$/, '').replace(/\/$/, '')}/_` : f);
const RESOLVED = /\[\s*resolved\s*\]/i;
const DECISION_NEEDED = /^\s*[-*]\s*(\[\s*decision-needed\s*\]|\*{0,2}decision-needed\*{0,2}\s*[:—-])/i;

// The `key: value` lines under the Decision heading (4a.6, "approach.md decision block").
export function decisionBlock(text) {
  const m = /^#{1,4}\s*(?:\d+[.)]?\s*)?\**Decision\b[^\n]*\n([\s\S]*?)(?=^#{1,4}\s|(?![\s\S]))/im.exec(text);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = /^\s*[-*]?\s*\**([A-Za-z_]+)\**\s*:\s*(.+?)\s*$/.exec(line);
    if (kv) out[kv[1].toLowerCase()] = kv[2].trim();
  }
  return out;
}

const CONDITIONS = {
  planning_clean(state) {
    const problems = checkPlanning(state);
    if (problems.length) return no(`planning: ${problems.length} problem(s), first: ${problems[0].rule} (${problems[0].found})`);
    return ok('planning is clean and every question is answered');
  },

  approach_low_risk(state, ctx) {
    const problems = checkFeasibility(state);
    if (problems.length) return no(`approach checks fail: ${problems[0].rule} (${problems[0].found})`);
    const text = readText(path.join(specDir(state), 'approach.md')) || '';
    const verdict = (/\b(as-is|with-changes|not-satisfiable)\b/i.exec(text)?.[1] || 'missing').toLowerCase();
    if (!['as-is', 'with-changes'].includes(verdict)) return no(`verdict is ${verdict}`);
    const block = decisionBlock(text);
    if (!block) return no('no decision block under the Decision heading');
    const rec = (block.recommended || '').toUpperCase();
    if (!['A', 'B', 'C'].includes(rec)) return no(`recommended is ${block.recommended || 'missing'}`);
    if (!new RegExp(`approach\\s+${rec}\\b`, 'i').test(text)) return no(`recommended ${rec} is not an approach in the file`);
    for (const key of ['public_contract_change', 'migration', 'new_dependency']) {
      const value = (block[key] || '').toLowerCase();
      if (value !== 'no') return no(`${key}: ${block[key] || 'missing'}`);
    }
    const files = (block.files || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!files.length) return no('no files listed in the decision block');
    const writes = effectiveWrites('implement', state, ctx.workflow, ctx.config);
    const outside = files.filter((f) => !writesAllowed(sample(f), writes) || matchesAnyGlob(sample(f), productGlobs(ctx.config)));
    if (outside.length) return no(`files outside scope: ${outside.join(', ')}`);
    return ok(`recommended ${rec}: no contract, migration or dependency change, files in scope`, { approach: rec });
  },

  red_for_right_reason(state) {
    const check = state.stages.tests?.check;
    if (check === 'red_ok') return ok('the new tests fail for the right reason');
    if (check === 'nothing_planned') return no('no automated regression test planned');
    return no('the tests stage has not recorded a red check');
  },

  no_open_high_or_decision(state, ctx) {
    const resultPath = state.stages.review?.result;
    const problems = checkReviewToVerify(resultPath, ctx.profile.skip || []);
    if (problems.length) return no(`${problems[0].rule}: ${problems[0].found}`);
    const open = (readText(resultPath) || '').split('\n').filter((l) => DECISION_NEEDED.test(l) && !RESOLVED.test(l));
    if (open.length) return no(`${open.length} open decision-needed finding(s): ${open[0].trim().slice(0, 60)}`);
    return ok('no open high or decision-needed findings');
  },

  specs_only_unchanged(state, ctx) {
    const allowed = (ctx.profile.pr_paths || []).map((g) => g.replace('<id>', state.run.id));
    const outside = changedFiles(state).filter((rel) => !matchesAnyGlob(rel, allowed));
    if (outside.length) return no(`changed outside specs: ${outside.slice(0, 3).join(', ')}`);
    const spec = state.gates.gate_spec || {};
    if (sha(path.join(specDir(state), 'SRS.md')) !== spec.spec_hash) return no('SRS.md changed since gate_spec');
    if (ticketsHash(state) !== spec.tickets_hash) return no('tickets changed since gate_spec');
    return ok('only specs changed, and the SRS and tickets match what gate_spec approved');
  },
};

// The decision for an auto gate: null when the profile does not auto-pass it.
export function evaluateAuto(gate, state, workflow, config) {
  const profile = profileOf(state, workflow);
  const condition = profile.auto?.[gate];
  if (!condition) return null;
  if (state.escalations?.length) return { passed: false, condition, reason: 'an escalation is pending' };
  if (state.rejections?.some((r) => r.gate === gate) || state.gates[gate]?.human) {
    return { passed: false, condition, reason: 'this gate was rejected or reset in this run; it stays with you' };
  }
  const check = CONDITIONS[condition];
  if (!check) return { passed: false, condition, reason: `unknown condition ${condition}` };
  const r = check(state, { workflow, config, profile });
  return { passed: r.ok, condition, reason: r.reason, approach: r.approach };
}

function recordAuto(state, gate, d) {
  const dir = specDir(state);
  state.gates[gate] = {
    status: 'approved',
    approved_by: 'auto',
    condition: d.condition,
    reason: d.reason,
    approved_at: new Date().toISOString(),
    ...(d.approach ? { approach: d.approach } : {}),
    spec_hash: sha(path.join(dir, 'SRS.md')),
    approach_hash: sha(path.join(dir, 'approach.md')),
    tickets_hash: ticketsHash(state),
  };
}

function setCurrent(state, stage, action) {
  state.current.stage = stage;
  state.current.attempt = 1;
  state.current.next_action = action;
}

// Moves the run past `fromId`: skips per profile, then passes the next gate if it is an auto gate
// whose rules hold. Returns the lines to print. A declined gate stays current, with the reason.
export function advanceAfter(fromId, state, workflow, config) {
  const notes = [];
  let next = nextStage(fromId, state, workflow);
  if (stageById(workflow, next)?.executor === 'human' && profileOf(state, workflow).auto?.[next]) {
    const d = evaluateAuto(next, state, workflow, config);
    if (d.passed) {
      recordAuto(state, next, d);
      appendEvent('approve', { gate: next, by: 'auto', condition: d.condition });
      notes.push(`✓ ${next} auto-passed: ${d.reason}`);
      next = nextStage(next, state, workflow);
    } else {
      state.gates[next].auto_declined = { condition: d.condition, reason: d.reason, at: new Date().toISOString() };
      appendEvent('gate_auto_declined', { gate: next, condition: d.condition });
      notes.push(`Auto-pass not applied to ${next}: ${d.reason}`);
      setCurrent(state, next, `${fillAction(next, state.run.id)} Auto-pass not applied: ${d.reason}`);
      return notes;
    }
  }
  setCurrent(state, next, fillAction(next, state.run.id));
  return notes;
}

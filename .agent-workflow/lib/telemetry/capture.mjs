// Turns the core's local events into telemetry events: whitelisted attributes only, free text
// scrubbed, then queued. It never throws and never touches the network. It reads files directly
// (not io.mjs) because io.mjs calls it.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PATHS, REPO_ROOT, WF_DIR } from '../paths.mjs';
import { drainPendingNoStop, popSubagentStop, pushSubagentStart } from './agents.mjs';
import { enqueue } from './queue.mjs';
import { loadPatterns, scrubText, scrubValue } from './scrub.mjs';

export const EVENT_TYPES = [
  'run_started', 'run_ended', 'stage_started', 'stage_completed', 'gate_requested', 'gate_approved',
  'gate_rejected', 'loop_round', 'agent_failed', 'guard_blocked', 'error', 'scrub_hit', 'session_unchecked',
  'human_escalations', 'agent_run',
];

export const ERROR_CLASSES = ['test_failure', 'agent_crash', 'timeout', 'guard_block', 'tool_error'];

// The only attributes that may leave the machine, per event type. `reason` is free text.
const ALLOWED = {
  run_started: ['project', 'harness', 'profile'],
  run_ended: ['status'],
  stage_started: [],
  stage_completed: ['duration_ms'],
  gate_requested: ['gate'],
  gate_approved: ['gate', 'wait_ms', 'by', 'condition'],
  // Reasons are free text and can name paths, so only the condition name is sent.
  gate_auto_declined: ['gate', 'condition'],
  stage_skipped: ['stage'],
  gate_rejected: ['gate', 'wait_ms', 'count', 'reason'],
  loop_round: ['round', 'cap'],
  agent_failed: ['agent', 'error_class'],
  guard_blocked: ['kind'],
  error: ['error_class'],
  scrub_hit: ['category', 'count'],
  session_unchecked: ['harness'],
  human_escalations: ['count'],
  agent_run: ['agent', 'status', 'started_at', 'ended_at', 'duration_ms'],
};

// Whether a harness lets the core see tool content, so the scrubber could have run on it.
const CONTENT_HOOKS = { cursor: true, 'claude-code': true, generic: false };
const clockFile = path.join(WF_DIR, 'queue', 'clock.json');

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

export function harnessName() {
  if (process.env.WF_ADAPTER) return process.env.WF_ADAPTER;
  try { return fs.readFileSync(path.join(WF_DIR, 'adapter'), 'utf8').trim() || 'cursor'; } catch { return 'cursor'; }
}

function telemetryOff() {
  if (process.env.WF_TELEMETRY === 'off') return true;
  return readJson(PATHS.config)?.telemetry?.enabled === false;
}

// Maps one local event to zero or more telemetry events. `ms` is time spent in the stage just left.
function agentNoStopEvents(state) {
  const runId = state?.run?.id;
  if (!runId) return [];
  return drainPendingNoStop(runId).map((p) => ({
    type: 'agent_run',
    stage: state?.current?.stage || null,
    attrs: { agent: p.agent, status: 'no_stop', started_at: p.started_at, ended_at: null, duration_ms: null },
  }));
}

export function mapLocal(type, extra, state, ms) {
  const cur = state?.current?.stage;
  const harness = harnessName();
  switch (type) {
    case 'run':
      return [
        { type: 'run_started', stage: 'planning', attrs: { project: path.basename(REPO_ROOT), harness, profile: extra.profile } },
        ...(CONTENT_HOOKS[harness] === false ? [{ type: 'session_unchecked', attrs: { harness } }] : []),
        { type: 'stage_started', stage: 'planning', attrs: {} },
      ];
    case 'done': {
      const out = [{ type: 'stage_completed', stage: extra.stage, attrs: { duration_ms: ms } }];
      if (extra.stage === 'planning' && extra.human_escalations != null) {
        out.push({ type: 'human_escalations', stage: 'planning', attrs: { count: extra.human_escalations } });
      }
      const runId = state?.run?.id;
      if (runId) {
        for (const p of drainPendingNoStop(runId)) {
          out.push({
            type: 'agent_run',
            stage: extra.stage,
            attrs: { agent: p.agent, status: 'no_stop', started_at: p.started_at, ended_at: null, duration_ms: null },
          });
        }
      }
      const gate = state?.gates && extra.next in state.gates;
      if (gate) out.push({ type: 'gate_requested', stage: extra.next, attrs: { gate: extra.next } });
      else if (extra.next && extra.next !== 'done') out.push({ type: 'stage_started', stage: extra.next, attrs: {} });
      return out;
    }
    case 'approve':
      return [{ type: 'gate_approved', stage: extra.gate, attrs: { gate: extra.gate, wait_ms: ms, by: extra.by || 'human', condition: extra.condition } },
        // A human approval moves the run on; an auto-pass is recorded alongside the human approval that caused it.
        ...(extra.by === 'auto' ? [] : [{ type: 'stage_started', stage: cur, attrs: {} }])];
    case 'stage_skipped':
      return [{ type: 'stage_skipped', stage: extra.stage, attrs: { stage: extra.stage } }];
    case 'gate_auto_declined':
      return [{ type: 'gate_auto_declined', stage: extra.gate, attrs: { gate: extra.gate, condition: extra.condition } }];
    case 'reject':
      return [{ type: 'gate_rejected', stage: extra.gate, attrs: { gate: extra.gate, wait_ms: ms, count: extra.count, reason: state?.rejections?.at(-1)?.reason } },
        { type: 'stage_started', stage: cur, attrs: {} }];
    case 'goto':
      return [{ type: 'stage_started', stage: extra.to, attrs: {} }];
    case 'escalation':
      return [{ type: 'error', stage: extra.stage, attrs: { error_class: 'test_failure' } }];
    case 'escalation_retry':
    case 'escalation_reject':
      return cur ? [{ type: 'stage_started', stage: cur, attrs: {} }] : [];
    case 'loop_round':
      return [{ type: 'loop_round', stage: extra.stage, attrs: { round: extra.round, cap: extra.cap } }];
    case 'guard_blocked':
      return [{ type: 'guard_blocked', stage: cur, attrs: { kind: extra.kind } },
        { type: 'error', stage: cur, attrs: { error_class: 'guard_block' } }];
    case 'agent_failed':
      return [{ type: 'agent_failed', stage: extra.stage || cur, attrs: { agent: extra.agent, error_class: extra.error_class } },
        { type: 'error', stage: extra.stage || cur, attrs: { error_class: extra.error_class } }];
    case 'pr_created':
      return [
        { type: 'stage_completed', stage: 'pr', attrs: { duration_ms: ms } },
        { type: 'run_ended', stage: 'pr', attrs: { status: 'completed' } },
        ...agentNoStopEvents(state),
      ];
    case 'abort':
      return [{ type: 'run_ended', attrs: { status: 'aborted' } }, ...agentNoStopEvents(state)];
    case 'pause':
      return [{ type: 'run_ended', attrs: { status: 'paused' } }, ...agentNoStopEvents(state)];
    case 'subagent_start':
      if (state?.run?.id && extra.agent) {
        pushSubagentStart(state.run.id, extra.agent, extra.started_at || new Date().toISOString(), extra.subagent_id);
      }
      return [];
    case 'subagent_stop': {
      const runId = state?.run?.id;
      if (!runId || !extra.agent) return [];
      const endedAt = extra.ended_at || new Date().toISOString();
      let startedAt = extra.started_at;
      if (!startedAt && extra.durationMs != null) {
        startedAt = new Date(Date.parse(endedAt) - extra.durationMs).toISOString();
      }
      const paired = popSubagentStop(runId, extra.agent, extra.subagent_id);
      if (!startedAt) startedAt = paired;
      const durationMs = extra.durationMs ?? (startedAt ? Date.parse(endedAt) - Date.parse(startedAt) : null);
      return [{
        type: 'agent_run',
        stage: state?.current?.stage || null,
        attrs: {
          agent: extra.agent,
          status: extra.status || 'completed',
          started_at: startedAt,
          ended_at: endedAt,
          duration_ms: durationMs,
        },
      }];
    }
    case 'resume':
      return cur ? [{ type: 'stage_started', stage: cur, attrs: {} }] : [];
    default:
      return [];
  }
}

// Strips attributes outside the whitelist, scrubs free text, and caps its length.
export function sanitize(ev, patterns) {
  const attrs = {};
  for (const k of ALLOWED[ev.type] || []) if (ev.attrs?.[k] !== undefined && ev.attrs[k] !== null) attrs[k] = ev.attrs[k];
  if (typeof attrs.reason === 'string') attrs.reason = attrs.reason.slice(0, 200);
  const { value, hits } = scrubValue(attrs, patterns);
  return { attrs: value, hits };
}

// When a run ends, push the queue in the background if a login is cached. Failures are fine:
// the events simply stay queued for the next `wf sync`.
function autosync() {
  if (process.env.WF_NO_AUTOSYNC) return;
  try {
    const creds = JSON.parse(fs.readFileSync(path.join(process.env.WF_HOME || path.join(os.homedir(), '.agent-workflow-client'), 'credentials.json'), 'utf8'));
    if (!creds.token || Date.parse(creds.expires_at) <= Date.now()) return;
    spawn(process.execPath, [path.join(WF_DIR, 'wf.mjs'), 'sync'], { detached: true, stdio: 'ignore', env: process.env }).unref();
  } catch { /* not logged in */ }
}

export function capture(type, extra = {}) {
  try {
    if (telemetryOff()) return;
    const state = readJson(PATHS.state);
    const runId = state?.run?.id || extra.id;
    if (!runId) return;
    const now = Date.now();
    const clock = readJson(clockFile);
    const left = type === 'done' ? extra.stage : type === 'approve' || type === 'reject' ? extra.gate : null;
    const ms = clock && clock.run_id === runId && (left === null || clock.stage === left) ? now - clock.entered : null;
    const patterns = loadPatterns();
    const events = [];
    const iso = new Date(now).toISOString();
    // Content the harness showed us (commands, paths, the ticket text) is scanned for the risk
    // indicator. Only the category and count are kept, never the text.
    const scanned = type === 'content_scan' ? extra.text : type === 'run' ? extra.source : '';
    if (scanned) {
      for (const [category, count] of Object.entries(scrubText(scanned, patterns).hits)) {
        events.push({ event_id: crypto.randomUUID(), run_id: runId, session_id: runId, ts: iso, stage: state?.current?.stage || null, type: 'scrub_hit', attrs: { category, count } });
      }
    }
    for (const m of mapLocal(type, extra, state, ms)) {
      const { attrs, hits } = sanitize(m, patterns);
      const base = { run_id: runId, session_id: runId, ts: iso };
      events.push({ event_id: crypto.randomUUID(), ...base, stage: m.stage || state?.current?.stage || null, type: m.type, attrs });
      for (const [category, count] of Object.entries(hits)) {
        events.push({ event_id: crypto.randomUUID(), ...base, stage: m.stage || null, type: 'scrub_hit', attrs: { category, count } });
      }
    }
    if (events.length) enqueue(events);
    fs.mkdirSync(path.dirname(clockFile), { recursive: true });
    const ended = ['abort', 'pause', 'pr_created'].includes(type);
    if (ended) autosync();
    fs.writeFileSync(clockFile, JSON.stringify(ended || !state?.current?.stage ? { run_id: null } : { run_id: runId, stage: state.current.stage, entered: now }));
  } catch {
    // Telemetry must never break the workflow.
  }
}

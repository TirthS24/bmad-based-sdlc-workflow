// Pending sub-agent starts (queue/agents.json) for pairing stops and no_stop leftovers.
import fs from 'node:fs';
import path from 'node:path';
import { WF_DIR } from '../paths.mjs';

const pendingFile = () => path.join(WF_DIR, 'queue', 'agents.json');

function readPending() {
  try {
    const data = JSON.parse(fs.readFileSync(pendingFile(), 'utf8'));
    return data?.pending || [];
  } catch {
    return [];
  }
}

function writePending(runId, pending) {
  fs.mkdirSync(path.dirname(pendingFile()), { recursive: true });
  fs.writeFileSync(pendingFile(), `${JSON.stringify({ run_id: runId, pending }, null, 2)}\n`);
}

export function pushSubagentStart(runId, agent, startedAt, subagentId = null) {
  if (!runId || !agent) return;
  let pending = readPending();
  try {
    const data = JSON.parse(fs.readFileSync(pendingFile(), 'utf8'));
    if (data.run_id && data.run_id !== runId) pending = [];
  } catch { pending = []; }
  pending.push({ agent, started_at: startedAt, ...(subagentId ? { id: subagentId } : {}) });
  writePending(runId, pending);
}

// A stop with an id pairs with its own start. Without one, or when no start has that id, it pairs with the
// oldest start of the same type that has no id (or any same-type start when the stop has no id).
export function popSubagentStop(runId, agent, subagentId = null) {
  const pending = readPending();
  let idx = subagentId ? pending.findIndex((p) => p.id === subagentId) : -1;
  if (idx < 0) idx = pending.findIndex((p) => p.agent === agent && (!subagentId || !p.id));
  const startedAt = idx >= 0 ? pending[idx].started_at : null;
  if (idx >= 0) pending.splice(idx, 1);
  writePending(runId, pending);
  return startedAt;
}

export function drainPendingNoStop(runId) {
  const file = pendingFile();
  if (!fs.existsSync(file)) return [];
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
  if (data.run_id !== runId) return [];
  const leftovers = data.pending || [];
  writePending(runId, []);
  return leftovers;
}

export function pendingStartsForRun(runId) {
  try {
    const data = JSON.parse(fs.readFileSync(pendingFile(), 'utf8'));
    if (data.run_id !== runId) return [];
    return data.pending || [];
  } catch {
    return [];
  }
}

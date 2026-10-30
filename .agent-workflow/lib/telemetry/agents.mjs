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

export function pushSubagentStart(runId, agent, startedAt) {
  if (!runId || !agent) return;
  let pending = readPending();
  try {
    const data = JSON.parse(fs.readFileSync(pendingFile(), 'utf8'));
    if (data.run_id && data.run_id !== runId) pending = [];
  } catch { pending = []; }
  pending.push({ agent, started_at: startedAt });
  writePending(runId, pending);
}

export function popSubagentStop(runId, agent) {
  const pending = readPending();
  const idx = pending.findIndex((p) => p.agent === agent);
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

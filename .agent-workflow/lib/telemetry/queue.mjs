// Local event queue: JSONL files under .agent-workflow/queue/. Events append to current.jsonl,
// which is sealed into batch files. A batch is deleted only after the server acknowledges it.
// The one exception is the retention cap, which evicts the oldest batches and counts them.
import fs from 'node:fs';
import path from 'node:path';
import { WF_DIR } from '../paths.mjs';

export const QUEUE_DIR = path.join(WF_DIR, 'queue');
const CURRENT = path.join(QUEUE_DIR, 'current.jsonl');
const META = path.join(QUEUE_DIR, 'meta.json');
const SEAL_BYTES = 64 * 1024;

export const DEFAULT_CAPS = { maxAgeMs: 14 * 24 * 3600 * 1000, maxBytes: 5 * 1024 * 1024 };

const readMeta = () => { try { return JSON.parse(fs.readFileSync(META, 'utf8')); } catch { return { dropped_events: 0 }; } };
const writeMeta = (m) => fs.writeFileSync(META, JSON.stringify(m));

// A crash can leave a torn last line. Start the next event on a fresh line so it stays parseable.
function needsNewline(file) {
  if (!fs.existsSync(file)) return false;
  const size = fs.statSync(file).size;
  if (!size) return false;
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(1);
  fs.readSync(fd, buf, 0, 1, size - 1);
  fs.closeSync(fd);
  return buf[0] !== 0x0a;
}

export function enqueue(events) {
  fs.mkdirSync(QUEUE_DIR, { recursive: true });
  const lead = needsNewline(CURRENT) ? '\n' : '';
  fs.appendFileSync(CURRENT, lead + events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  if (fs.statSync(CURRENT).size >= SEAL_BYTES) seal();
}

export function seal() {
  if (!fs.existsSync(CURRENT) || !fs.statSync(CURRENT).size) return null;
  const name = `batch-${String(Date.now()).padStart(15, '0')}-${Math.random().toString(36).slice(2, 8)}.jsonl`;
  fs.renameSync(CURRENT, path.join(QUEUE_DIR, name));
  return name;
}

export function listBatches() {
  if (!fs.existsSync(QUEUE_DIR)) return [];
  return fs.readdirSync(QUEUE_DIR).filter((f) => f.startsWith('batch-')).sort();
}

// Parses a batch, skipping torn lines and repeated event ids.
export function readBatch(name) {
  const seen = new Set();
  const out = [];
  for (const line of fs.readFileSync(path.join(QUEUE_DIR, name), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e?.event_id && !seen.has(e.event_id)) { seen.add(e.event_id); out.push(e); }
    } catch { /* torn line from a crash */ }
  }
  return out;
}

export const ackBatch = (name) => fs.rmSync(path.join(QUEUE_DIR, name), { force: true });

// Keeps only `events` in a batch (those the server has not accounted for yet).
export function rewriteBatch(name, events) {
  const file = path.join(QUEUE_DIR, name);
  if (!events.length) return fs.rmSync(file, { force: true });
  fs.writeFileSync(`${file}.tmp`, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.renameSync(`${file}.tmp`, file);
}

// Retention cap by age and total size. Evicts oldest sealed batches first and counts what it drops.
export function enforceCaps(caps = DEFAULT_CAPS, now = Date.now()) {
  seal();
  let dropped = 0;
  const drop = (name) => { dropped += readBatch(name).length; ackBatch(name); };
  for (const name of listBatches()) {
    const t = parseInt(name.split('-')[1], 10);
    if (now - t > caps.maxAgeMs) drop(name);
  }
  let size = 0;
  const sizes = Object.fromEntries(listBatches().map((n) => [n, fs.statSync(path.join(QUEUE_DIR, n)).size]));
  for (const n of Object.keys(sizes)) size += sizes[n];
  for (const name of listBatches()) {
    if (size <= caps.maxBytes) break;
    size -= sizes[name];
    drop(name);
  }
  if (dropped) {
    const meta = readMeta();
    meta.dropped_events = (meta.dropped_events || 0) + dropped;
    writeMeta(meta);
  }
  return dropped;
}

export function queueStats() {
  const batches = listBatches();
  const pendingCurrent = fs.existsSync(CURRENT) ? readBatchFile(CURRENT).length : 0;
  return {
    batches: batches.length,
    events: batches.reduce((n, b) => n + readBatch(b).length, 0) + pendingCurrent,
    dropped_events: readMeta().dropped_events || 0,
  };
}

function readBatchFile(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => { try { return l.trim() && JSON.parse(l); } catch { return false; } });
}

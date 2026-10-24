// File, state and event I/O. appendEvent is the single event sink.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PATHS, REPO_ROOT } from './paths.mjs';

export function die(msg, code = 1) {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

export function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
}

export function loadWorkflow() {
  const wf = readJson(PATHS.workflow);
  if (!wf?.stages) die(`missing workflow: ${PATHS.workflow}`);
  return wf;
}

export function loadConfig() {
  const cfg = readJson(PATHS.config);
  if (!cfg) die(`missing config: ${PATHS.config}`);
  return cfg;
}

export function loadState() {
  return readJson(PATHS.state, null);
}

export function saveState(state) {
  writeJson(PATHS.state, state);
}

export function appendEvent(type, extra = {}) {
  fs.mkdirSync(path.dirname(PATHS.events), { recursive: true });
  const line = JSON.stringify({ ts: new Date().toISOString(), type, ...extra });
  fs.appendFileSync(PATHS.events, `${line}\n`);
}

export function stageById(workflow, id) {
  return workflow.stages.find((s) => s.id === id);
}

export function sha256Bytes(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function sha256File(file) {
  return sha256Bytes(fs.readFileSync(file));
}

export function readText(relOrAbs) {
  const full = path.isAbsolute(relOrAbs) ? relOrAbs : path.join(REPO_ROOT, relOrAbs);
  if (!fs.existsSync(full)) return null;
  return fs.readFileSync(full, 'utf8');
}

export function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

export function parseHookPayload(raw) {
  const text = (raw || '').trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}

export function git(args, opts = {}) {
  return spawnSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    ...opts,
  });
}

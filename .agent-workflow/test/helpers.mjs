// Test helpers: run wf.mjs against a throwaway git repo so tests never touch
// the real state.json, events.jsonl or runs/.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WF_ENTRY = path.join(SRC_DIR, 'wf.mjs');

const GIT = ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false'];

export const VALID_SPEC = `# Spec
## Capabilities
- **REQ-1** Do the thing
  - **success:** it works
`;

export const VALID_APPROACH = `# Approach
Verdict: with-changes
## Approach A
Small change.
## Approach B
Bigger change.
Fits in one commit.
`;

export const VALID_TEST_PLAN = `# Test plan
- PRD-1.1 REQ-1 happy path (e2e, automated)
`;

export function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-test-'));
  const wfDir = path.join(root, '.agent-workflow');
  fs.mkdirSync(wfDir, { recursive: true });
  for (const f of ['workflow.json', 'config.json', 'bmad-allowlist.json']) {
    fs.copyFileSync(path.join(SRC_DIR, f), path.join(wfDir, f));
  }
  const git = (...args) => spawnSync('git', [...GIT, ...args], { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  git('commit', '--allow-empty', '-q', '-m', 'init');

  const env = { ...process.env, WF_DIR: wfDir, REPO_ROOT: root };
  const repo = {
    root,
    wfDir,
    git,
    run(args, { input = '', env: extra = {} } = {}) {
      const res = spawnSync(process.execPath, [WF_ENTRY, ...args], {
        cwd: root,
        env: { ...env, ...extra },
        input,
        encoding: 'utf8',
      });
      return { status: res.status, stdout: res.stdout, stderr: res.stderr };
    },
    guard(event, payload = {}) {
      const res = repo.run(['guard', event], { input: JSON.stringify(payload) });
      let body = null;
      try { body = JSON.parse(res.stdout); } catch { /* leave null */ }
      return { ...res, body };
    },
    file(rel, content) {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    },
    read(rel) {
      return fs.readFileSync(path.join(root, rel), 'utf8');
    },
    exists(rel) {
      return fs.existsSync(path.join(root, rel));
    },
    state() {
      return JSON.parse(fs.readFileSync(path.join(wfDir, 'state.json'), 'utf8'));
    },
    hasState() {
      return fs.existsSync(path.join(wfDir, 'state.json'));
    },
    update(fn) {
      const s = repo.state();
      fn(s);
      fs.writeFileSync(path.join(wfDir, 'state.json'), `${JSON.stringify(s, null, 2)}\n`);
    },
    setStage(stage) {
      repo.update((s) => { s.current.stage = stage; });
    },
    config(patch) {
      const file = path.join(wfDir, 'config.json');
      const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [k, v] of Object.entries(patch)) {
        cfg[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? { ...cfg[k], ...v } : v;
      }
      fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
    },
    events() {
      const file = path.join(wfDir, 'events.jsonl');
      if (!fs.existsSync(file)) return [];
      return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    },
    startRun(name = 'feat') {
      const res = repo.run(['run', name]);
      if (res.status !== 0) throw new Error(`run failed: ${res.stderr}`);
      return repo.state().run.id;
    },
    commit(msg = 'change') {
      repo.file(`c-${Date.now()}-${Math.random()}.txt`, msg);
      git('add', '-A');
      git('commit', '-q', '-m', msg);
    },
    seedSpecs(id) {
      repo.file(`specs/spec-${id}/SPEC.md`, VALID_SPEC);
      repo.file(`specs/spec-${id}/approach.md`, VALID_APPROACH);
      repo.file(`specs/spec-${id}/test-plan.md`, VALID_TEST_PLAN);
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
  return repo;
}

// Convenience: a repo with an active run, cleaned up automatically.
export function withRun(t, name) {
  const repo = makeRepo();
  t.after(() => repo.cleanup());
  const id = repo.startRun(name);
  return { repo, id };
}

export function fresh(t) {
  const repo = makeRepo();
  t.after(() => repo.cleanup());
  return repo;
}

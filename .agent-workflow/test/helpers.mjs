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
## Non-goals
- Nothing else.
`;

export const VALID_SRS = `# SRS
## 1 Introduction
Purpose: deliver the capability.
## 2 Overall description
One user class.
## 3 Functional requirements
- **REQ-1** Do the thing
  intent: do it
  success: it works
## 4 External interfaces
Web UI
## 5 Non-functional
Basic security
## 6 Non-goals
- Nothing else.
## 7 Traceability
REQ-1 → Q-1
`;

export const VALID_QUESTIONS = [
  {
    id: 'Q-1',
    round: 1,
    question: 'Confirm scope?',
    options: ['yes'],
    req_refs: ['REQ-1'],
    status: 'answered',
    answer: 'yes',
    answered_by: 'human',
    sources: [],
  },
];

export const VALID_TICKET_BE = {
  id: 'TKT-BE-001',
  persona: 'be',
  title: 'Backend',
  purpose: 'API',
  description: 'Implement REQ-1',
  priority: 'P1',
  requirements: ['REQ-1'],
  depends_on: [],
  acceptance_criteria: [{
    id: 'AC-1',
    text: 'Works',
    test_cases: [{
      id: 'PRD-1.1',
      title: 'Happy path',
      given: 'system up',
      when: 'user acts',
      then: 'it works',
      layer: 'ui',
      automation: 'manual',
    }],
  }],
  external: { jira_key: null },
};

export const VALID_TICKET_FE = {
  id: 'TKT-FE-001',
  persona: 'fe',
  title: 'Frontend',
  purpose: 'UI',
  description: 'Surface REQ-1',
  priority: 'P1',
  requirements: ['REQ-1'],
  depends_on: [],
  acceptance_criteria: [{
    id: 'AC-1',
    text: 'Shows outcome',
    test_cases: [{
      id: 'PRD-1.2',
      title: 'UI shows success',
      given: 'page open',
      when: 'action',
      then: 'success visible',
      layer: 'ui',
      automation: 'manual',
    }],
  }],
  external: { jira_key: null },
};

export const ADR = `## Decision
Approach A: smallest change that works.
## Non-functional
- N/A, no load or data change.
## Risks
- Low.
## Rollback
- Revert the commit.
`;

export const AXES = '## Standards\nopen: 0\n## Spec conformance\nopen: 0\n## Approach conformance\nopen: 0\n## Test quality\nopen: 0\n';

export const VALID_APPROACH = `# Approach
Verdict: with-changes
## Approach A
Small change.
## Approach B
Bigger change.
Fits in one commit.
${ADR}`;

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
  // Baseline config for the older tests: one flat test_globs list (read as product tests)
  // and no product/unit split. Phase 2 tests override with repo.config().
  const cfgFile = path.join(wfDir, 'config.json');
  const base = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  delete base.product_test_globs;
  delete base.unit_test_globs;
  base.test_globs = ['tests/**/*.py', '**/*.test.ts', '**/*.test.js', 'E2E/tests/**/*.spec.ts'];
  base.commands = { ...base.commands, unit: 'pytest', lint: 'yarn lint' };
  fs.writeFileSync(cfgFile, JSON.stringify(base, null, 2));
  const git = (...args) => spawnSync('git', [...GIT, ...args], { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  git('commit', '--allow-empty', '-q', '-m', 'init');

  const env = { ...process.env, WF_DIR: wfDir, REPO_ROOT: root, WF_NO_AUTOSYNC: '1' };
  const prevRoot = process.env.REPO_ROOT;
  const prevWf = process.env.WF_DIR;
  process.env.REPO_ROOT = root;
  process.env.WF_DIR = wfDir;
  const repo = {
    root,
    wfDir,
    env,
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
      this.seedPlanning(id);
      repo.file(`specs/spec-${id}/approach.md`, VALID_APPROACH);
    },
    seedPlanning(id) {
      const base = `specs/spec-${id}`;
      repo.file(`${base}/SRS.md`, VALID_SRS);
      repo.file(`${base}/grill/questions.json`, `${JSON.stringify(VALID_QUESTIONS, null, 2)}\n`);
      repo.file(`${base}/tickets/be/TKT-BE-001.json`, `${JSON.stringify(VALID_TICKET_BE, null, 2)}\n`);
      repo.file(`${base}/tickets/fe/TKT-FE-001.json`, `${JSON.stringify(VALID_TICKET_FE, null, 2)}\n`);
    },
    // A local bare repo as `origin`, and a fake `gh` on PATH that records its arguments.
    addRemoteAndFakeGh({ ghExit = 0, ghOut = 'https://github.com/acme/app/pull/7' } = {}) {
      const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-remote-'));
      spawnSync('git', ['init', '--bare', '-q', remote]);
      git('remote', 'add', 'origin', remote);
      const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-bin-'));
      const log = path.join(bin, 'gh.log');
      fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}"\necho "${ghOut}"\nexit ${ghExit}\n`, { mode: 0o755 });
      env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
      return {
        remote,
        ghArgs: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : null),
        remoteBranches: () => spawnSync('git', ['--git-dir', remote, 'branch', '--list'], { encoding: 'utf8' }).stdout,
        cleanup: () => { fs.rmSync(remote, { recursive: true, force: true }); fs.rmSync(bin, { recursive: true, force: true }); },
      };
    },
    cleanup() {
      if (prevRoot === undefined) delete process.env.REPO_ROOT;
      else process.env.REPO_ROOT = prevRoot;
      if (prevWf === undefined) delete process.env.WF_DIR;
      else process.env.WF_DIR = prevWf;
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

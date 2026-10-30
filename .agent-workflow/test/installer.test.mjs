// Phase 7: install into an empty project for each harness, upgrade without clobbering, and the
// git-hook fallback for harnesses with no hooks.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INSTALL = path.join(ROOT, 'installer', 'install.mjs');
const GIT = ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false'];

function project(t, { git = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-install-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (git) {
    spawnSync('git', ['init', '-q'], { cwd: dir });
    spawnSync('git', [...GIT, 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: dir });
  }
  return dir;
}
const install = (dir, harness, extra = []) => spawnSync(process.execPath, [INSTALL, '--target', dir, '--harness', harness, ...extra], { encoding: 'utf8' });
const wf = (dir, args, opts = {}) => spawnSync(process.execPath, [path.join(dir, '.agent-workflow', 'wf.mjs'), ...args], {
  cwd: dir, encoding: 'utf8', env: { ...process.env, WF_DIR: undefined, REPO_ROOT: undefined, WF_NO_AUTOSYNC: '1', WF_HOME: path.join(dir, '.home'), ...opts.env }, input: opts.input,
});
const json = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

const LAYOUT = {
  cursor: { skills: '.cursor/skills', agents: '.cursor/agents', conductor: 'AGENTS.md' },
  'claude-code': { skills: '.claude/skills', agents: '.claude/agents', conductor: 'CLAUDE.md' },
  generic: { skills: '.agents/skills', agents: '.agents/agents', conductor: 'AGENTS.md' },
};

for (const [harness, l] of Object.entries(LAYOUT)) {
  test(`[${harness}] one command installs a working workflow into an empty project`, (t) => {
    const dir = project(t);
    const res = install(dir, harness);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /installed 0\.1\.0/);
    assert.match(res.stdout, /wf\.mjs init/);

    for (const f of ['wf.mjs', 'workflow.json', 'capabilities.json', 'standards.md', 'lib/commands.mjs', 'adapters/claude-code.mjs', 'rules/generic.md', 'rules/python.md', 'VERSION']) {
      assert.ok(fs.existsSync(path.join(dir, '.agent-workflow', f)), f);
    }
    assert.ok(!fs.existsSync(path.join(dir, '.agent-workflow', 'test')), 'tests are not installed');
    assert.equal(fs.readFileSync(path.join(dir, '.agent-workflow', 'adapter'), 'utf8').trim(), harness);
    assert.ok(fs.existsSync(path.join(dir, l.skills, 'wf-start', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(dir, l.agents, 'code-reviewer.md')));
    assert.match(fs.readFileSync(path.join(dir, l.conductor), 'utf8'), /Conductor rules/);

    const ignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    for (const line of ['.agent-workflow/state.json', '.agent-workflow/queue/', '.agent-workflow/runs/']) assert.ok(ignore.includes(line), line);

    const doctor = wf(dir, ['doctor']);
    assert.equal(doctor.status, 0, doctor.stderr);
    const init = wf(dir, ['init']);
    assert.equal(init.status, 0, init.stderr);
    assert.equal(wf(dir, ['run', 'first feature']).status, 0);
  });
}

test('cursor and claude-code get their hook wiring; generic gets git hooks and CI', (t) => {
  const cur = project(t);
  install(cur, 'cursor');
  const hooks = json(path.join(cur, '.cursor', 'hooks.json')).hooks;
  assert.ok(hooks.preToolUse.some((h) => h.command === 'node .agent-workflow/wf.mjs guard preToolUse'));
  assert.ok(hooks.stop.some((h) => h.command === 'node .agent-workflow/wf.mjs guard stop'));

  const cc = project(t);
  install(cc, 'claude-code');
  const settings = json(path.join(cc, '.claude', 'settings.json')).hooks;
  assert.equal(settings.PreToolUse.length, 2);
  assert.equal(settings.PreToolUse[1].matcher, 'Bash');
  assert.ok(settings.Stop[0].hooks[0].command.endsWith('guard stop'));
  assert.ok(settings.SessionStart && settings.PostToolUse);

  const gen = project(t);
  install(gen, 'generic');
  for (const f of ['pre-commit', 'pre-push']) {
    const p = path.join(gen, '.githooks', f);
    assert.ok(fs.statSync(p).mode & 0o100, `${f} is executable`);
    assert.match(fs.readFileSync(p, 'utf8'), /gate-check/);
  }
  assert.match(fs.readFileSync(path.join(gen, '.github', 'workflows', 'wf-gate.yml'), 'utf8'), /ci-check/);
  assert.equal(spawnSync('git', ['config', 'core.hooksPath'], { cwd: gen, encoding: 'utf8' }).stdout.trim(), '.githooks');
});

test('upgrade: core is refreshed, the project\'s own files are untouched', (t) => {
  const dir = project(t);
  install(dir, 'claude-code', ['--server', 'http://localhost:8787']);
  const wfDir = path.join(dir, '.agent-workflow');

  const cfg = json(path.join(wfDir, 'config.json'));
  assert.deepEqual(cfg.telemetry, { enabled: true, server_url: 'http://localhost:8787', required: true });
  cfg.commands.unit = 'make test';
  cfg.src_globs = ['custom/**'];
  fs.writeFileSync(path.join(wfDir, 'config.json'), JSON.stringify(cfg));
  fs.writeFileSync(path.join(wfDir, 'project.json'), '{"mine":true}');
  fs.mkdirSync(path.join(wfDir, 'context'), { recursive: true });
  fs.writeFileSync(path.join(wfDir, 'context', 'project-context.md'), '## Stack\nmine\n');
  fs.writeFileSync(path.join(wfDir, 'rules', 'go.md'), '# my drafted pack\n');
  fs.writeFileSync(path.join(wfDir, 'scrub-patterns.json'), '{"patterns":[]}');
  fs.writeFileSync(path.join(wfDir, 'lib', 'commands.mjs'), '// tampered\n');
  fs.writeFileSync(path.join(wfDir, 'rules', 'python.md'), '# tampered\n');
  fs.writeFileSync(path.join(dir, '.claude', 'skills', 'wf-start', 'SKILL.md'), 'old skill text');
  const claudeMd = path.join(dir, 'CLAUDE.md');
  fs.writeFileSync(claudeMd, `# My project\n\nKeep this.\n\n${fs.readFileSync(claudeMd, 'utf8')}\n## My own section\nand this.\n`);
  const settingsFile = path.join(dir, '.claude', 'settings.json');
  const settings = json(settingsFile);
  settings.permissions = { allow: ['Bash(npm test)'] };
  settings.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] });
  fs.writeFileSync(settingsFile, JSON.stringify(settings));

  fs.writeFileSync(path.join(wfDir, 'VERSION'), '0.0.9\n');
  const res = install(dir, 'claude-code', ['--server', 'http://other:1']);
  assert.match(res.stdout, /upgraded 0\.0\.9 -> 0\.1\.0/);

  const after = json(path.join(wfDir, 'config.json'));
  assert.equal(after.commands.unit, 'make test');
  assert.deepEqual(after.src_globs, ['custom/**']);
  assert.equal(after.telemetry.server_url, 'http://localhost:8787', 'a configured server is not replaced');
  assert.equal(fs.readFileSync(path.join(wfDir, 'project.json'), 'utf8'), '{"mine":true}');
  assert.equal(fs.readFileSync(path.join(wfDir, 'context', 'project-context.md'), 'utf8'), '## Stack\nmine\n');
  assert.equal(fs.readFileSync(path.join(wfDir, 'rules', 'go.md'), 'utf8'), '# my drafted pack\n');
  assert.equal(fs.readFileSync(path.join(wfDir, 'scrub-patterns.json'), 'utf8'), '{"patterns":[]}');

  assert.notEqual(fs.readFileSync(path.join(wfDir, 'lib', 'commands.mjs'), 'utf8'), '// tampered\n', 'core restored');
  assert.notEqual(fs.readFileSync(path.join(wfDir, 'rules', 'python.md'), 'utf8'), '# tampered\n', 'shipped pack restored');
  assert.notEqual(fs.readFileSync(path.join(dir, '.claude', 'skills', 'wf-start', 'SKILL.md'), 'utf8'), 'old skill text');

  const md = fs.readFileSync(claudeMd, 'utf8');
  assert.match(md, /# My project\n\nKeep this\./);
  assert.match(md, /## My own section\nand this\./);
  assert.equal(md.split('<!-- wf:begin').length - 1, 1, 'one managed block, not two');

  const merged = json(settingsFile);
  assert.deepEqual(merged.permissions, { allow: ['Bash(npm test)'] });
  assert.ok(merged.hooks.PreToolUse.some((e) => e.hooks.some((h) => h.command === 'echo mine')));
  assert.equal(merged.hooks.PreToolUse.filter((e) => e.hooks.some((h) => h.command.includes('guard preToolUse'))).length, 1, 'no duplicate hooks');
  assert.equal(wf(dir, ['doctor']).status, 0);
});

test('existing cursor hooks and a gitignore are merged, not replaced', (t) => {
  const dir = project(t);
  fs.mkdirSync(path.join(dir, '.cursor'));
  fs.writeFileSync(path.join(dir, '.cursor', 'hooks.json'), JSON.stringify({ version: 1, hooks: { stop: [{ command: 'echo mine' }] } }));
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
  install(dir, 'cursor');
  install(dir, 'cursor');
  const stop = json(path.join(dir, '.cursor', 'hooks.json')).hooks.stop;
  assert.deepEqual(stop.map((h) => h.command), ['echo mine', 'node .agent-workflow/wf.mjs guard stop']);
  const ignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
  assert.ok(ignore.startsWith('node_modules/\n'));
  assert.equal(ignore.split('.agent-workflow/queue/').length - 1, 1);
});

test('bad input: unknown harness and missing target fail without writing anything', (t) => {
  const dir = project(t);
  const bad = install(dir, 'hermes');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /unknown harness "hermes"/);
  assert.ok(!fs.existsSync(path.join(dir, '.agent-workflow')));
  assert.equal(install(path.join(dir, 'nope'), 'cursor').status, 1);
});

// ---- generic fallback: git hooks and CI ---------------------------------------------------

test('generic: git hooks block a commit before the final gate and let it through after', (t) => {
  const dir = project(t);
  install(dir, 'generic');
  assert.equal(wf(dir, ['run', 'feat']).status, 0);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
  spawnSync('git', ['add', 'a.txt'], { cwd: dir });
  const blocked = spawnSync('git', [...GIT, 'commit', '-q', '-m', 'early'], { cwd: dir, encoding: 'utf8', env: { ...process.env, WF_NO_AUTOSYNC: '1' } });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /blocked until gate_final is approved/);
  const state = json(path.join(dir, '.agent-workflow', 'state.json'));
  state.gates.gate_final = { status: 'approved' };
  fs.writeFileSync(path.join(dir, '.agent-workflow', 'state.json'), JSON.stringify(state));
  const ok = spawnSync('git', [...GIT, 'commit', '-q', '-m', 'late'], { cwd: dir, encoding: 'utf8', env: { ...process.env, WF_NO_AUTOSYNC: '1' } });
  assert.equal(ok.status, 0, ok.stderr);
});

test('gate-check: no run means nothing is blocked; protected files and changed frozen tests are', (t) => {
  const dir = project(t);
  install(dir, 'generic');
  assert.equal(wf(dir, ['gate-check']).status, 0);
  wf(dir, ['run', 'feat']);
  const stateFile = path.join(dir, '.agent-workflow', 'state.json');
  const state = json(stateFile);
  state.gates.gate_final = { status: 'approved' };
  fs.writeFileSync(stateFile, JSON.stringify(state));
  assert.equal(wf(dir, ['gate-check']).status, 0);

  fs.writeFileSync(path.join(dir, '.agent-workflow', 'workflow.json.bak'), 'x');
  spawnSync('git', ['add', '-f', '.agent-workflow/workflow.json'], { cwd: dir });
  assert.match(wf(dir, ['gate-check']).stderr, /protected file staged: \.agent-workflow\/workflow\.json/);
  spawnSync('git', ['reset', '-q'], { cwd: dir });

  fs.mkdirSync(path.join(dir, 'E2E', 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'E2E', 'tests', 'a.spec.ts'), 'v1');
  const s2 = json(stateFile);
  s2.freeze.test_files_hash = 'stale';
  fs.writeFileSync(stateFile, JSON.stringify(s2));
  assert.match(wf(dir, ['gate-check']).stderr, /frozen product tests changed/);
});

test('ci-check: passes on a healthy install and fails when the capability set is broken', (t) => {
  const dir = project(t);
  install(dir, 'generic');
  assert.match(wf(dir, ['ci-check']).stdout, /ci-check: ok/);
  fs.rmSync(path.join(dir, '.agents', 'skills', 'wf-verify'), { recursive: true });
  const bad = wf(dir, ['ci-check']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /skill wf-verify not found/);
});

test('ci-check: a pull request that edits a protected workflow file is refused', (t) => {
  const dir = project(t);
  install(dir, 'generic');
  spawnSync('git', ['add', '-A'], { cwd: dir });
  spawnSync('git', [...GIT, 'commit', '-q', '-m', 'install', '--no-verify'], { cwd: dir });
  spawnSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: dir });
  fs.appendFileSync(path.join(dir, '.agent-workflow', 'workflow.json'), ' ');
  spawnSync('git', ['add', '-A'], { cwd: dir });
  spawnSync('git', [...GIT, 'commit', '-q', '-m', 'edit workflow', '--no-verify'], { cwd: dir });
  const res = wf(dir, ['ci-check'], { env: { GITHUB_BASE_REF: 'main' } });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /changes a protected workflow file: \.agent-workflow\/workflow\.json/);
});

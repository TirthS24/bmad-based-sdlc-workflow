// `wf init`: detect the project's stack from key files and record the facts in
// project.json. Detection is deterministic. Writing the project context and
// drafting rule packs for new stacks is the agent's job (/wf-onboard); this
// module only checks that the work was done and that a human approved the packs.
import fs from 'node:fs';
import path from 'node:path';
import { appendEvent, loadConfig, loadState, readJson, sha256File, writeJson, die } from './io.mjs';
import { PATHS, REPO_ROOT, WF_DIR } from './paths.mjs';
import { loginProblem } from './telemetry/client.mjs';

export const PROJECT_FILE = path.join(WF_DIR, 'project.json');
export const RULES_DIR = path.join(WF_DIR, 'rules');
export const CONTEXT_FILE = path.join(WF_DIR, 'context', 'project-context.md');
export const CONTEXT_HEADINGS = ['Stack', 'Layout', 'Commands', 'Conventions'];

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'venv', '.venv', '__pycache__', 'graphify-out', 'specs']);
const MARKERS = [
  [/^(pyproject\.toml|requirements\.txt|Pipfile|setup\.py)$/, 'python'],
  [/^pom\.xml$/, 'java-maven'],
  [/^build\.gradle(\.kts)?$/, 'java-gradle'],
  [/^go\.mod$/, 'go'],
  [/^Cargo\.toml$/, 'rust'],
  [/^Gemfile$/, 'ruby'],
  [/^composer\.json$/, 'php'],
  [/\.(csproj|sln)$/, 'dotnet'],
];
const TEST_COMMANDS = {
  python: 'pytest',
  'java-maven': 'mvn -q test',
  'java-gradle': './gradlew test',
  go: 'go test ./...',
  rust: 'cargo test',
};

function nodeStack(pkgPath) {
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch { /* unreadable: treat as plain node */ }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const dir = path.dirname(pkgPath);
  const ts = 'typescript' in deps || fs.existsSync(path.join(dir, 'tsconfig.json'));
  if ('react' in deps) return ts ? 'typescript-react' : 'react';
  return ts ? 'typescript' : 'node';
}

function packageManager(dir) {
  if (fs.existsSync(path.join(dir, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  return 'npm';
}

// Looks at the root and one level of subfolders (monorepo layouts).
export function detectStacks() {
  const found = new Map();
  const add = (id, rel) => found.set(id, [...(found.get(id) || []), rel]);
  const scan = (dir, prefix) => {
    for (const name of fs.readdirSync(dir)) {
      const rel = prefix + name;
      if (name === 'package.json') add(nodeStack(path.join(dir, name)), rel);
      else for (const [re, id] of MARKERS) if (re.test(name)) { add(id, rel); break; }
    }
  };
  scan(REPO_ROOT, '');
  for (const e of fs.readdirSync(REPO_ROOT, { withFileTypes: true })) {
    if (e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) {
      scan(path.join(REPO_ROOT, e.name), `${e.name}/`);
    }
  }
  return [...found].map(([id, evidence]) => ({ id, evidence }));
}

function suggest(stacks) {
  const commands = {};
  const rootNode = fs.existsSync(path.join(REPO_ROOT, 'package.json'));
  if (rootNode) {
    const pm = packageManager(REPO_ROOT);
    const pkg = readJson(path.join(REPO_ROOT, 'package.json'), {});
    const scripts = pkg.scripts || {};
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if ('@playwright/test' in deps) commands.e2e = 'npx playwright test --reporter=list,json';
    if (fs.existsSync(path.join(REPO_ROOT, 'tsconfig.json'))) commands.typecheck = 'npx tsc --noEmit';
    if ('prettier' in deps) commands.format = 'npx prettier --check .';
    if (scripts.test) commands.unit = pm === 'npm' ? 'npm test' : `${pm} test`;
    if (scripts.lint) commands.lint = `${pm} run lint`;
  }
  for (const s of stacks) {
    if (!commands.unit && TEST_COMMANDS[s.id] && s.evidence.some((f) => !f.includes('/'))) {
      commands.unit = TEST_COMMANDS[s.id];
    }
  }
  const src_globs = ['src', 'app', 'lib', 'backend', 'frontend', 'server', 'client']
    .filter((d) => fs.existsSync(path.join(REPO_ROOT, d))).map((d) => `${d}/**`);
  return { commands, src_globs };
}

// Packs that ship with the workflow are reviewed in the repo like code, so they need no approval.
const SHIPPED_PACKS = ['python', 'typescript-react'];

// A drafted pack is approved only while its file still matches the hash a human approved.
function packStatus(id, project) {
  const file = path.join(RULES_DIR, `${id}.md`);
  if (!fs.existsSync(file)) return 'needs-draft';
  if (SHIPPED_PACKS.includes(id)) return 'approved';
  return project?.approvals?.[id] === sha256File(file) ? 'approved' : 'draft';
}

function contextProblem() {
  if (!fs.existsSync(CONTEXT_FILE)) return `missing ${path.relative(REPO_ROOT, CONTEXT_FILE)}`;
  const text = fs.readFileSync(CONTEXT_FILE, 'utf8');
  const missing = CONTEXT_HEADINGS.filter((h) => !new RegExp(`^#{1,3}\\s+${h}\\b`, 'mi').test(text));
  return missing.length ? `project-context.md needs sections: ${missing.join(', ')}` : null;
}

function problems(project) {
  const out = [];
  const ctx = contextProblem();
  if (ctx) out.push(ctx);
  for (const s of project.stacks) {
    const st = packStatus(s.id, project);
    if (st === 'needs-draft') out.push(`stack ${s.id}: no rule pack yet (draft rules/${s.id}.md via /wf-onboard)`);
    if (st === 'draft') out.push(`stack ${s.id}: pack awaits human approval (node .agent-workflow/wf.mjs init --approve-pack ${s.id})`);
  }
  return out;
}

export function cmdInit({ refresh = false, check = false, approvePack = null, rules = false } = {}) {
  if (rules) {
    process.stdout.write(`${activeRules().map((id) => `.agent-workflow/rules/${id}.md`).join('\n')}\n`);
    return;
  }
  const needLogin = loginProblem();
  if (needLogin) die(needLogin);
  if (loadState()?.run?.id) die('a run is active; init edits workflow files the run would block. Finish or abort the run first.');
  const prev = readJson(PROJECT_FILE, null);

  if (approvePack) {
    const file = path.join(RULES_DIR, `${approvePack}.md`);
    if (!prev) die('run `init` first');
    if (!fs.existsSync(file)) die(`no pack at ${path.relative(REPO_ROOT, file)}`);
    prev.approvals = { ...prev.approvals, [approvePack]: sha256File(file) };
    writeJson(PROJECT_FILE, prev);
    appendEvent('init_pack_approved', { pack: approvePack });
    process.stdout.write(`Approved pack ${approvePack}. Editing it later returns it to draft.\n`);
    return;
  }

  if (check) {
    if (!prev) die('not initialised: run `node .agent-workflow/wf.mjs init`');
    const list = problems(prev);
    if (list.length) die(`init incomplete:\n- ${list.join('\n- ')}`);
    process.stdout.write('init complete\n');
    return;
  }

  if (prev && !refresh) {
    process.stdout.write('already initialised. Use `init --refresh` to re-detect, or `init --check` to see what is left.\n');
    return;
  }

  const stacks = detectStacks();
  const suggested = suggest(stacks);
  const cfg = loadConfig();
  const written = { ...prev?.written };
  cfg.commands = cfg.commands || {};
  let changed = false;
  for (const [key, value] of Object.entries(suggested.commands)) {
    const cur = cfg.commands[key];
    // Only blank fields, or ones init itself wrote and nobody has touched since.
    if (!cur || cur === written[`commands.${key}`]) {
      if (cur !== value) changed = true;
      cfg.commands[key] = value;
      written[`commands.${key}`] = value;
    }
  }
  // Source folders: replace the shipped default or a value init wrote itself, never a user edit.
  const cur = JSON.stringify(cfg.src_globs);
  const found = JSON.stringify(suggested.src_globs);
  if (suggested.src_globs.length && found !== cur && (cur === JSON.stringify(['src/**']) || cur === written.src_globs)) {
    cfg.src_globs = suggested.src_globs;
    written.src_globs = found;
    changed = true;
  }
  if (changed) writeJson(PATHS.config, cfg);

  const project = {
    schema: 1,
    detected_at: new Date().toISOString(),
    stacks,
    suggested,
    written,
    approvals: prev?.approvals || {},
  };
  project.packs = Object.fromEntries(stacks.map((s) => [s.id, packStatus(s.id, project)]));
  writeJson(PROJECT_FILE, project);
  appendEvent(refresh ? 'init_refresh' : 'init', { stacks: stacks.map((s) => s.id) });

  const list = problems(project);
  const lines = [
    `Detected: ${stacks.map((s) => `${s.id} (${s.evidence.join(', ')})`).join('; ') || 'no known stack files'}`,
    `Config filled: ${Object.keys(suggested.commands).map((k) => `${k}=${cfg.commands[k]}`).join(', ') || 'nothing detected'}`,
    suggested.src_globs.length ? `Source folders: ${cfg.src_globs.join(', ')}` : 'No obvious source folder; set src_globs by hand.',
    list.length ? `Next: run /wf-onboard. Open items:\n- ${list.join('\n- ')}` : 'Nothing left to do.',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

// Rule files an agent should read: the shipped generic set plus approved packs.
export function activeRules() {
  const project = readJson(PROJECT_FILE, null);
  const out = [];
  if (fs.existsSync(path.join(RULES_DIR, 'generic.md'))) out.push('generic');
  for (const s of project?.stacks || []) if (packStatus(s.id, project) === 'approved') out.push(s.id);
  return out;
}

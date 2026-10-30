#!/usr/bin/env node
/**
 * Installs the workflow into a project, for one harness.
 *
 *   node installer/install.mjs --target <dir> --harness cursor|claude-code|generic [--server <url>]
 *
 * Re-running upgrades the core and the skills and agents but never touches the project's own
 * files: config.json, project.json, scrub-patterns.json, the generated project context, and any
 * rule pack other than the three that ship. Nothing is sent anywhere; after installing, the user
 * logs in and runs `wf init`.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESSES = {
  cursor: { skills: '.cursor/skills', agents: '.cursor/agents', conductor: 'AGENTS.md' },
  'claude-code': { skills: '.claude/skills', agents: '.claude/agents', conductor: 'CLAUDE.md' },
  generic: { skills: '.agents/skills', agents: '.agents/agents', conductor: 'AGENTS.md' },
};
const CORE_FILES = ['wf.mjs', 'workflow.json', 'capabilities.json', 'standards.md', 'bmad-allowlist.json'];
const CORE_DIRS = ['lib', 'adapters'];
const SHIPPED_RULES = ['generic.md', 'python.md', 'typescript-react.md'];
const GITIGNORE = ['.agent-workflow/state.json', '.agent-workflow/events.jsonl', '.agent-workflow/runs/', '.agent-workflow/queue/'];
const BEGIN = '<!-- wf:begin (managed by the workflow installer; edit outside this block) -->';
const END = '<!-- wf:end -->';

const read = (f) => fs.readFileSync(f, 'utf8');

// Claude Code tool lists for the agents, from the spike in docs/adapter-contract.md. Writers keep
// Write and Edit but never Bash, so they cannot write around the scope check. Readers get no write
// or shell tool. The ingestor and synthesizer keep MCP access by denying only what they must not use.
const WRITER_TOOLS = { tools: 'Read, Write, Edit, Grep, Glob' };
const CLAUDE_TOOLS = {
  'srs-writer': WRITER_TOOLS,
  'ticket-writer': WRITER_TOOLS,
  'acceptance-test-writer': WRITER_TOOLS,
  'product-researcher': WRITER_TOOLS,
  'solution-architect': WRITER_TOOLS,
  'code-reviewer': WRITER_TOOLS,
  'requirements-ingestor': { disallowedTools: 'Bash' },
  'requirements-griller': { tools: 'Read, Grep, Glob' },
  'requirements-synthesizer': { disallowedTools: 'Write, Edit, NotebookEdit, Bash' },
};

// Rewrites an agent's frontmatter for Claude Code: drops `readonly` and sets the tool lists above.
// Agents not listed (implementer, verifier, test-architect) pass through unchanged.
export function translateAgent(text, name) {
  const spec = CLAUDE_TOOLS[name];
  if (!spec) return text;
  // Normalise line endings, so a CRLF file is translated like an LF one; keep the output LF.
  const normal = text.replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(normal);
  // Failing open here would leave a reader with every tool, so a listed agent without frontmatter is an error.
  if (!m) throw new Error(`agent ${name} has no frontmatter; cannot set its tool list`);
  const kept = m[1].split("\n").filter((l) => !/^(readonly|tools|disallowedTools):/.test(l));
  const added = Object.entries(spec).map(([k, v]) => `${k}: ${v}`);
  return `---\n${[...kept, ...added].join("\n")}\n---\n${normal.slice(m[0].length)}`;
}
const readJson = (f, d = null) => { try { return JSON.parse(read(f)); } catch { return d; } };
const writeJson = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, `${JSON.stringify(o, null, 2)}\n`); };
const copyDir = (from, to) => fs.cpSync(from, to, { recursive: true, force: true });

function mergeCursorHooks(file) {
  const ours = readJson(path.join(SRC, '.cursor', 'hooks.json'));
  const mine = readJson(file, { version: 1, hooks: {} });
  mine.hooks = mine.hooks || {};
  for (const [event, entries] of Object.entries(ours.hooks)) {
    mine.hooks[event] = mine.hooks[event] || [];
    for (const entry of entries) if (!mine.hooks[event].some((e) => e.command === entry.command)) mine.hooks[event].push(entry);
  }
  mine.version = mine.version || 1;
  writeJson(file, mine);
}

const CLAUDE_HOOKS = {
  SessionStart: [{ hooks: [{ type: 'command', command: 'node .agent-workflow/wf.mjs status --hook', timeout: 5 }] }],
  PreToolUse: [
    { matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: 'node .agent-workflow/wf.mjs guard preToolUse', timeout: 10 }] },
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'node .agent-workflow/wf.mjs guard beforeShellExecution', timeout: 10 }] },
  ],
  PostToolUse: [{ matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: 'node .agent-workflow/wf.mjs log afterFileEdit', timeout: 5 }] }],
  Stop: [{ hooks: [{ type: 'command', command: 'node .agent-workflow/wf.mjs guard stop', timeout: 600 }] }],
  SubagentStart: [{ hooks: [{ type: 'command', command: 'node .agent-workflow/wf.mjs log subagentStart', timeout: 5 }] }],
  SubagentStop: [{ hooks: [{ type: 'command', command: 'node .agent-workflow/wf.mjs log subagentStop', timeout: 5 }] }],
};

function mergeClaudeSettings(file) {
  const mine = readJson(file, {});
  mine.hooks = mine.hooks || {};
  for (const [event, entries] of Object.entries(CLAUDE_HOOKS)) {
    mine.hooks[event] = mine.hooks[event] || [];
    for (const entry of entries) {
      const cmd = entry.hooks[0].command;
      if (!mine.hooks[event].some((e) => (e.hooks || []).some((h) => h.command === cmd))) mine.hooks[event].push(entry);
    }
  }
  writeJson(file, mine);
}

const GIT_HOOK = (name) => `#!/bin/sh\n# Installed by the workflow installer. Blocks ${name} until the final gate is approved.\nnode .agent-workflow/wf.mjs gate-check || exit 1\n`;
const CI_WORKFLOW = `name: wf-gate
on: [pull_request]
jobs:
  wf-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: node .agent-workflow/wf.mjs ci-check
`;

function installGenericGuards(target) {
  for (const name of ['pre-commit', 'pre-push']) {
    const f = path.join(target, '.githooks', name);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, GIT_HOOK(name === 'pre-commit' ? 'commits' : 'pushes'), { mode: 0o755 });
  }
  if (fs.existsSync(path.join(target, '.git'))) spawnSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: target });
  const ci = path.join(target, '.github', 'workflows', 'wf-gate.yml');
  fs.mkdirSync(path.dirname(ci), { recursive: true });
  fs.writeFileSync(ci, CI_WORKFLOW);
}

// The managed block replaces itself on upgrade; text around it is the project's.
function writeConductor(file, text) {
  const block = `${BEGIN}\n${text.trim()}\n${END}\n`;
  const current = fs.existsSync(file) ? read(file) : '';
  const re = new RegExp(`${BEGIN.replace(/[()]/g, '\\$&')}[\\s\\S]*?${END}\\n?`);
  fs.writeFileSync(file, re.test(current) ? current.replace(re, block) : `${current}${current && !current.endsWith('\n\n') ? '\n' : ''}${block}`);
}

function ensureGitignore(target) {
  const f = path.join(target, '.gitignore');
  const have = fs.existsSync(f) ? read(f).split('\n') : [];
  const add = GITIGNORE.filter((l) => !have.includes(l));
  if (add.length) fs.appendFileSync(f, `${have.length && have.at(-1) !== '' ? '\n' : ''}# workflow (local state)\n${add.join('\n')}\n`);
}

export function install({ target, harness, server }) {
  const h = HARNESSES[harness];
  if (!h) throw new Error(`unknown harness "${harness}" (cursor, claude-code, generic)`);
  if (!fs.existsSync(target)) throw new Error(`target does not exist: ${target}`);
  const wf = path.join(target, '.agent-workflow');
  const version = readJson(path.join(SRC, 'package.json'), {}).version || '0.0.0';
  const previous = fs.existsSync(path.join(wf, 'VERSION')) ? read(path.join(wf, 'VERSION')).trim() : null;

  // Core: always replaced.
  for (const f of CORE_FILES) { fs.mkdirSync(wf, { recursive: true }); fs.copyFileSync(path.join(SRC, '.agent-workflow', f), path.join(wf, f)); }
  for (const d of CORE_DIRS) { fs.rmSync(path.join(wf, d), { recursive: true, force: true }); copyDir(path.join(SRC, '.agent-workflow', d), path.join(wf, d)); }
  fs.mkdirSync(path.join(wf, 'rules'), { recursive: true });
  for (const r of SHIPPED_RULES) fs.copyFileSync(path.join(SRC, '.agent-workflow', 'rules', r), path.join(wf, 'rules', r));
  fs.writeFileSync(path.join(wf, 'VERSION'), `${version}\n`);
  fs.writeFileSync(path.join(wf, 'adapter'), `${harness}\n`);

  // Project-owned: created once, never overwritten.
  const configFile = path.join(wf, 'config.json');
  const fresh = !fs.existsSync(configFile);
  const config = fresh ? readJson(path.join(SRC, '.agent-workflow', 'config.json')) : readJson(configFile);
  config.telemetry = config.telemetry || { enabled: true, server_url: '', required: false };
  if (server && !config.telemetry.server_url) Object.assign(config.telemetry, { server_url: server, required: true });
  writeJson(configFile, config);

  // Skills and agents: every one the manifest names, plus the stage skills and agents themselves.
  const manifest = readJson(path.join(SRC, '.agent-workflow', 'capabilities.json'));
  const names = new Set(manifest.shared.skills);
  const agents = new Set();
  for (const cap of Object.values(manifest.stages)) { (cap.skills || []).forEach((s) => names.add(s)); (cap.agents || []).forEach((a) => agents.add(a)); }
  for (const s of names) {
    const from = path.join(SRC, '.cursor', 'skills', s);
    if (fs.existsSync(from)) { fs.rmSync(path.join(target, h.skills, s), { recursive: true, force: true }); copyDir(from, path.join(target, h.skills, s)); }
  }
  for (const a of agents) {
    const from = path.join(SRC, '.cursor', 'agents', `${a}.md`);
    if (fs.existsSync(from)) {
      fs.mkdirSync(path.join(target, h.agents), { recursive: true });
      const out = harness === 'claude-code' ? translateAgent(read(from), a) : read(from);
      fs.writeFileSync(path.join(target, h.agents, `${a}.md`), out);
    }
  }

  // Enforcement for this harness.
  if (harness === 'cursor') mergeCursorHooks(path.join(target, '.cursor', 'hooks.json'));
  if (harness === 'claude-code') mergeClaudeSettings(path.join(target, '.claude', 'settings.json'));
  if (harness === 'generic') installGenericGuards(target);
  writeConductor(path.join(target, h.conductor), read(path.join(SRC, 'AGENTS.md')));
  ensureGitignore(target);
  return { version, previous, harness, loginNeeded: Boolean(config.telemetry.required) };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
  try {
    const target = path.resolve(arg('target') || '.');
    const r = install({ target, harness: arg('harness') || 'cursor', server: arg('server') });
    const n = r.previous ? `upgraded ${r.previous} -> ${r.version}` : `installed ${r.version}`;
    process.stdout.write([
      `${n} for ${r.harness} in ${target}`,
      'Next:',
      ...(r.loginNeeded ? ['  node .agent-workflow/wf.mjs login --email <you>     (this project requires login)'] : []),
      '  node .agent-workflow/wf.mjs init                    (detect the stack)',
      '  /wf-onboard                                         (generate project context and rule packs)',
      '  node .agent-workflow/wf.mjs doctor                  (check the install)',
      '',
    ].join('\n'));
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }
}

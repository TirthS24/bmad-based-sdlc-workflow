// `wf doctor`: checks that the capability manifest, the skills, the agents and the rules agree.
import fs from 'node:fs';
import path from 'node:path';
import { die, loadConfig, loadWorkflow, readJson } from './io.mjs';
import { REPO_ROOT, WF_DIR } from './paths.mjs';

const SKILL_ROOTS = ['.cursor/skills', '.agents/skills', '.claude/skills'];
const AGENT_ROOTS = ['.cursor/agents', '.agents/agents', '.claude/agents'];
// Words from the retired pipeline, which must not survive in any skill or agent text.
const STALE = /\bgate1\b|\bgate2\b|gerrit|refs\/for/i;
const WRITE_TOOLS = /\b(Write|Edit|NotebookEdit|MultiEdit)\b/;

const list = (root) => {
  const dir = path.join(REPO_ROOT, root);
  return fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : [];
};

export function doctor() {
  const problems = [];
  const manifest = readJson(path.join(WF_DIR, 'capabilities.json'), null);
  if (!manifest) return ['missing .agent-workflow/capabilities.json'];
  const workflow = loadWorkflow();

  const skills = new Map(); // name -> [file]
  for (const root of SKILL_ROOTS) {
    for (const e of list(root)) {
      const file = path.join(REPO_ROOT, root, e.name, 'SKILL.md');
      if (e.isDirectory() && fs.existsSync(file)) skills.set(e.name, [...(skills.get(e.name) || []), file]);
    }
  }
  const agents = new Map();
  for (const root of AGENT_ROOTS) {
    for (const e of list(root)) {
      if (e.isFile() && e.name.endsWith('.md')) agents.set(e.name.slice(0, -3), [...(agents.get(e.name.slice(0, -3)) || []), path.join(REPO_ROOT, root, e.name)]);
    }
  }

  const rel = (f) => path.relative(REPO_ROOT, f);
  for (const [name, files] of skills) {
    if (files.length > 1) problems.push(`duplicate skill ${name}: ${files.map(rel).join(', ')}`);
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      if (name.startsWith('wf-') && text.split('\n').length > (manifest.max_skill_lines ?? 150)) problems.push(`${rel(f)} is over ${manifest.max_skill_lines ?? 150} lines; move detail to references/`);
      if (STALE.test(text)) problems.push(`${rel(f)} mentions a retired term (${STALE.exec(text)[0]})`);
    }
  }
  for (const [name, files] of agents) {
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] || '';
      const tools = /^tools:\s*(.*)$/m.exec(front)?.[1] || '';
      if (/^readonly:\s*true/m.test(front) && WRITE_TOOLS.test(tools)) problems.push(`${rel(f)} is readonly but lists a write tool (${tools})`);
      if (STALE.test(text)) problems.push(`${rel(f)} mentions a retired term (${STALE.exec(text)[0]})`);
    }
  }

  const standards = fs.readFileSync(path.join(WF_DIR, 'standards.md'), 'utf8');
  const headings = new Set([...standards.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => m[1]));
  const referenced = new Set(manifest.shared?.skills || []);
  const referencedAgents = new Set();

  for (const stg of workflow.stages) {
    const cap = manifest.stages?.[stg.id];
    if (!cap) { problems.push(`stage ${stg.id} has no capability in capabilities.json`); continue; }
    if (!cap.skills?.length && !cap.agents?.length) problems.push(`stage ${stg.id} lists no skill or agent`);
    for (const s of cap.skills || []) { referenced.add(s); if (!skills.has(s)) problems.push(`stage ${stg.id}: skill ${s} not found`); }
    for (const a of cap.agents || []) { referencedAgents.add(a); if (!agents.has(a)) problems.push(`stage ${stg.id}: agent ${a} not found`); }
    for (const r of cap.rules || []) if (!headings.has(r)) problems.push(`stage ${stg.id}: standards.md has no "${r}" section`);
    const exec = /^agent:(.+)$/.exec(stg.executor)?.[1];
    if (exec && !(cap.agents || []).includes(exec)) problems.push(`stage ${stg.id}: executor agent ${exec} is not in its capability`);
  }
  for (const id of Object.keys(manifest.stages || {})) {
    if (!workflow.stages.some((s) => s.id === id)) problems.push(`capabilities.json lists unknown stage ${id}`);
  }
  for (const s of manifest.shared?.skills || []) if (!skills.has(s)) problems.push(`shared skill ${s} not found`);
  for (const name of skills.keys()) {
    if (!name.startsWith('bmad-') && !referenced.has(name)) problems.push(`skill ${name} is not referenced by any stage or shared list`);
  }
  for (const name of agents.keys()) if (!referencedAgents.has(name)) problems.push(`agent ${name} is not referenced by any stage`);

  // Human-only skills keep disable-model-invocation; conductor skills must not have it.
  const flagged = (name) => skills.get(name).some((f) => /^disable-model-invocation:\s*true\s*$/m.test(fs.readFileSync(f, 'utf8')));
  for (const name of manifest.invocation?.human_only || []) {
    if (!skills.has(name)) problems.push(`human-only skill ${name} not found`);
    else if (!flagged(name)) problems.push(`${name} is human-only but lacks disable-model-invocation: true`);
  }
  for (const name of manifest.invocation?.conductor || []) {
    if (!skills.has(name)) problems.push(`conductor skill ${name} not found`);
    else if (flagged(name)) problems.push(`${name} is a conductor skill but has disable-model-invocation: true`);
  }

  const eventsFile = path.join(WF_DIR, 'events.jsonl');
  if (fs.existsSync(eventsFile)) {
    const lines = fs.readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean);
    let starts = 0;
    let stops = 0;
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (e.type === 'subagent_start') starts += 1;
        if (e.type === 'subagent_stop') stops += 1;
      } catch { /* ignore */ }
    }
    if (starts > 0 && stops === 0) {
      problems.push('telemetry: subagent_start events with no subagent_stop (hooks may be quiet; restart Cursor)');
    }
  }
  problems.push(...profileProblems(workflow, loadConfig()));
  return problems;
}

export function cmdDoctor() {
  const problems = doctor();
  if (problems.length) die(`doctor found ${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
  process.stdout.write('doctor: capabilities consistent\n');
}

// Profile rules (profiles.mjs and workflow.json "profiles"). Each violation names the profile.
const CONDITIONS = ['planning_clean', 'approach_low_risk', 'red_for_right_reason', 'no_open_high_or_decision', 'specs_only_unchanged'];
const NEVER_SKIPPED = ['planning', 'gate_spec', 'gate_final', 'pr'];
const KNOWN_TIERS = ['unit', 'lint', 'typecheck', 'format', 'complexity', 'e2e', 'a11y', 'docs_lint', 'links'];
const WRITE_TOKEN = /^!?<(test_globs|product_test_globs|unit_test_globs|src_globs|docs_globs|run_dir)>$/;

export function profileProblems(workflow, config = {}) {
  const out = [];
  const stageIds = workflow.stages.map((s) => s.id);
  const gateIds = workflow.stages.filter((s) => s.executor === 'human').map((s) => s.id);
  for (const [name, p] of Object.entries(workflow.profiles || {})) {
    const at = `profile ${name}`;
    const skip = p.skip || [];
    const auto = p.auto || {};
    for (const id of skip) if (!stageIds.includes(id)) out.push(`${at}: skip names unknown stage ${id}`);
    if (Object.values(p.writes || {}).flat().includes('<docs_globs>') && !(config.docs_globs || []).length) out.push(`${at}: <docs_globs> is used but config.docs_globs is empty`);
    for (const id of skip) if (NEVER_SKIPPED.includes(id)) out.push(`${at}: ${id} cannot be skipped`);
    if (name === 'full' && (skip.length || Object.keys(auto).length)) out.push('profile full must not skip or auto-pass anything');
    for (const [gate, cond] of Object.entries(auto)) {
      if (!gateIds.includes(gate)) out.push(`${at}: auto ${gate} is not a gate`);
      else if (skip.includes(gate)) out.push(`${at}: auto ${gate} is also skipped`);
      if (!CONDITIONS.includes(cond)) out.push(`${at}: ${gate} has unknown condition ${cond}`);
      if (gate === 'gate_final' && cond !== 'specs_only_unchanged') out.push(`${at}: gate_final may only auto-pass under specs_only_unchanged`);
      if (cond === 'specs_only_unchanged' && !p.pr_paths) out.push(`${at}: specs_only_unchanged needs pr_paths`);
    }
    for (const [stage, patterns] of Object.entries(p.writes || {})) {
      if (!stageIds.includes(stage)) out.push(`${at}: writes for unknown stage ${stage}`);
      for (const pat of patterns) if (/<[^>]*>/.test(pat) && !WRITE_TOKEN.test(pat)) out.push(`${at}: unknown write token ${pat}`);
    }
    for (const tier of p.verify_tiers || []) if (!KNOWN_TIERS.includes(tier)) out.push(`${at}: unknown verify tier ${tier}`);
  }
  return out;
}

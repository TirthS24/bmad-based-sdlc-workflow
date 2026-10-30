// Persona tickets under specs/spec-<id>/tickets/**/*.json — load, validate, scenario ids.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readText } from './io.mjs';
import { problem } from './problems.mjs';
import { REPO_ROOT, posixRel, repoRoot, specDir } from './paths.mjs';

function reqIds(specText) {
  const ids = new Set();
  const re = /\bREQ-(\d+)\b/g;
  let m;
  while ((m = re.exec(specText))) ids.add(`REQ-${m[1]}`);
  return [...ids];
}

const PERSONAS = new Set(['ui_ux', 'fe', 'be', 'qa']);
const PRIORITIES = new Set(['P0', 'P1', 'P2', 'P3']);
const LAYERS = new Set(['e2e', 'ui', 'api', 'integration', 'unit', 'manual']);
const AUTOMATION = new Set(['automated', 'manual', 'n/a']);

const REQUIRED = ['id', 'persona', 'title', 'purpose', 'description', 'priority', 'requirements', 'depends_on', 'acceptance_criteria'];

const SRS_SECTIONS = [
  [1, 'Introduction'],
  [2, 'Overall description'],
  [3, 'Functional requirements'],
  [4, 'External interfaces'],
  [5, 'Non-functional'],
  [6, 'Non-goals'],
  [7, 'Traceability'],
];

export function srsSectionChecks(text) {
  const problems = [];
  if (!text) return [problem('SRS.md exists', 'no SRS.md', 'specs/spec-<id>/SRS.md with the seven sections', '## 1 Introduction')];
  if (/\[OPEN QUESTION\]/i.test(text)) {
    problems.push(problem('no open questions in SRS.md', 'a [OPEN QUESTION] marker', 'every question answered or escalated', 'Answered in grill/questions.json; marker removed'));
  }
  for (const [num, name] of SRS_SECTIONS) {
    if (!new RegExp(`^#{1,3}\\s*${num}[.)]?\\s+${name}\\b`, 'im').test(text)) {
      problems.push(problem(`SRS section ${num}`, 'no such heading', `a "## ${num} ${name}" heading`, `## ${num} ${name}`));
    }
  }
  const ids = reqIds(text);
  if (!ids.length) {
    problems.push(problem('numbered REQ ids', 'no REQ-n ids', 'REQ-1, REQ-2, ... each with a success condition', '- **REQ-1** Users can sign in. **success:** login returns 200'));
  }
  for (const id of ids) {
    const block = capabilityBlock(text, id);
    if (!block || !/\*\*success:\*\*|success:/i.test(block)) {
      problems.push(problem(`${id} success condition`, 'no success line', 'a **success:** line in the REQ block', `- **${id}** ... **success:** observable outcome`));
    }
  }
  if (!/^#{1,3}\s*6[.)]?\s+Non-goals\b/im.test(text) && !/^#{1,3}\s+Non-goals\b/im.test(text)) {
    problems.push(problem('Non-goals section', 'no Non-goals heading', 'a "## 6 Non-goals" heading', '## 6 Non-goals'));
  }
  return problems;
}

// The block for one REQ: its definition line (`- **REQ-n**`) up to the next REQ or heading. A
// mention elsewhere does not count, and REQ-1 does not match inside REQ-10.
export function capabilityBlock(text, id) {
  const def = new RegExp(`^\\s*-\\s*\\*\\*${id}(?!\\d)`, 'm').exec(text);
  if (!def) return '';
  const body = text.slice(def.index + 1);
  const next = body.search(/\n(?=\s*-\s*\*\*REQ-\d|#{1,3}\s)/);
  return next < 0 ? text.slice(def.index) : text.slice(def.index, def.index + 1 + next);
}

// Source paths may carry a line range: path:12, path:12-30 or path#L12-L30.
export function stripLineRange(s) {
  return String(s || '').replace(/#L\d+(-L\d+)?$/, '').replace(/:\d+(-\d+)?$/, '');
}

function ticketsRoot(state) {
  return path.join(specDir(state), 'tickets');
}

export function loadTickets(state) {
  const root = ticketsRoot(state);
  if (!fs.existsSync(root)) return [];
  const out = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name.endsWith('.json')) {
        try {
          out.push({ path: full, data: JSON.parse(fs.readFileSync(full, 'utf8')) });
        } catch {
          out.push({ path: full, data: null, parseError: true });
        }
      }
    }
  };
  walk(root);
  return out;
}

function isConfluenceUrl(s) {
  const t = String(s || '');
  return /atlassian\.net/i.test(t) && (/\/wiki\//i.test(t) || /\/wiki\b/i.test(t));
}

function isRepoPath(s) {
  const t = stripLineRange(s).replace(/^\.\//, '');
  if (!t || t.includes('://')) return false;
  return fs.existsSync(path.join(repoRoot(), t));
}

function isSlackOnlySource(s) {
  return /slack\.com/i.test(String(s || '')) && !isConfluenceUrl(s) && !isRepoPath(s);
}

export function checkQuestions(state) {
  const qPath = path.join(specDir(state), 'grill', 'questions.json');
  if (!fs.existsSync(qPath)) return [problem('grill questions file', 'no grill/questions.json', 'grill/questions.json, an array of answered questions', '[{ "id": "Q1", "status": "answered", "answered_by": "human" }]')];
  let list;
  try {
    list = JSON.parse(fs.readFileSync(qPath, 'utf8'));
  } catch {
    return [problem('grill questions file', 'invalid JSON', 'a JSON array', '[{ "id": "Q1", "status": "answered" }]')];
  }
  if (!Array.isArray(list)) return [problem('grill questions file', 'a JSON object', 'a JSON array of questions', '[{ "id": "Q1", ... }]')];
  const problems = [];
  const example = '"answered_by": "synthesis", "sources": ["https://acme.atlassian.net/wiki/spaces/X/pages/1"]';
  for (const q of list) {
    const id = q.id || '?';
    if (q.status !== 'answered') problems.push(problem('every question answered', `${id} is ${q.status || 'unanswered'}`, 'status "answered"', '"status": "answered"'));
    if (!['synthesis', 'human'].includes(q.answered_by)) {
      problems.push(problem('answered_by', `${id}: ${q.answered_by || 'missing'}`, 'synthesis or human', '"answered_by": "human"'));
    }
    if (q.answered_by === 'synthesis') {
      const sources = q.sources || [];
      if (!sources.length) problems.push(problem('synthesis sources', `${id} has no sources`, 'at least one source', example));
      for (const src of sources) {
        if (isSlackOnlySource(src)) problems.push(problem('no Slack-only sources', `${id}: ${String(src).slice(0, 60)}`, 'a Confluence URL or an existing repo path (or escalate to a human)', '"answered_by": "human"'));
        else if (!isConfluenceUrl(src) && !isRepoPath(src)) {
          problems.push(problem('synthesis source', `${id}: ${String(src).slice(0, 60)}`, 'a Confluence URL or an existing repo path', example));
        }
      }
    }
  }
  return problems;
}

export function checkTickets(state, srsText) {
  const problems = [];
  const loaded = loadTickets(state);
  if (!loaded.length) return [problem('ticket files', 'no ticket JSON files', 'specs/spec-<id>/tickets/<persona>/*.json', 'tickets/be/BE-1.json')];
  if (typeof srsText !== 'string' || srsText === '') {
    srsText = readText(path.join(specDir(state), 'SRS.md')) || '';
  }
  const byId = new Map();
  for (const { path: file, data, parseError } of loaded) {
    if (parseError) {
      problems.push(problem('ticket JSON parses', `invalid JSON in ${posixRel(file)}`, 'valid JSON', '{ "id": "BE-1", ... }'));
      continue;
    }
    const rel = posixRel(file);
    const folderPersona = path.basename(path.dirname(file));
    for (const field of REQUIRED) {
      if (data[field] === undefined || data[field] === null) {
        problems.push(problem('ticket required fields', `${data.id || rel}: no ${field}`, `a "${field}" field`, `"${field}": ...`));
      }
    }
    if (data.persona && !PERSONAS.has(data.persona)) {
      problems.push(problem('ticket persona', `${data.id}: ${data.persona}`, [...PERSONAS].join(', '), '"persona": "be"'));
    }
    if (data.persona && folderPersona !== data.persona) {
      problems.push(problem('ticket folder matches persona', `${data.id}: folder ${folderPersona}, persona ${data.persona}`, `folder named ${data.persona}`, `tickets/${data.persona}/${data.id}.json`));
    }
    if (data.priority && !PRIORITIES.has(data.priority)) {
      problems.push(problem('ticket priority', `${data.id}: ${data.priority}`, [...PRIORITIES].join(', '), '"priority": "P1"'));
    }
    if (data.id) {
      if (byId.has(data.id)) problems.push(problem('unique ticket ids', `${data.id} twice`, 'one file per ticket id', `${data.id} in one file only`));
      byId.set(data.id, data);
    }
    if (!Array.isArray(data.acceptance_criteria) || !data.acceptance_criteria.length) {
      problems.push(problem('ticket acceptance criteria', `${data.id}: none`, 'a non-empty acceptance_criteria array', '"acceptance_criteria": [{ "id": "AC-1", "test_cases": [...] }]'));
    } else {
      for (const ac of data.acceptance_criteria) {
        const tcs = ac.test_cases || [];
        if (!tcs.length) problems.push(problem('acceptance criteria have test cases', `${data.id} ${ac.id || 'AC'}: none`, 'at least one test_cases entry', '"test_cases": [{ "id": "PRD-1.1", "layer": "e2e", "automation": "automated" }]'));
        for (const tc of tcs) {
          if (tc.layer && !LAYERS.has(tc.layer)) problems.push(problem('test case layer', `${tc.id}: ${tc.layer}`, [...LAYERS].join(', '), '"layer": "e2e"'));
          if (tc.automation && !AUTOMATION.has(tc.automation)) problems.push(problem('test case automation', `${tc.id}: ${tc.automation}`, [...AUTOMATION].join(', '), '"automation": "automated"'));
        }
      }
    }
  }
  for (const { data } of loaded) {
    if (!data?.depends_on) continue;
    for (const dep of data.depends_on) {
      if (!byId.has(dep)) problems.push(problem('depends_on names a ticket', `${data.id} depends on ${dep}`, 'an existing ticket id', `"depends_on": ["${[...byId.keys()][0] || 'BE-1'}"]`));
    }
  }
  const reqIdsInSrs = reqIds(srsText || '');
  const coveredReq = new Set();
  const prdByReq = new Map();
  for (const { data } of loaded) {
    if (!data) continue;
    for (const r of data.requirements || []) coveredReq.add(r);
    for (const ac of data.acceptance_criteria || []) {
      for (const tc of ac.test_cases || []) {
        const m = /^PRD-(\d+)\.\d+/.exec(tc.id || '');
        if (m) {
          const req = `REQ-${m[1]}`;
          if (!prdByReq.has(req)) prdByReq.set(req, []);
          prdByReq.get(req).push(tc.id);
        }
      }
    }
  }
  for (const id of reqIdsInSrs) {
    if (!coveredReq.has(id)) problems.push(problem('every REQ has a ticket', `no ticket lists ${id}`, `a ticket whose "requirements" contains ${id}`, `"requirements": ["${id}"]`));
    if (!prdByReq.get(id)?.length) problems.push(problem('every REQ has a PRD test case', `no PRD-n.m test case for ${id}`, `a test case id PRD-${id.slice(4)}.1`, `"id": "PRD-${id.slice(4)}.1"`));
  }
  return problems;
}

export function plannedScenarios(state) {
  const srs = readText(path.join(specDir(state), 'SRS.md')) || '';
  const loaded = loadTickets(state);
  const ids = [];
  for (const { data } of loaded) {
    if (!data) continue;
    for (const ac of data.acceptance_criteria || []) {
      for (const tc of ac.test_cases || []) {
        if (!/^PRD-\d+\.\d+$/.test(tc.id || '')) continue;
        if (!['e2e', 'ui', 'api'].includes(tc.layer)) continue;
        if (String(tc.automation).toLowerCase() !== 'automated') continue;
        ids.push(tc.id);
      }
    }
  }
  return [...new Set(ids)];
}

export function escalationCount(state) {
  const qPath = path.join(specDir(state), 'grill', 'questions.json');
  if (!fs.existsSync(qPath)) return 0;
  try {
    const list = JSON.parse(fs.readFileSync(qPath, 'utf8'));
    if (!Array.isArray(list)) return 0;
    return list.filter((q) => q.answered_by === 'human').length;
  } catch {
    return 0;
  }
}

export function ticketsHash(state) {
  const loaded = loadTickets(state);
  const parts = loaded
    .filter((t) => t.data)
    .sort((a, b) => posixRel(a.path).localeCompare(posixRel(b.path)))
    .map((t) => `${posixRel(t.path)}\n${JSON.stringify(t.data)}`);
  if (!parts.length) return null;
  return createHash('sha256').update(parts.join('\n---\n')).digest('hex');
}

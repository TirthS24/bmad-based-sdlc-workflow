// Persona tickets under specs/spec-<id>/tickets/**/*.json — load, validate, scenario ids.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readText } from './io.mjs';
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

const SRS_HEADINGS = [
  /^#{1,3}\s*1\s+Introduction\b/im,
  /^#{1,3}\s*2\s+Overall description\b/im,
  /^#{1,3}\s*3\s+Functional requirements\b/im,
  /^#{1,3}\s*4\s+External interfaces\b/im,
  /^#{1,3}\s*5\s+Non-functional\b/im,
  /^#{1,3}\s*6\s+Non-goals\b/im,
  /^#{1,3}\s*7\s+Traceability\b/im,
];

export function srsSectionChecks(text) {
  const problems = [];
  if (!text) return ['missing SRS.md'];
  if (/\[OPEN QUESTION\]/i.test(text)) problems.push('SRS.md still contains [OPEN QUESTION] markers');
  for (const re of SRS_HEADINGS) {
    if (!re.test(text)) problems.push(`SRS.md missing section heading matching ${re.source}`);
  }
  const ids = reqIds(text);
  if (!ids.length) problems.push('SRS.md has no numbered REQ-n IDs');
  for (const id of ids) {
    const block = srsReqBlock(text, id);
    if (!block || !/\*\*success:\*\*|success:/i.test(block)) {
      problems.push(`${id} is missing a success condition`);
    }
  }
  if (!/^#{1,3}\s*6\s+Non-goals\b/im.test(text) && !/^#{1,3}\s+Non-goals\b/im.test(text)) {
    problems.push('SRS.md needs a Non-goals section');
  }
  return problems;
}

function srsReqBlock(text, id) {
  const idx = text.indexOf(id);
  if (idx < 0) return '';
  const rest = text.slice(idx);
  const next = rest.search(/\n(?=- \*\*REQ-|\n## )/);
  return next < 0 ? rest : rest.slice(0, next);
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
  const t = String(s || '').replace(/^\.\//, '');
  if (!t || t.includes('://')) return false;
  return fs.existsSync(path.join(repoRoot(), t));
}

function isSlackOnlySource(s) {
  return /slack\.com/i.test(String(s || '')) && !isConfluenceUrl(s) && !isRepoPath(s);
}

export function checkQuestions(state) {
  const qPath = path.join(specDir(state), 'grill', 'questions.json');
  if (!fs.existsSync(qPath)) return ['missing grill/questions.json'];
  let list;
  try {
    list = JSON.parse(fs.readFileSync(qPath, 'utf8'));
  } catch {
    return ['grill/questions.json is not valid JSON'];
  }
  if (!Array.isArray(list)) return ['grill/questions.json must be an array'];
  const problems = [];
  for (const q of list) {
    if (q.status !== 'answered') problems.push(`${q.id || '?'} is not answered`);
    if (!['synthesis', 'human'].includes(q.answered_by)) {
      problems.push(`${q.id || '?'} answered_by must be synthesis or human`);
    }
    if (q.answered_by === 'synthesis') {
      const sources = q.sources || [];
      if (!sources.length) problems.push(`${q.id || '?'} synthesis answer has no sources`);
      for (const src of sources) {
        if (isSlackOnlySource(src)) problems.push(`${q.id || '?'} Slack-only source must escalate to human`);
        if (!isConfluenceUrl(src) && !isRepoPath(src)) {
          problems.push(`${q.id || '?'} synthesis source must be Confluence URL or existing repo path: ${String(src).slice(0, 60)}`);
        }
      }
    }
  }
  return problems;
}

export function checkTickets(state, srsText) {
  const problems = [];
  const loaded = loadTickets(state);
  if (!loaded.length) return ['no ticket JSON files under tickets/'];
  if (typeof srsText !== 'string' || srsText === '') {
    srsText = readText(path.join(specDir(state), 'SRS.md')) || '';
  }
  const byId = new Map();
  for (const { path: file, data, parseError } of loaded) {
    if (parseError) {
      problems.push(`invalid JSON: ${posixRel(file)}`);
      continue;
    }
    const rel = posixRel(file);
    const folderPersona = path.basename(path.dirname(file));
    for (const field of REQUIRED) {
      if (data[field] === undefined || data[field] === null) problems.push(`${data.id || rel}: missing ${field}`);
    }
    if (data.persona && !PERSONAS.has(data.persona)) problems.push(`${data.id}: bad persona ${data.persona}`);
    if (data.persona && folderPersona !== data.persona) {
      problems.push(`${data.id}: persona folder ${folderPersona} does not match persona field ${data.persona}`);
    }
    if (data.priority && !PRIORITIES.has(data.priority)) problems.push(`${data.id}: bad priority ${data.priority}`);
    if (data.id) {
      if (byId.has(data.id)) problems.push(`duplicate ticket id ${data.id}`);
      byId.set(data.id, data);
    }
    if (!Array.isArray(data.acceptance_criteria) || !data.acceptance_criteria.length) {
      problems.push(`${data.id}: acceptance_criteria required`);
    } else {
      for (const ac of data.acceptance_criteria) {
        const tcs = ac.test_cases || [];
        if (!tcs.length) problems.push(`${data.id} ${ac.id || 'AC'}: no test_cases`);
        for (const tc of tcs) {
          if (tc.layer && !LAYERS.has(tc.layer)) problems.push(`${tc.id}: bad layer ${tc.layer}`);
          if (tc.automation && !AUTOMATION.has(tc.automation)) problems.push(`${tc.id}: bad automation ${tc.automation}`);
        }
      }
    }
  }
  for (const { data } of loaded) {
    if (!data?.depends_on) continue;
    for (const dep of data.depends_on) {
      if (!byId.has(dep)) problems.push(`${data.id}: depends_on unknown ticket ${dep}`);
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
    if (!coveredReq.has(id)) problems.push(`no ticket covers ${id}`);
    if (!prdByReq.get(id)?.length) problems.push(`no PRD-n.m test case for ${id}`);
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

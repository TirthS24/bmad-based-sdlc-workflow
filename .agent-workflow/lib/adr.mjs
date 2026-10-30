// `wf adr`: copies the run's two-line decision record into docs/adr/NNNN-title.md so the
// reasoning outlives runs/. `wf pr` refuses to open the PR until that file is committed.
import fs from 'node:fs';
import path from 'node:path';
import { die, git, loadState, readText } from './io.mjs';
import { REPO_ROOT, posixRel } from './paths.mjs';
import { decisionRecord } from './pr.mjs';

const ADR_DIR = path.join(REPO_ROOT, 'docs', 'adr');

// The ADR written for this run, if any (matched by its Run: line).
function findAdr(state) {
  if (!fs.existsSync(ADR_DIR)) return null;
  return fs.readdirSync(ADR_DIR).find((f) => f.endsWith('.md')
    && readText(path.join(ADR_DIR, f))?.includes(`Run: ${state.run.id}\n`)) || null;
}

export function adrCommitted(state) {
  const file = findAdr(state);
  if (!file) return false;
  const changed = (git(['diff', '--name-only', `${state.run.baseline_sha}..HEAD`]).stdout || '').split('\n');
  return changed.includes(posixRel(path.join(ADR_DIR, file)));
}

export function cmdAdr() {
  const state = loadState();
  if (!state?.run?.id) die('no active run');
  const record = decisionRecord(state);
  if (!record.length) die('approach.md has no Decision section to record');
  const existing = findAdr(state);
  if (existing) {
    process.stdout.write(`${posixRel(path.join(ADR_DIR, existing))}\n`);
    return;
  }
  fs.mkdirSync(ADR_DIR, { recursive: true });
  const last = Math.max(0, ...fs.readdirSync(ADR_DIR).map((f) => parseInt(/^(\d+)-/.exec(f)?.[1] || '0', 10)));
  const num = String(last + 1).padStart(4, '0');
  const title = (state.run.source || state.run.id).replace(/\s+/g, ' ').trim().slice(0, 72);
  const slug = state.run.id.replace(/^\d+-/, '');
  const file = path.join(ADR_DIR, `${num}-${slug}.md`);
  fs.writeFileSync(file, [
    `# ADR ${num}: ${title}`, '', 'Status: accepted', `Run: ${state.run.id}`,
    `Date: ${new Date().toISOString().slice(0, 10)}`, '', ...record, '',
  ].join('\n'));
  process.stdout.write(`${posixRel(file)}\n`);
}

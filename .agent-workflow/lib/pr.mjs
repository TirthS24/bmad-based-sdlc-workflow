// Builds the GitHub PR body from run state, SRS.md, the tickets and the git diff against the baseline.
import path from 'node:path';
import { freezeHash } from './freeze.mjs';
import { matchesAnyGlob, productGlobs, unitGlobs } from './globs.mjs';
import { git, loadWorkflow, readText } from './io.mjs';
import { PATHS, posixRel, specDir } from './paths.mjs';
import fs from 'node:fs';
import { capabilityBlock, reqIds } from './postconditions.mjs';

const DEP_MANIFESTS = /(^|\/)(package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|Pipfile(\.lock)?|go\.(mod|sum)|Cargo\.(toml|lock)|Gemfile(\.lock)?)$/;

// Written by the agent in /wf-pr: what changed and why, in plain language for a peer reviewer.
export function prSummaryPath(state) {
  return path.join(PATHS.runs, state.run.id, 'pr-summary.md');
}

export function prTitle(state) {
  const title = (state.run.source || state.run.id).replace(/\s+/g, ' ').trim();
  return title.length > 72 ? `${title.slice(0, 69)}...` : title;
}

function whatChanged(state) {
  const file = prSummaryPath(state);
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
  const summary = text || `(missing: write a plain-language summary to ${posixRel(file)})`;
  const stat = (git(['diff', '--stat=100', `${state.run.baseline_sha}..HEAD`]).stdout || '').trim().split('\n');
  const shown = stat.length > 30 ? [...stat.slice(0, 29), `... ${stat.length - 30} more files`, stat.at(-1)] : stat;
  return [summary, '', '<details><summary>Files changed</summary>', '', '```', ...(stat[0] ? shown : ['(no commits yet)']), '```', '', '</details>'];
}

// The two-line decision record from approach.md ("Decision" section), copied into the PR.
export function decisionRecord(state) {
  const lines = (readText(path.join(specDir(state), 'approach.md')) || '').split('\n');
  const at = lines.findIndex((l) => /^\s*(#{1,4}\s*)?\*{0,2}Decision\b/i.test(l));
  if (at < 0) return [];
  const out = [];
  const inline = lines[at].replace(/^\s*(#{1,4}\s*)?\*{0,2}Decision\*{0,2}\s*:?\s*\*{0,2}\s*/i, '').trim();
  if (inline) out.push(inline);
  for (const l of lines.slice(at + 1)) {
    if (!l.trim() || /^#{1,4}\s/.test(l)) { if (out.length) break; if (/^#{1,4}\s/.test(l)) break; continue; }
    out.push(l.trim());
  }
  return out.slice(0, 2);
}

function acceptanceCriteria(state) {
  const srs = readText(path.join(specDir(state), 'SRS.md'));
  if (!srs) return ['- (SRS.md not found)'];
  return reqIds(srs).map((id) => {
    const block = capabilityBlock(srs, id);
    const head = block.split('\n')[0].replace(/^[-*\s]*\*{0,2}REQ-\d+\*{0,2}[:\s-]*/, '').trim();
    const success = /success:\*{0,2}\s*(.+)/i.exec(block)?.[1]?.trim();
    return `- [ ] **${id}** ${head}${success ? ` — success: ${success}` : ''}`;
  });
}

function testResults(state) {
  const tiers = state.stages?.verify?.tiers;
  if (!tiers?.length) return ['(no verification results recorded)'];
  return [
    '| Check | Result |',
    '|---|---|',
    ...tiers.map((t) => `| ${t.tier} | ${t.skipped ? 'skipped (no command configured)' : t.code === 0 ? 'passed' : `failed (exit ${t.code})`} |`),
  ];
}

function riskNote(state, config) {
  const diff = git(['diff', '--name-only', `${state.run.baseline_sha}..HEAD`]);
  const changed = (diff.stdout || '').split('\n').map((f) => f.trim()).filter(Boolean);
  const expected = [...(config.src_globs || []), ...productGlobs(config), ...unitGlobs(config), 'specs/**'];
  const outside = changed.filter((f) => !matchesAnyGlob(f, expected));
  const deps = changed.filter((f) => DEP_MANIFESTS.test(f));
  const frozen = state.freeze?.test_files_hash;
  const frozenChanged = frozen ? freezeHash(config) !== frozen : null;
  const rejections = (state.rejections || []).length;
  const escalations = (state.escalations || []).length;
  const lines = [
    `- Files changed: ${changed.length}`,
    `- Outside src, tests and specs: ${outside.length ? outside.map((f) => `\`${posixRel(f)}\``).join(', ') : 'none'}`,
    `- Dependency manifests touched: ${deps.length ? deps.map((f) => `\`${f}\``).join(', ') : 'none'}`,
    `- Frozen tests changed since they were approved: ${frozenChanged === null ? 'unknown (no freeze recorded)' : frozenChanged ? 'YES' : 'no'}`,
    `- Gate rejections during the run: ${rejections}`,
    `- Escalations during the run: ${escalations}`,
  ];
  const skipped = (state.stages?.verify?.tiers || []).filter((t) => t.skipped).map((t) => t.tier);
  lines.push(`- Checks skipped: ${skipped.length ? skipped.join(', ') : 'none'}`);
  return lines;
}

// Every human gate and how it was passed: by you, auto-passed with its condition and reason, or
// skipped by the profile. Profile changes are listed too (4a.8).
function gatesSection(state) {
  const rows = loadWorkflow().stages.filter((s) => s.executor === 'human').map((s) => {
    const g = state.gates?.[s.id] || {};
    const by = g.status === 'skipped' ? 'skipped (profile)' : g.status === 'approved' ? (g.approved_by || 'human') : (g.status || 'pending');
    const why = g.condition ? `${g.condition}: ${g.reason}` : '';
    return `| ${s.id} | ${by} | ${why} | ${g.approved_at || ''} |`;
  });
  const changes = (state.run.profile_changes || []).map((c) => `- profile changed ${c.from} → ${c.to} at ${c.at}`);
  return [
    '## Gates', '', `Profile: \`${state.run.profile || 'full'}\``, '',
    '| Gate | Approved by | Condition / reason | Time |', '|---|---|---|---|', ...rows,
    ...(changes.length ? ['', ...changes] : []), '',
  ];
}

export function buildPrBody(state, config) {
  const approach = state.gates?.gate_approach?.approach;
  return [
    '## Summary',
    '',
    `${state.run.source || state.run.id}`,
    '',
    `- Run: \`${state.run.id}\``,
    `- Approach: ${approach || 'n/a'} (see \`specs/spec-${state.run.id}/approach.md\`)`,
    `- SRS: \`specs/spec-${state.run.id}/SRS.md\``,
    `- Tickets: \`specs/spec-${state.run.id}/tickets/\``,
    '',
    ...(decisionRecord(state).length ? ['## Decision', '', ...decisionRecord(state), ''] : []),
    '## What changed',
    '',
    ...whatChanged(state),
    '',
    '## Acceptance criteria',
    '',
    ...acceptanceCriteria(state),
    '',
    '## Test results',
    '',
    ...testResults(state),
    '',
    ...gatesSection(state),
    '## Risk note',
    '',
    ...riskNote(state, config),
    '',
  ].join('\n');
}

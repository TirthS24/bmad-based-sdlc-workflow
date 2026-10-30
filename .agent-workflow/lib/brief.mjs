// `wf brief [gate]`: facts for the human at a gate, gathered deterministically. The agent
// (wf-gate-brief) turns them into a short plain-language brief; this prints no judgement.
import fs from 'node:fs';
import path from 'node:path';
import { collectTestFiles } from './freeze.mjs';
import { die, loadConfig, loadState, readText, saveState, sha256File } from './io.mjs';
import { PATHS, REPO_ROOT, posixRel, specDir } from './paths.mjs';

function artifact(rel) {
  const full = path.isAbsolute(rel) ? rel : path.join(REPO_ROOT, rel);
  if (!fs.existsSync(full)) return { path: posixRel(full), missing: true };
  if (fs.statSync(full).isDirectory()) {
    const files = fs.readdirSync(full);
    return { path: posixRel(full), files: files.length, hash: null };
  }
  return { path: posixRel(full), bytes: fs.statSync(full).size, hash: sha256File(full) };
}

const count = (text, re) => (text || '').match(re)?.length || 0;

export function gateFacts(state, gate) {
  const dir = specDir(state);
  const runDir = path.join(PATHS.runs, state.run.id);
  const srs = readText(path.join(dir, 'SRS.md'));
  const approach = readText(path.join(dir, 'approach.md'));
  const review = readText(path.join(runDir, 'review.md'));
  switch (gate) {
    case 'gate_spec':
      return {
        artifacts: [
          artifact(path.join(dir, 'SRS.md')),
          artifact(path.join(dir, 'draft-requirements.md')),
          artifact(path.join(dir, 'grill', 'questions.json')),
          artifact(path.join(dir, 'tickets')),
        ],
        facts: {
          requirements: new Set(srs?.match(/\bREQ-\d+\b/g) || []).size,
          open_questions: count(srs, /\[OPEN QUESTION\]/gi),
          has_non_goals: /^#{1,3}\s*(6\s+Non-goals|Non-goals)\b/im.test(srs || ''),
        },
      };
    case 'gate_approach':
      return {
        artifacts: [artifact(path.join(dir, 'approach.md'))],
        facts: { assumptions: count(approach, /\[ASSUMPTION\]/g), decision_needed: count(approach, /decision-needed/gi), verdict: /\b(as-is|with-changes|not-satisfiable)\b/i.exec(approach || '')?.[1] || null },
      };
    case 'gate_tests':
      return {
        artifacts: collectTestFiles(loadConfig()).map(artifact),
        facts: { freeze_hash: state.freeze?.test_files_hash || null },
      };
    case 'gate_review':
      return {
        artifacts: [artifact(path.join(runDir, 'review.md'))],
        facts: { decision_needed: count(review, /\[\s*decision-needed\s*\]/gi), high: count(review, /\[\s*high\s*\]/gi), medium: count(review, /\[\s*medium\s*\]/gi), implement_rounds: state.loops?.implement?.round ?? 0 },
      };
    case 'gate_final':
      return {
        artifacts: [artifact(path.join(runDir, 'evidence')), artifact(path.join(runDir, 'evidence', 'e2e-summary.md'))],
        facts: { checks: (state.stages?.verify?.tiers || []).map((t) => `${t.tier}:${t.skipped ? 'skipped' : t.code === 0 ? 'ok' : 'fail'}`).join(' '), flaky: count(readText(path.join(runDir, 'evidence', 'e2e-summary.md')), /\| flaky \|/g) },
      };
    default:
      return null;
  }
}

export function cmdBrief(gateArg) {
  const state = loadState();
  if (!state?.run?.id) die('no active run');
  const gate = gateArg || state.current.stage;
  const found = gateFacts(state, gate);
  if (!found) die(`${gate} is not a gate (gate_spec, gate_approach, gate_tests, gate_review, gate_final)`);
  const rejections = (state.rejections || []).filter((r) => r.gate === gate);
  const hashes = found.artifacts.filter((a) => a.hash).map((a) => a.hash).join(',');
  const last = state.briefs?.[gate]?.hash;
  const changed = last == null ? 'first brief' : last === hashes ? 'no' : 'yes';
  state.briefs = { ...state.briefs, [gate]: { hash: hashes, at: new Date().toISOString() } };
  saveState(state);

  const lines = [`gate: ${gate}`, `status: ${state.gates[gate]?.status || 'n/a'}`, `changed since last brief: ${changed}`, 'artifacts:'];
  for (const a of found.artifacts) {
    lines.push(`- ${a.path}${a.missing ? ' (missing)' : a.files != null ? ` (${a.files} files)` : ` (${a.bytes} bytes, sha256 ${a.hash.slice(0, 12)})`}`);
  }
  lines.push('facts:');
  for (const [k, v] of Object.entries(found.facts)) lines.push(`- ${k}: ${v ?? 'n/a'}`);
  lines.push(`rejections: ${rejections.length}`);
  for (const r of rejections) lines.push(`- ${r.at}: ${r.reason}`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

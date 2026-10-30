// Runs the configured verification commands (unit, lint, ...).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, loadState } from './io.mjs';
import { PATHS, REPO_ROOT } from './paths.mjs';

export const ALL_TIERS = ['unit', 'lint', 'typecheck', 'format', 'complexity', 'e2e', 'a11y'];

// Where the e2e tier's Playwright JSON report goes for the active run, if any.
export function e2eReportPath() {
  const id = loadState()?.run?.id;
  return id ? path.join(PATHS.runs, id, 'evidence', 'e2e-results.json') : null;
}

const run = (cmd, env) => spawnSync(cmd, { cwd: REPO_ROOT, encoding: 'utf8', shell: true, env });

export function runVerifyTiers(tiers) {
  const cfg = loadConfig();
  const results = [];
  for (const tier of tiers) {
    const cmd = (cfg.commands || {})[tier];
    if (!cmd || !String(cmd).trim()) {
      results.push({ tier, skipped: true, code: 0, stdout: '', stderr: '' });
      continue;
    }
    const env = { ...process.env };
    if (tier === 'e2e') {
      // Playwright's json reporter writes here, so the stage can map failures back to ids.
      const report = e2eReportPath();
      if (report) {
        fs.rmSync(report, { force: true });
        env.PLAYWRIGHT_JSON_OUTPUT_NAME = report;
      }
    }
    // Seed data runs first for e2e; a failed seed fails the tier.
    const seed = tier === 'e2e' && String((cfg.commands || {}).seed || '').trim();
    const seeded = seed ? run(seed, env) : null;
    const res = seeded && seeded.status !== 0 ? seeded : run(cmd, env);
    results.push({
      tier,
      skipped: false,
      code: res.status ?? 1,
      stdout: res.stdout || '',
      stderr: res.stderr || '',
    });
  }
  return results;
}

export function combinedOutput(results) {
  return results.map((r) => `${r.stdout}\n${r.stderr}`).join('\n');
}

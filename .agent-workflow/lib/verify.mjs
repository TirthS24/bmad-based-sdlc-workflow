// Runs the configured verification commands (unit, lint, ...).
import { spawnSync } from 'node:child_process';
import { loadConfig } from './io.mjs';
import { REPO_ROOT } from './paths.mjs';

export function runVerifyTiers(tiers) {
  const cfg = loadConfig();
  const results = [];
  for (const tier of tiers) {
    const cmd = (cfg.commands || {})[tier];
    if (!cmd || !String(cmd).trim()) {
      results.push({ tier, skipped: true, code: 0, stdout: '', stderr: '' });
      continue;
    }
    const res = spawnSync(cmd, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      shell: true,
      env: process.env,
    });
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

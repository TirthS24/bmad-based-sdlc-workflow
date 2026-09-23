#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const event = process.argv[2] || process.env.CURSOR_HOOK_EVENT || 'preToolUse';
const child = spawn(
  process.execPath,
  [path.join(repoRoot, '.agent-workflow/wf.mjs'), 'guard', event],
  { stdio: 'inherit', cwd: repoRoot },
);
child.on('exit', (code) => process.exit(code ?? 1));

#!/usr/bin/env node
/**
 * Deterministic workflow state machine. Agents call commands; they do not
 * edit state.json. Postconditions are functions, not model memory.
 *
 * This file only parses arguments and dispatches. The logic lives in lib/,
 * and harness-specific hook handling lives in adapters/.
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import * as cursor from './adapters/cursor.mjs';
import * as c from './lib/commands.mjs';
import { die } from './lib/io.mjs';

export function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--check') flags.check = true;
    else if (a === '--hook') flags.hook = true;
    else if (a === '--force') flags.force = true;
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--result') flags.result = argv[++i];
    else if (a === '--approach') flags.approach = argv[++i];
    else rest.push(a);
  }
  return { flags, rest };
}

// ponytail: Cursor is the only adapter; Phase 7 picks one per harness here.
const adapter = cursor;

export function main(argv = process.argv.slice(2)) {
  const { flags, rest } = parseArgs(argv);
  const cmd = rest[0];
  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') {
    process.stdout.write(`usage: wf.mjs <run|status|done|approve|verify|guard|log|prune|abort|pause|resume> [args]\n`);
    process.exit(cmd ? 0 : 1);
  }
  if (cmd === 'run') return c.cmdRun(rest.slice(1).join(' '));
  if (cmd === 'status') return c.cmdStatus(flags, adapter);
  if (cmd === 'done') return c.cmdDone(rest[1], flags.result);
  if (cmd === 'approve') return c.cmdApprove(rest[1], flags.approach);
  if (cmd === 'verify') return c.cmdVerify();
  if (cmd === 'guard') return c.cmdGuard(rest[1], adapter);
  if (cmd === 'log') return c.cmdLog(rest[1], adapter);
  if (cmd === 'prune') return c.cmdPrune({ dryRun: flags.dryRun });
  if (cmd === 'abort') return c.cmdAbort({ force: flags.force });
  if (cmd === 'pause') return c.cmdPause();
  if (cmd === 'resume') return c.cmdResume(rest[1]);
  die(`unknown command ${cmd}`);
}

const entry = process.argv[1] && fs.realpathSync(process.argv[1]);
if (entry && import.meta.url === pathToFileURL(entry).href) main();

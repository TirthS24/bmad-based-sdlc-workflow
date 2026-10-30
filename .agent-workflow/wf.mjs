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
import * as claudeCode from './adapters/claude-code.mjs';
import * as cursor from './adapters/cursor.mjs';
import * as generic from './adapters/generic.mjs';
import { harnessName } from './lib/telemetry/capture.mjs';
import * as c from './lib/commands.mjs';
import { cmdLogin, cmdLogout, cmdReportFailure, cmdSync, cmdWhoami } from './lib/sync-commands.mjs';
import { cmdAdr } from './lib/adr.mjs';
import { cmdBrief } from './lib/brief.mjs';
import { cmdCiCheck, cmdGateCheck } from './lib/gatecheck.mjs';
import { cmdDoctor } from './lib/doctor.mjs';
import { cmdEscalation } from './lib/escalation.mjs';
import { cmdGoto } from './lib/goto.mjs';
import { cmdInit } from './lib/init.mjs';
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
    else if (a === '--server') flags.server = argv[++i];
    else if (a === '--email') flags.email = argv[++i];
    else if (a === '--password-stdin') flags.passwordStdin = true;
    else if (a === '--refresh') flags.refresh = true;
    else if (a === '--rules') flags.rules = true;
    else if (a === '--approve-pack') flags.approvePack = argv[++i];
    else if (a === '--result') flags.result = argv[++i];
    else if (a === '--approach') flags.approach = argv[++i];
    else if (a === '--reason') flags.reason = argv[++i];
    else rest.push(a);
  }
  return { flags, rest };
}

// One adapter per harness. The installer writes .agent-workflow/adapter; WF_ADAPTER overrides it.
const ADAPTERS = { cursor, 'claude-code': claudeCode, generic };
const adapter = ADAPTERS[harnessName()] || cursor;

export async function main(argv = process.argv.slice(2)) {
  const { flags, rest } = parseArgs(argv);
  const cmd = rest[0];
  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') {
    process.stdout.write(`usage: wf.mjs <init|gate-check|ci-check|login|logout|whoami|sync|report-failure|doctor|adr|brief|goto|escalation|run|status|done|tickets|agent|approve|reject|pr|verify|guard|log|prune|abort|pause|resume> [args]\n`);
    process.exit(cmd ? 0 : 1);
  }
  if (cmd === 'init') return cmdInit(flags);
  if (cmd === 'gate-check') return cmdGateCheck();
  if (cmd === 'ci-check') return cmdCiCheck();
  if (cmd === 'login') return cmdLogin(flags);
  if (cmd === 'logout') return cmdLogout();
  if (cmd === 'whoami') return cmdWhoami();
  if (cmd === 'sync') return cmdSync();
  if (cmd === 'report-failure') return cmdReportFailure(rest[1], rest[2]);
  if (cmd === 'doctor') return cmdDoctor();
  if (cmd === 'adr') return cmdAdr();
  if (cmd === 'brief') return cmdBrief(rest[1]);
  if (cmd === 'goto') return cmdGoto(rest[1]);
  if (cmd === 'escalation') return cmdEscalation(rest[1], flags.reason);
  if (cmd === 'run') return c.cmdRun(rest.slice(1).join(' '));
  if (cmd === 'status') return c.cmdStatus(flags, adapter);
  if (cmd === 'done') return c.cmdDone(rest[1], flags.result);
  if (cmd === 'tickets') return c.cmdTickets(rest[1]);
  if (cmd === 'agent') return c.cmdAgent(rest[1], rest[2]);
  if (cmd === 'approve') return c.cmdApprove(rest[1], flags.approach);
  if (cmd === 'reject') return c.cmdReject(rest[1], flags.reason);
  if (cmd === 'pr') return c.cmdPr({ dryRun: flags.dryRun });
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

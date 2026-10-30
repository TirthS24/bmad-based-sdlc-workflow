// CLI wrappers for login, logout, whoami and sync, plus the agent-reported failure event.
import { appendEvent, die, loadState, readStdin } from './io.mjs';
import { ERROR_CLASSES } from './telemetry/capture.mjs';
import { loadCredentials, login, loginStatus, logout, syncOnce, telemetryConfig } from './telemetry/client.mjs';
import { queueStats } from './telemetry/queue.mjs';
import { createInterface } from 'node:readline';

async function readPassword(fromStdin) {
  if (fromStdin || !process.stdin.isTTY) return readStdin().split('\n')[0];
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  rl._writeToOutput = () => {};
  process.stderr.write('Password: ');
  return new Promise((resolve) => rl.question('', (answer) => { rl.close(); process.stderr.write('\n'); resolve(answer); }));
}

export async function cmdLogin({ server, email, passwordStdin }) {
  const url = server || telemetryConfig().server_url;
  if (!url) die('login needs --server <url> (or telemetry.server_url in config.json)');
  if (!email) die('login needs --email <you>');
  const password = await readPassword(passwordStdin);
  if (!password) die('empty password');
  try {
    const out = await login({ server: url, email, password });
    process.stdout.write(`logged in as ${email} (${out.role}); session valid until ${out.expires_at}\n`);
  } catch (e) {
    die(`login failed: ${e.message}`);
  }
}

export async function cmdLogout() {
  await logout();
  process.stdout.write('logged out\n');
}

export function cmdWhoami() {
  const c = loadCredentials();
  const status = loginStatus();
  process.stdout.write(c ? `${c.email} at ${c.server} (${status}, expires ${c.expires_at})\n` : 'not logged in\n');
  process.stdout.write(`queued events: ${queueStats().events}\n`);
}

export async function cmdSync() {
  const r = await syncOnce();
  process.stdout.write(`sync: ${r.status}; sent ${r.sent} (accepted ${r.accepted}, already had ${r.duplicates}, rejected ${r.rejected}); queued ${r.events}, dropped by cap ${r.dropped_events}\n`);
  if (r.status !== 'ok') process.exit(1);
}

// An agent that crashed or timed out has no hook of its own, so the conductor reports it.
export function cmdReportFailure(errorClass, agent) {
  if (!loadState()?.run?.id) die('no active run');
  if (!ERROR_CLASSES.includes(errorClass)) die(`error class must be one of: ${ERROR_CLASSES.join(', ')}`);
  appendEvent('agent_failed', { agent: agent || 'unknown', error_class: errorClass });
  process.stdout.write('recorded\n');
}

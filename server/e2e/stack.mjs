// Runs in its own Node process (plain ESM): throwaway Postgres + the server + a little seed data.
// Prints "READY <base-url> <password>" when up and tears everything down on SIGTERM.
import { ev, startPostgres, startStack, PASSWORD } from '../test/helpers.mjs';

const pg = await startPostgres();
const stack = await startStack(pg.url);
  const adminToken = await stack.admin('admin@example.com');
  const alice = await stack.user(adminToken, 'alice@example.com');
  const done = (stage, ms) => ev('run-a', 'stage_completed', { stage, attrs: { duration_ms: ms } });
  await stack.api('POST', '/events', { token: alice, body: { events: [
    ev('run-a', 'run_started', { attrs: { project: 'shop', harness: 'cursor' } }),
    done('planning', 60000), done('feasibility', 180000),
    ev('run-a', 'gate_rejected', { stage: 'gate_spec', attrs: { gate: 'gate_spec', wait_ms: 30000, count: 1, reason: '<img src=x onerror="window.pwned=1"> too broad' } }),
    ev('run-a', 'error', { stage: 'implement', attrs: { error_class: 'test_failure' } }),
    ev('run-a', 'agent_failed', { stage: 'feasibility', attrs: { agent: 'solution-architect', error_class: 'timeout' } }),
    ev('run-a', 'loop_round', { stage: 'implement', attrs: { round: 1, cap: 5 } }),
    ev('run-a', 'scrub_hit', { attrs: { category: 'email', count: 1 } }),
    ev('run-b', 'run_started'),
  ] } });
process.stdout.write(`READY ${stack.base} ${PASSWORD}\n`);
const stop = async () => { await stack.close(); pg.stop(); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

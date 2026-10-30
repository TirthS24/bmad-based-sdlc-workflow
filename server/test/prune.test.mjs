import assert from 'node:assert/strict';
import test from 'node:test';
import { prune } from '../bin/prune-events.mjs';
import { ev, startPostgres, startStack } from './helpers.mjs';

const pg = await startPostgres();
test.after(() => pg.stop());

test('retention: old events, empty old runs and long-dead sessions go; recent data stays', async (t) => {
  const s = await startStack(pg.url);
  t.after(() => s.close());
  const alice = await s.user(await s.admin(), 'alice@example.com');
  const old = new Date(Date.now() - 100 * 86400e3).toISOString();
  await s.api('POST', '/events', { token: alice, body: { events: [
    ev('old-run', 'run_started', { ts: old }), ev('old-run', 'stage_started', { ts: old }),
    ev('new-run', 'run_started'), ev('mixed', 'run_started', { ts: old }), ev('mixed', 'stage_started'),
  ] } });
  await s.pool.query("UPDATE sessions SET revoked_at = now() - interval '40 days' WHERE user_id = (SELECT id FROM users WHERE email = 'alice@example.com')");

  const dry = await prune(s.pool, 30, { dryRun: true });
  assert.deepEqual(dry, { events: 3, sessions: 1, dryRun: true });
  assert.equal((await s.pool.query('SELECT count(*)::int AS n FROM events')).rows[0].n, 5, 'dry run deletes nothing');

  await prune(s.pool, 30);
  const left = (await s.pool.query('SELECT run_id, type FROM events ORDER BY run_id, type')).rows;
  assert.deepEqual(left, [{ run_id: 'mixed', type: 'stage_started' }, { run_id: 'new-run', type: 'run_started' }]);
  const runs = (await s.pool.query('SELECT id FROM runs ORDER BY id')).rows.map((r) => r.id);
  assert.deepEqual(runs, ['mixed', 'new-run'], 'a run with no events left is removed');
  await assert.rejects(prune(s.pool, 0), /positive number/);
});

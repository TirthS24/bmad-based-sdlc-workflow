import assert from 'node:assert/strict';
import test from 'node:test';
import { ev, startPostgres, startStack, uuid } from './helpers.mjs';

const pg = await startPostgres();
test.after(() => pg.stop());

async function setup(t, overrides) {
  const s = await startStack(pg.url, overrides);
  t.after(() => s.close());
  const adminToken = await s.admin();
  const alice = await s.user(adminToken, 'alice@example.com');
  const bob = await s.user(adminToken, 'bob@example.com');
  return { s, adminToken, alice, bob };
}
const post = (s, token, events) => s.api('POST', '/events', { token, body: { events } });
const count = async (s, sql = 'SELECT count(*)::int AS n FROM events') => (await s.pool.query(sql)).rows[0].n;

test('events: need a session', async (t) => {
  const { s } = await setup(t);
  assert.equal((await post(s, null, [ev('r1', 'run_started')])).status, 401);
  assert.equal((await post(s, 'bogus', [ev('r1', 'run_started')])).status, 401);
});

test('events: accepted, stored against the caller, and the run is created', async (t) => {
  const { s, alice } = await setup(t);
  const e = ev('run-1', 'run_started', { attrs: { project: 'shop', harness: 'cursor' } });
  const res = await post(s, alice, [e]);
  assert.deepEqual(res.body, { accepted: [e.event_id], duplicates: [], rejected: [] });
  const run = (await s.pool.query('SELECT r.*, u.email FROM runs r JOIN users u ON u.id = r.user_id WHERE r.id = $1', ['run-1'])).rows[0];
  assert.equal(run.email, 'alice@example.com');
  assert.equal(run.project, 'shop');
  assert.equal(run.harness, 'cursor');
});

test('events: re-submitting the same batch is idempotent', async (t) => {
  const { s, alice } = await setup(t);
  const batch = [ev('run-1', 'run_started'), ev('run-1', 'stage_started', { stage: 'planning' })];
  const first = await post(s, alice, batch);
  const second = await post(s, alice, batch);
  assert.equal(first.body.accepted.length, 2);
  assert.deepEqual(second.body.accepted, []);
  assert.equal(second.body.duplicates.length, 2);
  assert.equal(await count(s), 2);
});

test('events: a duplicate inside one batch is stored once', async (t) => {
  const { s, alice } = await setup(t);
  const e = ev('run-1', 'run_started');
  const res = await post(s, alice, [e, e]);
  assert.equal(res.body.accepted.length, 1);
  assert.equal(res.body.duplicates.length, 1);
  assert.equal(await count(s), 1);
});

test('events: a user cannot post for another user, by payload or by run', async (t) => {
  const { s, alice, bob } = await setup(t);
  await post(s, alice, [ev('alice-run', 'run_started')]);
  const aliceId = (await s.pool.query("SELECT id FROM users WHERE email = 'alice@example.com'")).rows[0].id;

  const forged = ev('bob-run', 'run_started', { user_id: aliceId });
  const byPayload = await post(s, bob, [forged]);
  assert.deepEqual(byPayload.body.rejected, [{ event_id: forged.event_id, reason: 'not_owned' }]);

  const intoHers = ev('alice-run', 'stage_started', { stage: 'tests' });
  const byRun = await post(s, bob, [intoHers]);
  assert.deepEqual(byRun.body.rejected, [{ event_id: intoHers.event_id, reason: 'not_owned' }]);
  assert.equal(await count(s), 1, 'only alice\'s own event is stored');
  assert.equal(await count(s, "SELECT count(*)::int AS n FROM runs WHERE id = 'bob-run'"), 0);
  assert.equal(await count(s, "SELECT count(*)::int AS n FROM events WHERE event_id = '" + intoHers.event_id + "'"), 0);
});

test('events: replaying alice\'s event id as bob stores nothing and tells bob nothing new', async (t) => {
  const { s, alice, bob } = await setup(t);
  const e = ev('alice-run', 'run_started');
  await post(s, alice, [e]);
  const replay = await post(s, bob, [{ ...e, run_id: 'bobs-run' }]);
  assert.deepEqual(replay.body.accepted, []);
  assert.equal(await count(s), 1);
});

test('events: invalid events are rejected one by one without sinking the batch', async (t) => {
  const { s, alice } = await setup(t);
  const good = ev('run-1', 'run_started');
  const res = await post(s, alice, [
    good,
    { ...ev('run-1', 'stage_started'), type: 'made_up' },
    { ...ev('run-1', 'stage_started'), event_id: 'not-a-uuid' },
    { ...ev('run-1', 'stage_started'), ts: 'yesterday-ish' },
    { ...ev('run-1', 'stage_started'), attrs: { blob: 'x'.repeat(3000) } },
    { ...ev('run-1', 'stage_started'), run_id: '' },
    null,
  ]);
  assert.deepEqual(res.body.accepted, [good.event_id]);
  assert.deepEqual(res.body.rejected.map((r) => r.reason), ['unknown type', 'event_id must be a uuid', 'bad ts', 'bad attrs', 'bad run_id', 'not an object']);
});

test('events: bad bodies and oversized batches', async (t) => {
  const { s, alice } = await setup(t, { maxBatch: 3 });
  assert.equal((await s.api('POST', '/events', { token: alice, body: { nope: 1 } })).status, 400);
  assert.equal((await post(s, alice, [ev('r', 'run_started'), ev('r', 'run_started'), ev('r', 'run_started'), ev('r', 'run_started')])).status, 413);
  const raw = await fetch(`${s.base}/events`, { method: 'POST', headers: { authorization: `Bearer ${alice}` }, body: '{bad json' });
  assert.equal(raw.status, 400);
});

test('events: run lifecycle updates status, pause and resume', async (t) => {
  const { s, alice } = await setup(t);
  const status = async () => (await s.pool.query("SELECT status, ended_at FROM runs WHERE id = 'r'")).rows[0];
  await post(s, alice, [ev('r', 'run_started')]);
  assert.equal((await status()).status, 'active');
  await post(s, alice, [ev('r', 'run_ended', { attrs: { status: 'paused' } })]);
  assert.equal((await status()).status, 'paused');
  await post(s, alice, [ev('r', 'stage_started', { stage: 'tests' })]);
  assert.deepEqual(await status(), { status: 'active', ended_at: null });
  await post(s, alice, [ev('r', 'run_ended', { attrs: { status: 'completed' } })]);
  const done = await status();
  assert.equal(done.status, 'completed');
  assert.ok(done.ended_at);
});

test('risk indicator: never says clean; unchecked beats hits beats no_hits', async (t) => {
  const { s, alice } = await setup(t);
  await post(s, alice, [ev('quiet', 'run_started'), ev('hits', 'run_started'), ev('hits', 'scrub_hit', { attrs: { category: 'email', count: 1 } }),
    ev('blind', 'run_started'), ev('blind', 'scrub_hit', { attrs: { category: 'ssn', count: 1 } }), ev('blind', 'session_unchecked', { attrs: { harness: 'generic' } })]);
  const rows = (await s.pool.query('SELECT run_id, phi_pii_status FROM run_risk ORDER BY run_id')).rows;
  assert.deepEqual(rows, [
    { run_id: 'blind', phi_pii_status: 'not_checked' },
    { run_id: 'hits', phi_pii_status: 'scrubbed_hits' },
    { run_id: 'quiet', phi_pii_status: 'no_hits' },
  ]);
  assert.ok(!rows.some((r) => /clean/i.test(r.phi_pii_status)));
});

test('events: concurrent identical batches still store each event once', async (t) => {
  const { s, alice } = await setup(t);
  const batch = Array.from({ length: 20 }, () => ev('race', 'stage_started', { stage: 'tests' }));
  batch.unshift(ev('race', 'run_started'));
  await Promise.all([post(s, alice, batch), post(s, alice, batch), post(s, alice, batch)]);
  assert.equal(await count(s), 21);
  assert.ok(uuid());
});

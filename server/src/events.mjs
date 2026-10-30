// POST /events: batches, idempotent on event_id. The caller's user id comes from the session,
// never from the payload, and a run can only be written to by the user who started it.
import { HttpError } from './auth.mjs';

export const EVENT_TYPES = new Set([
  'run_started', 'run_ended', 'stage_started', 'stage_completed', 'gate_requested', 'gate_approved',
  'gate_rejected', 'loop_round', 'agent_failed', 'guard_blocked', 'error', 'scrub_hit', 'session_unchecked',
  'human_escalations', 'agent_run',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function problem(e, user) {
  if (!e || typeof e !== 'object') return 'not an object';
  if (!UUID.test(String(e.event_id))) return 'event_id must be a uuid';
  if (!EVENT_TYPES.has(e.type)) return 'unknown type';
  if (typeof e.run_id !== 'string' || !e.run_id || e.run_id.length > 128) return 'bad run_id';
  if (Number.isNaN(Date.parse(e.ts))) return 'bad ts';
  if (e.stage != null && (typeof e.stage !== 'string' || e.stage.length > 64)) return 'bad stage';
  if (e.attrs != null && (typeof e.attrs !== 'object' || Array.isArray(e.attrs) || JSON.stringify(e.attrs).length > 2048)) return 'bad attrs';
  if (e.user_id != null && e.user_id !== user.id) return 'not_owned';
  return null;
}

export async function ingest({ pool, config }, user, body) {
  const list = body?.events;
  if (!Array.isArray(list)) throw new HttpError(400, 'body must be {"events":[...]}');
  if (list.length > config.maxBatch) throw new HttpError(413, `at most ${config.maxBatch} events per batch`);
  const result = { accepted: [], duplicates: [], rejected: [] };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const e of list) {
      const bad = problem(e, user);
      if (bad) { result.rejected.push({ event_id: e?.event_id ?? null, reason: bad }); continue; }
      await client.query(
        'INSERT INTO runs (id, user_id, started_at) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
        [e.run_id, user.id, e.ts],
      );
      const owner = (await client.query('SELECT user_id FROM runs WHERE id = $1', [e.run_id])).rows[0].user_id;
      if (owner !== user.id) { result.rejected.push({ event_id: e.event_id, reason: 'not_owned' }); continue; }
      const ins = await client.query(
        `INSERT INTO events (event_id, run_id, stage, type, ts, attrs) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
        [e.event_id, e.run_id, e.stage ?? null, e.type, e.ts, JSON.stringify(e.attrs || {})],
      );
      if (!ins.rowCount) { result.duplicates.push(e.event_id); continue; }
      result.accepted.push(e.event_id);
      if (e.type === 'run_started') {
        await client.query('UPDATE runs SET project = COALESCE($2, project), harness = COALESCE($3, harness), started_at = LEAST(started_at, $4) WHERE id = $1',
          [e.run_id, e.attrs?.project ?? null, e.attrs?.harness ?? null, e.ts]);
      } else if (e.type === 'run_ended') {
        await client.query('UPDATE runs SET ended_at = $2, status = $3 WHERE id = $1', [e.run_id, e.ts, String(e.attrs?.status || 'ended').slice(0, 32)]);
      } else if (e.type === 'stage_started') {
        await client.query("UPDATE runs SET status = 'active', ended_at = NULL WHERE id = $1 AND status = 'paused'", [e.run_id]);
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return result;
}

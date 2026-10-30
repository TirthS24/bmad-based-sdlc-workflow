#!/usr/bin/env node
// Retention: deletes events older than N days, then runs that have no events left. Sessions that
// expired or were revoked more than 30 days ago go too. Run from cron; --dry-run only counts.
import { loadConfig } from '../src/config.mjs';
import { createPool } from '../src/db.mjs';

export async function prune(pool, days, { dryRun = false } = {}) {
  if (!Number.isFinite(days) || days < 1) throw new Error('--older-than-days must be a positive number');
  const cutoff = `${Math.floor(days)} days`;
  const count = async (sql, params = []) => (await pool.query(sql, params)).rows[0].n;
  const events = await count('SELECT count(*)::int AS n FROM events WHERE ts < now() - $1::interval', [cutoff]);
  const sessions = await count("SELECT count(*)::int AS n FROM sessions WHERE coalesce(revoked_at, expires_at) < now() - interval '30 days'");
  if (!dryRun) {
    await pool.query('DELETE FROM events WHERE ts < now() - $1::interval', [cutoff]);
    await pool.query("DELETE FROM sessions WHERE coalesce(revoked_at, expires_at) < now() - interval '30 days'");
    await pool.query('DELETE FROM runs r WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.run_id = r.id) AND r.started_at < now() - $1::interval', [cutoff]);
  }
  return { events, sessions, dryRun };
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) {
  const i = process.argv.indexOf('--older-than-days');
  const pool = createPool(loadConfig());
  try {
    const r = await prune(pool, Number(process.argv[i + 1]), { dryRun: process.argv.includes('--dry-run') });
    process.stdout.write(`${r.dryRun ? 'would delete' : 'deleted'} ${r.events} events and ${r.sessions} old sessions\n`);
  } catch (e) {
    process.stderr.write(`${e.message}\nusage: prune-events.mjs --older-than-days N [--dry-run]\n`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

// Read-only aggregates for the dashboard, plus user and invite management. All SQL, no business
// logic in the browser. Every function here is reached only through the admin role check.
const num = (v) => (v === null || v === undefined ? null : Number(v));

export async function summary(pool) {
  const q = async (sql) => (await pool.query(sql)).rows[0];
  const runs = await q(`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE status = 'active')::int AS active,
      count(*) FILTER (WHERE status = 'completed')::int AS completed,
      count(*) FILTER (WHERE status = 'aborted')::int AS aborted FROM runs`);
  const rest = await q(`SELECT
      (SELECT count(*)::int FROM users WHERE disabled_at IS NULL) AS users,
      (SELECT count(*)::int FROM events) AS events,
      (SELECT count(*)::int FROM events WHERE type = 'gate_rejected') AS gate_rejections,
      (SELECT count(*)::int FROM events WHERE type = 'error') AS errors,
      (SELECT count(*)::int FROM events WHERE type = 'agent_failed') AS agent_failures`);
  const risk = (await pool.query('SELECT phi_pii_status, count(*)::int AS n FROM run_risk GROUP BY 1')).rows;
  return { runs, ...rest, risk: Object.fromEntries(risk.map((r) => [r.phi_pii_status, r.n])) };
}

export async function stageTimes(pool) {
  const { rows } = await pool.query(`
    SELECT stage, count(*)::int AS n,
      avg((attrs->>'duration_ms')::bigint) AS avg_ms,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY (attrs->>'duration_ms')::bigint) AS median_ms,
      max((attrs->>'duration_ms')::bigint) AS max_ms,
      sum((attrs->>'duration_ms')::bigint) AS total_ms
    FROM events WHERE type = 'stage_completed' AND attrs ? 'duration_ms' AND attrs->>'duration_ms' ~ '^[0-9]+$'
    GROUP BY stage ORDER BY total_ms DESC`);
  return rows.map((r) => ({ stage: r.stage, n: r.n, avg_ms: Math.round(num(r.avg_ms)), median_ms: Math.round(num(r.median_ms)), max_ms: num(r.max_ms), total_ms: num(r.total_ms) }));
}

export async function errors(pool) {
  const byClass = (await pool.query(`SELECT attrs->>'error_class' AS error_class, count(*)::int AS n FROM events WHERE type = 'error' GROUP BY 1 ORDER BY n DESC`)).rows;
  const byStage = (await pool.query(`SELECT stage, attrs->>'error_class' AS error_class, count(*)::int AS n FROM events WHERE type = 'error' GROUP BY 1, 2 ORDER BY n DESC`)).rows;
  return { by_class: byClass, by_stage: byStage };
}

export async function gates(pool) {
  const perGate = (await pool.query(`
    SELECT attrs->>'gate' AS gate,
      count(*) FILTER (WHERE type = 'gate_approved')::int AS approved,
      count(*) FILTER (WHERE type = 'gate_rejected')::int AS rejected,
      avg((attrs->>'wait_ms')::bigint) AS avg_wait_ms
    FROM events WHERE type IN ('gate_approved', 'gate_rejected') GROUP BY 1 ORDER BY 1`)).rows
    .map((r) => ({ ...r, avg_wait_ms: r.avg_wait_ms === null ? null : Math.round(Number(r.avg_wait_ms)) }));
  const held = (await pool.query(`
    SELECT e.ts, e.run_id, e.attrs->>'gate' AS gate, e.attrs->>'reason' AS reason,
      (e.attrs->>'wait_ms')::bigint AS wait_ms, u.email AS user_email
    FROM events e JOIN runs r ON r.id = e.run_id JOIN users u ON u.id = r.user_id
    WHERE e.type = 'gate_rejected' ORDER BY e.ts DESC LIMIT 100`)).rows
    .map((r) => ({ ...r, wait_ms: num(r.wait_ms) }));
  return { per_gate: perGate, rejections: held };
}

export async function agentFailures(pool) {
  const byAgent = (await pool.query(`SELECT attrs->>'agent' AS agent, attrs->>'error_class' AS error_class, count(*)::int AS n FROM events WHERE type = 'agent_failed' GROUP BY 1, 2 ORDER BY n DESC`)).rows;
  const recent = (await pool.query(`SELECT e.ts, e.run_id, e.stage, e.attrs->>'agent' AS agent, e.attrs->>'error_class' AS error_class FROM events e WHERE e.type = 'agent_failed' ORDER BY e.ts DESC LIMIT 100`)).rows;
  return { by_agent: byAgent, recent };
}

export async function retries(pool) {
  const rows = (await pool.query(`
    SELECT run_id, stage, count(*)::int AS rounds, max((attrs->>'round')::int) AS max_round, max((attrs->>'cap')::int) AS cap
    FROM events WHERE type = 'loop_round' GROUP BY 1, 2 ORDER BY rounds DESC LIMIT 200`)).rows;
  return { total_rounds: rows.reduce((n, r) => n + r.rounds, 0), by_run_stage: rows };
}

export async function runs(pool, limit = 100) {
  const { rows } = await pool.query(`
    SELECT r.id, r.project, r.harness, r.status, r.started_at, r.ended_at, u.email AS user_email, k.phi_pii_status,
      (SELECT count(*)::int FROM events e WHERE e.run_id = r.id AND e.type = 'error') AS errors,
      (SELECT count(*)::int FROM events e WHERE e.run_id = r.id AND e.type = 'gate_rejected') AS rejections,
      (SELECT count(*)::int FROM events e WHERE e.run_id = r.id AND e.type = 'loop_round') AS loop_rounds
    FROM runs r JOIN users u ON u.id = r.user_id JOIN run_risk k ON k.run_id = r.id
    ORDER BY r.started_at DESC LIMIT $1`, [Math.min(Number(limit) || 100, 500)]);
  return rows;
}

export async function runDetail(pool, id) {
  const run = (await runs(pool, 500)).find((r) => r.id === id);
  if (!run) return null;
  const events = (await pool.query('SELECT event_id, stage, type, ts, attrs FROM events WHERE run_id = $1 ORDER BY ts, received_at', [id])).rows;
  return { run, events };
}

export async function users(pool) {
  return (await pool.query(`SELECT id, email, role, created_at, disabled_at,
      (SELECT count(*)::int FROM runs r WHERE r.user_id = u.id) AS runs FROM users u ORDER BY created_at`)).rows;
}

export async function disableUser(pool, id) {
  const r = await pool.query("UPDATE users SET disabled_at = now() WHERE id = $1 AND role <> 'admin' RETURNING id", [id]);
  if (r.rowCount) await pool.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
  return r.rowCount > 0;
}

export async function invites(pool) {
  return (await pool.query(`SELECT i.id, i.email, i.expires_at, i.used_at, i.created_at, u.email AS invited_by
      FROM invites i LEFT JOIN users u ON u.id = i.invited_by ORDER BY i.created_at DESC LIMIT 200`)).rows;
}

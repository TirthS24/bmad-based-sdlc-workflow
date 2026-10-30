CREATE OR REPLACE VIEW agent_timings AS
SELECT
  run_id,
  stage,
  attrs->>'agent' AS agent,
  attrs->>'status' AS status,
  (attrs->>'started_at')::timestamptz AS started_at,
  NULLIF(attrs->>'ended_at', 'null')::timestamptz AS ended_at,
  NULLIF(attrs->>'duration_ms', 'null')::bigint AS duration_ms
FROM events
WHERE type = 'agent_run';

CREATE OR REPLACE VIEW run_human_escalations AS
SELECT
  run_id,
  (attrs->>'count')::int AS count
FROM events
WHERE type = 'human_escalations';

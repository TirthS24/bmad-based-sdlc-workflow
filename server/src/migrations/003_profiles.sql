-- Gate decisions per run: who passed each gate (you or the profile) and under which condition (4a.8).
CREATE OR REPLACE VIEW gate_decisions AS
SELECT
  run_id,
  attrs->>'gate' AS gate,
  attrs->>'by' AS by,
  attrs->>'condition' AS condition,
  ts
FROM events
WHERE type = 'gate_approved';

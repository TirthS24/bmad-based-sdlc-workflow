CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'user')),
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz
);
CREATE UNIQUE INDEX users_email_lower ON users (lower(email));

CREATE TABLE invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  invited_by uuid REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE runs (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  project text,
  harness text,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  status text NOT NULL DEFAULT 'active'
);
CREATE INDEX runs_user ON runs (user_id);

CREATE TABLE events (
  event_id uuid PRIMARY KEY,
  run_id text NOT NULL REFERENCES runs(id),
  stage text,
  type text NOT NULL,
  ts timestamptz NOT NULL,
  attrs jsonb NOT NULL DEFAULT '{}',
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_run_ts ON events (run_id, ts);
CREATE INDEX events_type ON events (type);

-- The indicator never reads "clean": no_hits only says the scrubber ran and found nothing.
CREATE VIEW run_risk AS
SELECT r.id AS run_id,
  CASE
    WHEN EXISTS (SELECT 1 FROM events e WHERE e.run_id = r.id AND e.type = 'session_unchecked') THEN 'not_checked'
    WHEN EXISTS (SELECT 1 FROM events e WHERE e.run_id = r.id AND e.type = 'scrub_hit') THEN 'scrubbed_hits'
    ELSE 'no_hits'
  END AS phi_pii_status
FROM runs r;

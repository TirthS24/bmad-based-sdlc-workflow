# Runbook: telemetry server

The server is one Node process (`server/`) that serves the API and the admin dashboard, in front of one Postgres database. Workflow users never hold database credentials; they hold a session token.

## Set up

Requirements: Node 20.12+, Postgres 14+ (tested on 18), a TLS-terminating reverse proxy in front.

```bash
cd server && npm install --omit=dev
export DATABASE_URL=postgres://wf_app:...@db.internal:5432/wf
export PORT=8787
node src/index.mjs                       # applies migrations, then listens
```

Create the first admin on the server host (the password is read from stdin, not argv):

```bash
printf '%s\n' "$ADMIN_PASSWORD" | node bin/bootstrap-admin.mjs --email you@example.com
```

Running it again with an existing email resets that admin's password.

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | none | Required. Use a role that can create tables on first start, then a narrower one. |
| `DB_POOL_MAX` | 10 | Size of the one shared pool, for all users. |
| `SESSION_TTL_HOURS` | 168 | How long a login (and the offline window on a laptop) lasts. |
| `INVITE_TTL_HOURS` | 72 | Invite expiry. |
| `MIN_PASSWORD_LENGTH` | 12 | Applies to invites and bootstrap. |
| `LOGIN_MAX_FAILURES_ACCOUNT` / `_IP` / `LOGIN_WINDOW_MINUTES` | 5 / 30 / 15 | Failed-login limits. |
| `MAX_EVENT_BATCH` | 500 | Events per `POST /events`. |
| `TRUST_PROXY` | off | Set to `1` only behind a proxy that sets `X-Forwarded-For`, or every client shares the proxy's address. |

The failed-login limiter is in memory. Run one server process; with several, move it to the database first.

## Users

1. An admin opens the dashboard, **Users and invites**, enters an email and copies the invite token (shown once).
2. The invitee runs `POST /auth/accept-invite` with the token and a password (the token goes to them over a channel you trust).
3. They run `node .agent-workflow/wf.mjs login --server https://wf.example.com --email you@example.com`.

Workflow users cannot see the dashboard. To reset a forgotten password, invite the same email again: accepting it sets the new password and ends the old sessions. Disable a user from the dashboard; their sessions end at once. Admins are created only with `bootstrap-admin`.

## Backups

- Nightly: `pg_dump --format=custom "$DATABASE_URL" > wf-$(date +%F).dump`, kept 14 days, copied off the host.
- Restore check, monthly: `createdb wf_restore && pg_restore -d wf_restore wf-….dump`, then start the server against it and open the dashboard.
- The database holds counts, durations and scrubbed reasons, never ticket text, code or prompts. Even so, treat dumps as confidential: they list who used the workflow and when.

## Retention

Delete events older than a year (adjust to policy), plus long-dead sessions and empty runs:

```bash
node bin/prune-events.mjs --older-than-days 365 --dry-run
node bin/prune-events.mjs --older-than-days 365
```

Run it weekly from cron. Clients keep their own queue for 14 days or 5 MB, whichever fills first (`queue/` under `.agent-workflow`); beyond that the oldest unsent batches are dropped and `wf whoami` / `wf sync` report the count.

## Upgrades

Deploy the new code and restart: migrations apply on start, each in its own transaction, and are recorded in `schema_migrations`. Never edit an applied migration; add a new file. Roll back by restoring the dump taken before the upgrade.

## Incidents

| Symptom | What to do |
|---|---|
| A laptop is lost, or a token leaked | Disable the user on the dashboard (ends every session), then re-invite them. |
| Many failed logins | Check the proxy sets `X-Forwarded-For` correctly and `TRUST_PROXY=1`. A `429` carries `Retry-After`. Restarting the server clears the limiter. |
| Dashboard empty but users say they ran | On a client: `wf whoami` and `wf sync`. `not_logged_in` or `expired` means log in again; `server_unreachable` means check DNS/TLS/proxy. Events stay queued meanwhile. |
| Events rejected (`not_owned`) | A client posted into a run owned by another user, or with a different `user_id`. Clients should not set `user_id`; the server assigns it. |
| The scrubber missed a PII pattern | Add it to `.agent-workflow/scrub-patterns.json` (projects) and as a corpus case in `telemetry.test.mjs`. Existing server rows can be fixed with an `UPDATE events SET attrs = ...` for the affected run; `prune-events.mjs` removes whole ranges. |
| Disk full | Prune, then `VACUUM`. Check `events` growth per day on the dashboard's overview. |
| A run shows `not checked` | The harness gave no content hooks (generic adapter). Expected; the scrubber only saw what the core saw. |

## Health

`GET /healthz` returns 200 when the database answers. Use it for the load balancer and an uptime check.

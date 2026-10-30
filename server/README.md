# Telemetry server

Ingestion API, auth and the admin dashboard in one deployable. Setup and operations: `docs/RUNBOOK.md`.

```bash
npm install
npm test            # needs Postgres binaries (initdb, pg_ctl); set PG_BIN if they are not on the usual path
npm run test:ui     # Playwright dashboard tests; first run: npx playwright install chromium
```

Tests start a throwaway Postgres cluster on a free port; nothing touches an existing database.

Routes: `POST /auth/login`, `/auth/logout`, `/auth/accept-invite`; `POST /events`; `GET|POST /admin/*` (admin role only); `GET /` the dashboard; `GET /healthz`.

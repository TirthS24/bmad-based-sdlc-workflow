# Implementation plan: harness-agnostic, gated AI SDLC with usage telemetry

Status: Phase 0 implemented; Phases 1–8 pending.
Scope decisions below come from the planning discussion; items marked **[proposed]** are my recommendations and still need your confirmation.

## 1. Goal

Set up and monitor a software development lifecycle in which a main (orchestrator) agent drives specialised subagents from an initial requirement to a raised GitHub PR. It installs on top of any agent harness (Cursor, Claude Code, Hermes, and similar). Humans approve at every stage except implementation. Usage metrics go to a central database and are shown to admins on a dashboard.

### Target pipeline

| # | Stage | Executor | Human gate on exit |
|---|---|---|---|
| 1 | Requirement interview → `SPEC.md` (product decisions) | main agent | yes |
| 2 | Architecture and engineering review, key technical decisions → `approach.md` | subagent | yes |
| 3 | Product/flow test cases as Playwright scripts, then frozen | subagent | yes |
| 4 | Implementation, with unit tests written by the implementer | subagent | **no** |
| 5 | Code review, then another test round | subagent or main | yes |
| 6 | Automated E2E run of the stage 3 scripts | subagent | yes |
| 7 | GitHub PR | main agent | yes (final approval before `gh pr create`) |

Rules that follow from the decisions:
- Implementation only starts after the product decisions (stage 1) and technical decisions (stage 2) are approved.
- Product/flow tests are written before implementation and the implementer cannot edit them. Unit tests are not frozen and belong to the implementer.
- Gerrit is dropped. The delivery target is a GitHub PR only.
- The retry loop inside implementation (and the fix rounds in review) are not gated. A cap or a stuck loop ends them and escalates to a human.

### Telemetry and access decisions

| Area | Decision |
|---|---|
| Store | One central Postgres instance. |
| Connections | Shared connection pool on the server. Clients never hold database credentials. |
| Identity | Email and password. Hashes stored in the database. Invite-only. |
| Roles | Admin (dashboard access) and workflow user (can log in and send events, no dashboard). Only admins see data. |
| Privacy | PII/PHI scrubbed at capture, before anything is queued or sent. Each session has a risk indicator. |
| Offline | Events queue locally, sync later, and are deleted from the device after the server acknowledges them. |
| Dashboard | Admin-only: time per stage, errors, gates held back by users, agent failures, retries and their counts. |
| Ingestion service | Part of the server that serves the dashboard. |

## 2. Current state (baseline)

Estimates are my judgement, not measured.

| Area | Today | Gap to goal |
|---|---|---|
| Stage machine | `wf.mjs` (~900 lines), `workflow.json`, 10 stages, `loop_caps`, plateau detection | New stage graph and gates |
| Gates | Gate 1 (approach and test plan) and Gate 2 (final) | Gate on 6 exits; rejection is not recorded |
| Spec interview | `bmad-spec` via `/wf-start` | Add own gate |
| Architecture review | `feasibility-analyst` (verdict, 2–3 approaches) | Reframe as architecture and engineering review |
| Tests | `test-architect` writes one frozen set (unit and E2E globs) before implementation | Split product/E2E (frozen, Playwright) from unit (implementer-owned) |
| Implementation | `implementer` subagent, cap 5 | Mostly aligned |
| Review | `bmad-code-review` on the main thread, cap 3 | Gate on exit |
| E2E | `verifier` explores in Cursor's built-in browser; `config.json` `e2e` is empty | Playwright runner |
| PR | Gerrit commit and push | `gh pr create` |
| Enforcement | `.cursor/hooks.json` + `guard.mjs` (13 lines) | Port to a harness-neutral core, add adapters |
| Events | Local `events.jsonl` | Schema, scrubbing, queue, sync |
| Identity, database, dashboard, installer | none | New |

Overall alignment is about 60% on pipeline shape and about 25% once telemetry, auth and the installer are counted.

## 3. Architecture

```
 user's machine                                          server (new)
┌──────────────────────────────────────────┐        ┌──────────────────────────┐
│ harness (Cursor / Claude Code / Hermes)  │        │ API                      │
│   ▲ adapter (hooks, skills, agents)      │        │  /auth, /invite          │
│   │                                      │  HTTPS │  /events (idempotent)    │
│ wf core (Node CLI, state machine, gates) │───────▶│  /admin/* (dashboard)    │
│   │ capture → scrub → local queue        │  token │        │                 │
│   └─ sync worker (ack → delete)          │        │   pool ▼                 │
└──────────────────────────────────────────┘        │ Postgres                 │
                                                    └──────────────────────────┘
```

Components:
1. **wf core** (`.agent-workflow/wf.mjs`, extended): harness-neutral state machine, gate enforcement, event capture. No harness-specific code.
2. **Adapters**: one per harness. They translate that harness's hooks, skills and subagent definitions into calls to the core. The core stays the only source of truth for state.
3. **Scrubber**: runs at capture. Raw prompt text, tool output and file contents never enter the queue. Events carry ids, counts, durations and error codes.
4. **Local queue**: append-only batches under `.agent-workflow/queue/` **[proposed: JSONL files, no extra dependency; Node 20.12 has no stable SQLite]**.
5. **Server** **[proposed: Node/TypeScript to match the CLI, one deployable that serves API and dashboard]**.
6. **Postgres**: runs, stage attempts, gates, errors, users, sessions, invites.

### Event model

Every event: `event_id` (uuid, idempotency key), `run_id`, `session_id`, `user_id` (assigned server-side from the token), `stage`, `type`, `ts`, `attrs` (small, scrubbed JSON).

Types: `run_started`, `stage_started`, `stage_completed`, `gate_requested`, `gate_approved`, `gate_rejected`, `loop_round` (with round number and cap), `agent_failed`, `guard_blocked`, `error` (with `error_class`: test_failure, agent_crash, timeout, guard_block, tool_error), `scrub_hit` (category and count only), `session_unchecked` (harness gave no content hooks).

### Database sketch

`users(id, email unique, password_hash, role, created_at, disabled_at)`,
`invites(id, email, token_hash, invited_by, expires_at, used_at)`,
`sessions(id, user_id, token_hash, expires_at)`,
`runs(id, user_id, project, harness, started_at, ended_at, status)`,
`events(event_id pk, run_id, stage, type, ts, attrs jsonb)`,
`run_risk(run_id pk, phi_pii_status)` where status is `scrubbed_hits`, `no_hits`, or `not_checked`.

The indicator never reads "clean". `no_hits` means the scrubber ran and found nothing; `not_checked` means the harness exposed no content hooks.

### Security notes
- Slow password hash (argon2id or bcrypt), per-IP and per-account login rate limits, invite tokens stored hashed with expiry.
- Session tokens are opaque, hashed at rest, expire, and can be revoked. The CLI caches one so the workflow works offline until it expires.
- All dashboard routes require the admin role. Workflow-user tokens can only write events for themselves.
- The admin who creates the first account is bootstrapped at server setup, not through the API.
- Scrubbing is best effort. It reduces risk but cannot prove absence, which is why the indicator wording is limited as above.

## 4. Roadmap

Each phase ends with a deliverable and the tests that must pass before moving on. Tests use `node:test` for the CLI and server unless noted, plus Playwright for UI and E2E.

### Phase 0: Foundations and test harness
Make the existing core testable and separate harness-specific code from it.
- Extract `wf.mjs` file and state helpers behind functions that can be imported by tests.
- Define the adapter contract (what a harness must call: `status`, `guard`, `log`, `done`).
- Move Cursor hook wiring into a Cursor adapter folder without changing behaviour.

**Deliverable:** core library plus Cursor adapter, behaviour unchanged.
**Tests:** state-machine tests for every current stage transition, loop cap and plateau stop; adapter contract tests; a Cursor adapter smoke test that fires each hook payload and checks the same allow/deny result as before.

### Phase 1: Pipeline realignment
Implement the target stage graph and GitHub PR.
- New `workflow.json` with the 7 stages from section 1, gates on every exit except implementation.
- Gate semantics: approve, reject (with reason), and both recorded as events. Agents cannot approve; `state.json` stays protected.
- Replace the Gerrit stage with `gh pr create`, building a PR body with summary, acceptance checklist, test results and a risk note.
- Remove Gerrit text from `/wf-pr`, `wf.mjs` and the README.

**Deliverable:** a run can go from spec to a PR using stub agents, with a gate at each required exit.
**Tests:** table-driven tests that a stage cannot advance without approval, that implementation advances without one, that rejection returns to the prior stage and is logged, and that `gh pr create` is called with the expected body (a fake `gh` on PATH).

### Phase 2: Test model and E2E stage
- Split tests into product/flow (Playwright, `E2E/tests/**`) and unit (implementer-owned).
- The test stage (stage 3) writes Playwright scripts from `SPEC.md` and `approach.md`; they are frozen at its gate.
- Stage 6 runs the scripts with the Playwright CLI and records pass/fail per script as the stage result.
- Fill `config.json` commands for E2E, type check and formatter.

**Deliverable:** a sample app with a Playwright suite that fails before implementation and passes after.
**Tests:** frozen-glob enforcement (implementer edits to `E2E/tests` are denied, unit test edits allowed); E2E stage exit-code mapping (0 passes, failures block); a fixture run where the suite fails then passes after a fixed implementation.

### Phase 3: Telemetry capture, scrubber, local queue
- Event schema and emitter in the core, called from stage transitions, gates, loops and errors.
- Scrubber covering emails, phone numbers, dates of birth, SSN-style ids, names near known labels, and account/invoice identifiers, configurable via a pattern file.
- Local queue with batching, retention cap by age and size, and cleanup that runs only on server acknowledgement.

**Deliverable:** events captured and queued locally with no raw content.
**Tests:** scrubber corpus tests (known PHI/PII samples must not appear in output, and benign text must pass untouched); queue tests for crash recovery, duplicate ids, cap behaviour, and "never delete before ack".

### Phase 4: Server, auth, ingestion
- Postgres migrations for the tables above and a connection pool.
- Invite-only account creation, login, token issue and revoke, rate limits, role checks.
- `POST /events` accepting batches, idempotent on `event_id`, rejecting events not owned by the caller.

**Deliverable:** deployable server with a bootstrap command for the first admin.
**Tests:** integration tests against a real Postgres instance (container): login success and failure, rate limiting, invite expiry and reuse, role enforcement, idempotent re-submission, and a user attempting to post for another user.

### Phase 5: Client login and sync
- `wf login`, cached token with expiry, `wf logout`.
- Sync worker that sends queued batches, handles retries and backoff, and deletes only acknowledged events.
- Offline behaviour: workflow continues while the cached token is valid; stops cleanly with a clear message when it is not.

**Deliverable:** CLI connected to a running server end to end.
**Tests:** client and server tests with injected faults (server down, mid-batch drop, token expiry, duplicate send) checking no loss, no duplicates, and correct local cleanup.

### Phase 6: Admin dashboard
- Views: time per stage, errors by class, gates held back (with who and why), agent failures, retries with counts, per-run drill-down, and the PHI/PII risk indicator per session.
- Admin-only, with invite management.

**Deliverable:** dashboard populated from real events.
**Tests:** API aggregate tests on seeded data (known inputs give known totals), authorization tests (non-admin and anonymous get 403/401 on every route), and Playwright tests of the dashboard views and the invite flow.

### Phase 7: Installer and harness adapters
- An installer that adds the core, config, skills/agents and the right adapter into any project, and writes the first-run config.
- Claude Code adapter first, then Cursor (already extracted in Phase 0), then Hermes once its hook and subagent capabilities are known.
- Fallback for harnesses without hooks: gates are enforced by a git hook and CI check, and `session_unchecked` is recorded.

**Deliverable:** one-command install into an empty project for each supported harness.
**Tests:** installation into a temp project per harness; a contract test suite that every adapter must pass (deny a write outside the stage, block `git commit` before approval, emit events); an upgrade test that reinstalling does not clobber local config.

### Phase 8: Baseline and hardening
- Pick a sample app and five specs, run the full pipeline on each, and record time, retries, errors and cost per stage.
- Document operations: server setup, backups, retention, and incident steps.

**Deliverable:** a recorded baseline and a runbook.
**Tests:** five end-to-end runs with at least three completing with no manual fix; the dashboard reproduces the recorded numbers.

## 5. Dependencies between phases

0 → 1 → 2. Phases 3, 4 can start in parallel after 0. Phase 5 needs 3 and 4. Phase 6 needs 4 and 5. Phase 7 needs 1 and 2, and its telemetry parts need 3 to 5. Phase 8 is last.

## 6. Risks

| Risk | Mitigation |
|---|---|
| Harnesses expose different hooks, so gates and risk checks are uneven | Adapter contract tests; `session_unchecked` status; git/CI fallback |
| Scrubber misses a PII pattern | Pattern file, corpus tests that grow with each miss, honest indicator wording |
| Server becomes a scope sink | Keep one deployable, small API, dashboard on the same server |
| Gate fatigue from a gate at every stage | Record gate wait time on the dashboard to see it |
| Local queue fills the disk after a long outage | Retention cap and a visible warning |
| Hermes capabilities are unknown | Adapter built last, after a short capability check |

## 7. Open items

- Sample app and the five specs for the baseline (to be shared).
- Playwright is the default E2E tool for now. MCP-driven testing can be revisited later.
- Server technology and hosting **[proposed: Node/TypeScript, one deployable]**.
- Hermes hook and subagent capabilities.
- Password reset flow (admin-triggered reissue of an invite is the minimal option).

# Requirements

Numbered so tests, plans and PRs can cite them. Each row names the phase in `IMPLEMENTATION_PLAN.md` that delivers it. "Today" is the state after Phase 0.

## Pipeline

| ID | Requirement | Phase | Today |
|---|---|---|---|
| R-1 | A main agent orchestrates specialised subagents from requirement to PR | 1, 7 | partial (Cursor skills) |
| R-2 | Requirement interview produces `SPEC.md` with numbered `REQ-n` capabilities | 1 | met |
| R-3 | Architecture and engineering review of the spec produces `approach.md` with key decisions | 1 | partial (feasibility framing) |
| R-4 | A human approves at every stage exit except implementation | 1 | 2 of 6 exits |
| R-5 | Rejecting a gate is a recorded outcome that returns to the prior stage | 1 | missing |
| R-6 | Product/flow tests are written as Playwright scripts after planning and frozen before implementation | 2 | partial (one frozen set) |
| R-7 | Unit tests are written by the implementer and are not frozen | 2 | missing |
| R-8 | Implementation retries are capped, stop on a stuck loop, and are not gated | 1 | met |
| R-9 | Code review followed by another test round | 1, 2 | partial |
| R-10 | An automated E2E run of the frozen scripts precedes the PR | 2 | missing |
| R-11 | Delivery is a GitHub PR (summary, acceptance checklist, test results, risk note); no Gerrit | 1 | missing |

## Harness portability

| ID | Requirement | Phase | Today |
|---|---|---|---|
| R-12 | Core logic is independent of any harness | 0 | met (`lib/`) |
| R-13 | Each harness has an adapter satisfying `docs/adapter-contract.md` | 0, 7 | Cursor only |
| R-14 | One-command installer for Cursor, Claude Code and Hermes | 7 | missing |
| R-15 | Harnesses without hooks fall back to git hook / CI enforcement and report `not_checked` | 7 | missing |

## Telemetry and access

| ID | Requirement | Phase | Today |
|---|---|---|---|
| R-16 | Every stage, gate, loop round, error and agent failure emits an event through one sink | 3 | partial (`appendEvent`) |
| R-17 | PII/PHI is scrubbed at capture, before queueing or sending | 3 | missing |
| R-18 | Events queue locally, sync later, and are deleted only after server acknowledgement; queue has a retention cap | 3, 5 | missing |
| R-19 | Central Postgres behind a server with a shared connection pool; clients hold no database credentials | 4 | missing |
| R-20 | Invite-only email + password accounts, hashed passwords, rate-limited login, revocable sessions | 4 | missing |
| R-21 | Roles: admin (dashboard) and workflow user (submit own events only) | 4 | missing |
| R-22 | Each session carries a PHI/PII indicator: `scrubbed_hits`, `no_hits` or `not_checked`; never "clean" | 3, 6 | missing |
| R-23 | Admin dashboard: time per stage, errors by class, gates held back, agent failures, retries with counts | 6 | missing |

## Phase 0 non-functional rules

| ID | Rule |
|---|---|
| N-1 | No runtime dependencies; Node 20.12 or newer |
| N-2 | ESM `.mjs` only |
| N-3 | Tests use `node:test`, run with `npm test`, and never touch the real `state.json`, `events.jsonl` or `runs/` |
| N-4 | Phase 0 changes no behaviour: the characterization suite passes before and after the refactor |
| N-5 | Bugs found while characterizing go to `KNOWN_ISSUES.md`; they are fixed in the phase that owns them |

# Implementation plan: harness-agnostic, gated AI SDLC with usage telemetry

Status: Phases 0–8 implemented, including the **planning stage redesign** (`plans/planning-stage-redesign.md`): ingest → grill/synthesize → `SRS.md` → persona tickets with AC test cases; `test_plan` / `gate_plan` removed. Phase 8's real baseline still needs your sample app and five specs (see `docs/BASELINE.md`); the scripted baseline runs in CI. Deviations from this plan are listed in section 9. How to install and run on another repo: section 10.
Scope decisions below come from the planning discussion; items marked **[proposed]** are my recommendations and still need your confirmation.

## 1. Goal

Set up and monitor a software development lifecycle in which a main (orchestrator) agent drives specialised subagents from an initial requirement to a raised GitHub PR. It installs on top of any agent harness (Cursor, Claude Code, Hermes, and similar). Humans approve at every stage except implementation. Usage metrics go to a central database and are shown to admins on a dashboard.

### Target pipeline

| # | Stage | Executor | Human gate on exit |
|---|---|---|---|
| 1 | **Planning** — ingest, grill/synthesize, `SRS.md`, persona tickets, AC `test_cases` | main agent + read-only sub-agents | yes (`gate_spec`) |
| 2 | Architecture and engineering review → `approach.md` | `solution-architect` | yes (`gate_approach`) |
| 3 | ATDD: Playwright product tests from ticket scenarios, then frozen | `test-architect` | yes (`gate_tests`) |
| 4 | Implementation, with unit tests written by the implementer | `implementer` | **no** |
| 5 | Independent code review | `code-reviewer` | yes (`gate_review`) |
| 6 | Verify tiers + evidence bundle | `verifier` | yes (`gate_final`) |
| 7 | GitHub PR | main agent | yes (final approval before `gh pr create`) |

Workflow stage ids: `planning` → `gate_spec` → `feasibility` → `gate_approach` → `tests` → `gate_tests` → `implement` → `review` → `gate_review` → `verify` → `gate_final` → `pr`. State schema **3**; paused schema-2 runs map `grill_spec` → `planning` and drop `test_plan` / `gate_plan`.

Rules that follow from the decisions:
- Implementation only starts after **SRS + tickets** (stage 1) and the approved approach (stage 2) are in place, and product tests are frozen at `gate_tests`.
- Product scenarios live on ticket acceptance criteria (`PRD-n.m` / `TECH-*`); Playwright code is written in `tests`, not in a separate `test-plan.md` stage.
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
| Dashboard | Admin-only: time per stage, errors, gates held back by users, agent failures, retries, **human escalation counts** (planning grill), **sub-agent timings** (`agent_run`; `no_stop` when hooks miss a stop). |
| Ingestion service | Part of the server that serves the dashboard. |

## 2. Current state (baseline)

This section described gaps at the start of the project. **As built today** (including the planning redesign):

| Area | Shipped |
|---|---|
| Stage machine | `workflow.json` schema 3; `planning` through `pr`; six human gates; `loop_caps` (including `grill` for planning rounds) |
| Planning | `/wf-start` orchestrates ingestor, griller, synthesizer, srs-writer, ticket-writer, acceptance-test-writer; artifacts `SRS.md`, `grill/questions.json`, `tickets/**/*.json`; `wf tickets check`; optional `/wf-jira-tickets` after `gate_spec` |
| Spec artifact | **`SRS.md`** (IEEE-style sections), not a single `bmad-spec`/`SPEC.md` interview |
| Architecture | `solution-architect` → `approach.md` with ADR sections |
| Tests | `test-architect` ATDD from ticket `test_cases`; no `test_plan` / `gate_plan` |
| Implementation / review / verify / PR | As in section 1; independent `code-reviewer`; Playwright-oriented verify |
| Enforcement | Core + Cursor / Claude / generic adapters; hooks include `subagentStart` / `subagentStop` telemetry |
| Telemetry | Local queue + sync; server views `agent_timings`, `run_human_escalations` |
| Installer | `installer/install.mjs` copies skills/agents from `capabilities.json` |

Remaining gaps vs the original ambition: real baseline on five live specs (Phase 8), Hermes adapter, optional MCP exploratory verify, password reset.

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

Types: `run_started`, `stage_started`, `stage_completed`, `gate_requested`, `gate_approved`, `gate_rejected`, `loop_round` (with round number and cap), `agent_failed`, `guard_blocked`, `error` (with `error_class`: test_failure, agent_crash, timeout, guard_block, tool_error), `scrub_hit` (category and count only), `session_unchecked` (harness gave no content hooks), `run_ended`, **`human_escalations`** (planning: count only, no question text), **`agent_run`** (sub-agent `started_at` / `ended_at` / `duration_ms` / `status`, including `no_stop` when a hook stop is missing). Local hook types `subagent_start` / `subagent_stop` pair into `agent_run`; never persist `task`, `summary`, or transcript paths from hook payloads.

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

## 4. Stage capabilities: skills, commands, rules and sub-agents

The pipeline only works if each stage has the right capabilities behind it. This section lists what exists, what is missing, and what to add, stage by stage. The agents and skills in this section were approved on review and can be refined during final testing of the workflow. Items still marked elsewhere in the plan are unconfirmed.

### 4.1 Inventory today

| Kind | What exists | Notes |
|---|---|---|
| Stage skills | `wf-run`, `wf-start`, `wf-research`, `wf-spec-review`, `wf-feasibility`, `wf-tests`, `wf-implement`, `wf-review`, `wf-verify`, `wf-pr`, `wf-approve`, `wf-reject`, `wf-pause`, `wf-resume`, `wf-abort`, `wf-unblock`, `wf-goto`, `wf-gate-brief`, `wf-jira-tickets`, `persona-ui-ux`, `persona-fe`, `persona-be`, `persona-qa`, `wf-playwright-e2e` | Slash-only. Planning orchestration is `/wf-start`. |
| BMAD skills | `bmad-spec`, `bmad-advanced-elicitation`, `bmad-deep-recon`, `bmad-project-context`, `bmad-review`, `bmad-code-review`, `bmad-walkthrough` | Not used as the primary SRS writer; optional lenses during spec review or research. |
| Other skills | `frontend-design`, `unit-testing-test-generate`, `product-quality-assurance` | `product-quality-assurance` on `tests` stage; others slash-only or implement. |
| Sub-agents | **Planning:** `requirements-ingestor`, `requirements-griller`, `requirements-synthesizer`, `srs-writer`, `ticket-writer`, `acceptance-test-writer`, `product-researcher`. **Later stages:** `solution-architect`, `test-architect`, `implementer`, `code-reviewer`, `verifier` | All Cursor format (`.cursor/agents/`). Planning agents are read-only. |
| Rules | Stack packs under `.agent-workflow/rules/` plus `standards.md` | Includes Ingestion, Grilling, Synthesis, SRS format, Ticket format, Persona tickets. |
| Main-agent instructions | `AGENTS.md` | Conductor: status first, never self-approve gates. |

### 4.2 Design rules

1. **Agent or skill?** Use a sub-agent only when one of these is the point: an independent context (reviewer, verifier), a read-only guarantee (researcher, architect), bulky output that would flood the main context (research, exploratory testing), or parallel work. Everything else is a skill or a `standards.md` section. This keeps the agent count low.
2. **Deterministic first.** Every artifact a stage produces gets a structural check in `wf.mjs` (`done` refuses otherwise). A prompt is never the only control.
3. **Single source for lists.** Checklists live once in `standards.md` and are loaded by heading. Skills point to them and never copy them.
4. **Thin skills, on-demand references.** A `SKILL.md` stays under about 150 lines. Detail goes in `references/` files read only when needed. This is what keeps token use down.
5. **Judges get fresh context.** The code reviewer, verifier, and acceptance-test-writer never see the implementer's transcript. They get SRS, tickets, approach, diff and standards as appropriate.
6. **Read-only by construction.** Researcher, architect and reviewer agents have no write tool except the one output file. The validator (Phase 1B) checks this.
7. **Sources or it didn't happen.** Research output separates sourced fact (URL and date), inference, and unknown. A claim with no source fails the check.
8. **Optional until triggered.** Research and specialist lenses (security, data, UI, LLM prompts) run only when the interview or the architect flags a trigger. This controls cost and gate fatigue.
9. **No real data.** Fixtures and test accounts never contain real PHI/PII or secrets, and research notes never include internal data.
10. **Neutral format first, packaging later.** Phase 1B authors capabilities once in a neutral layout plus a manifest. Phase 7 renders them into each harness's folders.

### 4.3 Stage by stage

#### Stage 0: Intake (`wf run`)
- **Today:** `wf-run` takes a Jira key, pasted ticket or free text. `bmad-project-context` exists but nothing runs it.
- **Gaps:** no project context file for agents to read, so each stage rediscovers the stack, structure, conventions and commands. Nothing says which rule pack applies.
- **Add:**
  - Skill `wf-onboard`: the init step. It runs `bmad-project-context` and writes `project-context.md`, detects the stack, and installs the matching rule pack. It runs as part of `wf init`, which requires a logged-in user once login exists (Phase 5). Before then it runs without the login check.
  - **Stack detection is dynamic.** `wf init` reads the key files in the codebase (`package.json`, `Pipfile`, `pyproject.toml`, `requirements*.txt`, `pom.xml`, `build.gradle`, `go.mod`, `Cargo.toml`, `Gemfile`, `composer.json`, lockfiles, framework config files) and records the languages, frameworks, test runner, linter, package manager and the lint, unit and start commands. It fills in `config.json` (`commands`, `src_globs`, `test_globs`) from what it finds.
  - Rules: a `rules/` pack per stack. Three ship first: Python (Django, DRF, Postgres), TypeScript with React, and a generic fallback. For a stack with no shipped pack, `wf init` has an agent draft one from the detected files and the framework's own documentation. The draft is saved in the project for a human to review and approve before the implementer uses it, so an unreviewed pack is never trusted. `wf init --refresh` re-detects when a manifest file changes.
  - Main-agent file: grows from a pointer into the conductor rules (section 4.4).

#### Stage 1: Planning (`planning`, `gate_spec`)

- **Shipped flow** (see `plans/planning-stage-redesign.md` and skill `wf-start`):
  1. `requirements-ingestor` → `draft-requirements.md` (MCP + repo sources).
  2. Grill loop (cap `loop_caps.grill`, default 5): `requirements-griller` → `requirements-synthesizer` (Confluence + repo only); `UNANSWERABLE` → human one question at a time → `grill/questions.json`.
  3. `srs-writer` → `SRS.md` (sections 1–7, `REQ-n`, Non-goals).
  4. `ticket-writer` (+ persona-* skills) → `tickets/<persona>/*.json`.
  5. `acceptance-test-writer` (fresh context) → fills `test_cases` on each AC (`PRD-n.m`, Given/When/Then).
  6. `node .agent-workflow/wf.mjs tickets check` then `/wf-spec-review` then `done planning`.
- **Optional:** `/wf-research` → `research.md`; `/wf-jira-tickets` after `gate_spec` if Atlassian MCP connected and human opts in.
- **Checks:** `SRS.md` structure and REQ success lines; all grill questions answered with allowed sources for synthesis; tickets cover every REQ and every AC has test cases; `tickets_hash` at approve (replaces old `test_plan_hash`).
- **Telemetry:** `human_escalations` count on `done planning`; sub-agent `agent_run` rows from hooks (or `wf agent start|end` on generic harness).

#### Stage 2: Architecture and technical decisions (`feasibility`, `gate_approach`)
- **Shipped:** `solution-architect` (read-only) via `/wf-feasibility`. Reads **`SRS.md`**, `research.md`, project context. Produces `approach.md` with verdict, options, decision record, non-functional notes, risks, rollback.
- **Checks:** as in `standards.md` Feasibility rubric and Architecture decision record.

#### Stage 3: Product tests (`tests`, `gate_tests`)

- **Shipped:** Scenarios come from ticket `test_cases` (written in planning). `test-architect` runs in **ATDD** mode only via `/wf-tests`; writes Playwright under `product_test_globs`. `done tests` requires red-for-the-right-reason failures citing `REQ` / `PRD` / `TECH` ids; freeze hash at `gate_tests`.
- **Rules:** Playwright conventions, Technical scenario checklist on ticket ACs; `product-quality-assurance` on the tests stage.
- **Removed:** `test_plan`, `gate_plan`, `wf-test-plan`, and `test-plan.md` as a pipeline artifact.

#### Stage 4: Implementation (`implement`)

- **Shipped:** `implementer` reads **SRS + tickets** and approved approach; owns unit tests; cannot edit frozen product tests. Stop hook retries up to `loop_caps.implement`; stuck loop → `/wf-unblock`.
- **Rules:** stack packs from `wf-onboard`, dependency and migration policy, Coding rules.

#### Stage 5: Review (`review`, `gate_review`)

- **Shipped:** Independent `code-reviewer`; inputs SRS, approach, diff; four-axis `review.md`. Reject `gate_review` → `implement`. Optional `bmad-walkthrough` at the gate.

#### Stage 6: Verification and E2E (`verify`, `gate_final`)

- **Shipped:** `verifier` runs configured tiers; every automated `PRD-n.m` from tickets must have a passing test; evidence under `runs/<id>/evidence/`. Playwright via `commands.e2e` / `webServer` in project config.

#### Stage 7: Pull request (`pr`)

- **Shipped:** `/wf-pr` after `gate_final`; `wf adr` for decision record; PR body from `pr-summary.md` + structured sections; `gh pr create`.

### 4.4 Cross-cutting capabilities

| Capability | Why it is needed | Proposal |
|---|---|---|
| Conductor rules | The main agent must know how to orchestrate: status first, follow `next_action`, never self-approve a gate, stop and wait at gates, dispatch the right sub-agent with a clear brief, report escalations. Today `AGENTS.md` is a pointer. | Expand the main-agent file into the conductor ruleset. Phase 7 emits it as `AGENTS.md`, `CLAUDE.md` or the harness equivalent. |
| Gate brief | Six gates risk gate fatigue and rubber-stamping. Humans need a digest, not the whole artifact. | **Shipped:** `wf brief` + `wf-gate-brief`. At `gate_spec`, facts include SRS REQ count, tickets per persona, test case count, synthesis vs human grill answers, escalation count. |
| Escalation handling | When a loop cap or stuck-loop stop fires, the run stalls. | **Shipped:** `wf escalation list/retry/reject/abort` and `wf-unblock`. Planning grill cap uses the same pattern. |
| Capability manifest and validator | The pieces must stay consistent as they multiply. | **Shipped:** `capabilities.json` + `wf doctor`. |
| Sub-agent contract | Agents differ in tools, model and output format. | **Shipped:** `.cursor/agents/*.md` + `docs/adapter-contract.md` (hooks, no PHI in telemetry). |
| Jump to a stage | Users sometimes need to start mid-pipeline. | **Shipped:** `wf goto <stage>` (human-only). Forwards require SRS/tickets + approach checks, not `test-plan.md`. |
| Lessons learned | Repeated review findings should become rules instead of repeating. | Optional `wf-retro` skill after a run, writing proposed rule changes for human approval. Not in Phase 1B. |

Suggested model tier per agent (proposed, harness permitting): strongest for `solution-architect` and `code-reviewer` (judgement), strong for `implementer` and `test-architect`, fast for `product-researcher` summaries, `verifier` and gate briefs.

### 4.5 Skills and agents by stage (as shipped)

| Stage | Skills | Agents |
|---|---|---|
| Intake | `wf-run`, `wf-onboard` | — |
| Planning | `wf-start`, `wf-research`, `wf-spec-review`, `persona-ui-ux`, `persona-fe`, `persona-be`, `persona-qa` | ingestor, griller, synthesizer, srs-writer, ticket-writer, acceptance-test-writer, product-researcher |
| `gate_spec` | `wf-approve`, `wf-reject`, `wf-gate-brief`, `wf-jira-tickets` | — |
| Feasibility | `wf-feasibility` | solution-architect |
| `gate_approach` | approve / reject / gate-brief | — |
| Tests | `wf-tests`, `wf-playwright-e2e`, `product-quality-assurance` | test-architect |
| `gate_tests` | approve / reject / gate-brief | — |
| Implement | `wf-implement`, `unit-testing-test-generate`, `frontend-design` | implementer |
| Review | `wf-review` | code-reviewer |
| `gate_review` | approve / reject / gate-brief | — |
| Verify | `wf-verify`, `wf-playwright-e2e` | verifier |
| `gate_final` | approve / reject / gate-brief | — |
| PR | `wf-pr` | — |
| Anywhere | `wf-pause`, `wf-resume`, `wf-abort`, `wf-unblock`, `wf-goto` | — |

### 4.6 What I would not build
- A separate agent for each lens. Lenses are `standards.md` sections applied by the architect or reviewer.
- A planner or project-manager agent. Gates already do that job and the stage graph is fixed.
- A deployment agent. Deployment is out of scope (decision in section 1).
- Automatic research on every run. It costs tokens and adds unreviewed claims; it stays opt-in.
- Anything that approves a gate. Approval stays a human command.

## 5. Roadmap

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

### Phase 1B: Stage capabilities (skills, commands, rules, sub-agents)
Inserted between Phase 1 and Phase 2 so the stage executors exist before the test model is rebuilt. It keeps the existing numbering; later phases are unchanged. Section 4 is the design; this is the work.

Scope split, stated plainly: Phase 1B builds everything that does not depend on the Playwright test model (stages 0, 1, 2, 4, 5, 7 and the cross-cutting pieces). For stages 3 and 6 it writes only the contracts (agent specs and the manifest entries); Phase 2 fills them in.

- **Manifest and validator:** `.agent-workflow/capabilities.json` mapping each stage to its skill, agent, rule sections and artifact check. `wf doctor` validates it.
- **Core commands:** `wf adr`, `wf brief <gate>`, `wf escalation list|retry|reject|abort`, `wf doctor`, `wf goto <stage>` (approved), and `wf init [--refresh]` with dynamic stack detection.
- **New checks (in `lib/postconditions.mjs`):** planning checks `SRS.md`, `grill/questions.json`, persona tickets (`lib/tickets.mjs`); spec quality / non-goals; research sources when present; `approach.md` decision record; `review.md` axes.
- **New skills:** `wf-onboard` (run by `wf init`), `wf-research`, `wf-spec-review`, `wf-gate-brief`, `wf-unblock`.
- **New or changed agents:** `product-researcher` (new), `solution-architect` (replaces `feasibility-analyst`), `code-reviewer` (new, independent), `implementer` (brief changed: owns unit tests), and contract-only specs for the Phase 2 `test-architect` and `verifier` changes.
- **Rulesets:** new `standards.md` sections (research rubric, spec quality, architecture decision record format, security and privacy lens, data and migration lens, dependency policy, review finding format, PR summary guide, gate brief format); stack rule packs under `rules/` (Python, TypeScript/React, generic fallback shipped; others drafted at init and human-approved); the conductor ruleset in the main-agent file.
- **Cleanup:** every skill and agent text re-checked for removed commands and gate names; each `SKILL.md` kept under about 150 lines with detail in `references/`.

**Deliverable:** a run goes from intake to a reviewed PR with each stage backed by a named skill or agent, every produced artifact checked structurally, and `wf doctor` reporting a consistent capability set.
**Tests:**
- `wf doctor` against fixture trees: a stage with no capability, a manifest entry pointing at a missing skill, a skill or agent not referenced anywhere, a read-only agent with a write tool, duplicate skill names across folders, a `SKILL.md` over the size limit, and any reference to `gate1`, `gate2`, Gerrit or `refs/for`.
- Postcondition tests for each new artifact check, passing and failing cases.
- `wf init` on fixture projects (a Node project, a Python project, a project with only a `pom.xml`, an empty directory): detects the stack, picks the right pack or the fallback, fills `config.json`, never overwrites local edits, and `--refresh` picks up a changed manifest. A drafted pack stays unapproved until a human approves it.
- `wf goto`: backwards always works; forwards works only when every earlier artifact passes its check; a gate cannot be jumped past without its approval; each jump emits an event.
- `wf brief` returns the expected facts for each gate on a seeded run (including rejection history). `wf escalation` actions clear `status --check`, reset the right counters and emit events.
- The existing pipeline walk test still passes with the new checks, using stub artifacts.
- Not testable by script: whether an agent's prose is good. That is covered by a manual walkthrough on the sample app and later by the Phase 8 baseline.

### Phase 2: Test model and E2E stage
- Split tests into product/flow (Playwright, `E2E/tests/**`) and unit (implementer-owned).
- The test stage writes Playwright scripts from **`SRS.md`, ticket `test_cases`, and `approach.md`**; they are frozen at `gate_tests`.
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
- An installer that adds the core, config, skills/agents and the right adapter into any project, then hands over to `wf init` (after the user logs in) for stack detection, rule pack selection and the first-run config.
- Claude Code adapter first, then Cursor (already extracted in Phase 0), then Hermes once its hook and subagent capabilities are known.
- Fallback for harnesses without hooks: gates are enforced by a git hook and CI check, and `session_unchecked` is recorded.

**Deliverable:** one-command install into an empty project for each supported harness.
**Tests:** installation into a temp project per harness; a contract test suite that every adapter must pass (deny a write outside the stage, block `git commit` before approval, emit events); an upgrade test that reinstalling does not clobber local config.

### Phase 8: Baseline and hardening
- Pick a sample app and five specs, run the full pipeline on each, and record time, retries, errors and cost per stage.
- Document operations: server setup, backups, retention, and incident steps.

**Deliverable:** a recorded baseline and a runbook.
**Tests:** five end-to-end runs with at least three completing with no manual fix; the dashboard reproduces the recorded numbers.

## 6. Dependencies between phases

0 → 1 → 1B → 2. Phases 3, 4 can start in parallel after 0. Phase 2 needs 1B for its agent contracts. Phase 5 needs 3 and 4. Phase 6 needs 4 and 5. Phase 7 needs 1B and 2 (it packages the skills and agents), and its telemetry parts need 3 to 5. Phase 8 is last.

## 7. Risks

| Risk | Mitigation |
|---|---|
| Harnesses expose different hooks, so gates and risk checks are uneven | Adapter contract tests; `session_unchecked` status; git/CI fallback |
| Scrubber misses a PII pattern | Pattern file, corpus tests that grow with each miss, honest indicator wording |
| Server becomes a scope sink | Keep one deployable, small API, dashboard on the same server |
| Gate fatigue from a gate at every stage | Record gate wait time on the dashboard to see it |
| Local queue fills the disk after a long outage | Retention cap and a visible warning |
| Hermes capabilities are unknown | Adapter built last, after a short capability check |
| Too many agents and skills, each adding tokens and drift | Agent-or-skill rule (4.2), `wf doctor`, thin skills with on-demand references |
| Research agent states unsourced or stale claims as fact | Source and freshness rule enforced by a check; research is opt-in and reviewed at `gate_spec` |
| Independent reviewer still agrees with the implementer's blind spots | Fresh context, explicit rubric, conditional lens passes, and the human gate |
| A prompt change quietly weakens a stage | Deterministic checks stay the control; Phase 8 baseline compares before and after |

## 8. Open items

- Sample app and the five specs for the baseline (to be shared).
- Playwright is the default E2E tool for now. MCP-driven testing can be revisited later.
- Server technology and hosting **[proposed: Node/TypeScript, one deployable]**.
- Hermes hook and subagent capabilities.
- Phase 1B decisions made: the proposed agents and skills are approved (refine during final testing); `wf goto` is in; decision records are copied into the PR as a summary of two lines at most, which AI may write; the research agent may use web search, read READMEs and docs, and explore the codebase or use cached summaries; rule packs ship for Python, TypeScript/React and a generic fallback, and other stacks are detected and drafted at init for human approval.
- Still open: suggested model tiers per agent (harness permitting); where the drafted-pack approval is recorded; which web search tool each harness provides to the research agent.
- Password reset flow (admin-triggered reissue of an invite is the minimal option).

## 9. Deviations made while building Phases 3–8

- **Password hashing:** scrypt (built into Node) instead of argon2id or bcrypt, to avoid a native module. Memory-hard and salted; cost parameters are in `server/src/crypto.mjs`.
- **Postgres in tests:** a throwaway local cluster (`initdb` and `pg_ctl`) instead of a container, to keep the suite runnable without Docker. CI can use either by setting `PG_BIN` or pointing at a service container.
- **Server language:** plain JavaScript (ESM) rather than TypeScript, to match the CLI and avoid a build step. The only runtime dependency is `pg`.
- **Rate limiter:** in memory, so one server process. Noted in `docs/RUNBOOK.md`.
- **Dashboard tests:** Playwright 1.49's ESM loader hangs on Node 24, so the UI tests and their global setup are CommonJS and start the stack in a child process.
- **Risk indicator:** computed server-side as a view over events (`session_unchecked` beats `scrub_hit` beats none). The scrubber also scans commands and paths that hooks see, keeping only category and count.
- **Hermes:** no dedicated adapter. It is served by the `generic` adapter (git hooks and CI) until its capabilities are checked.
- **Real baseline:** not recorded on a live app. Scripted five-run baseline with stub planning artifacts validates telemetry in CI.
- **Planning redesign (2026):** `grill_spec` → `planning`; removed `test_plan` / `gate_plan`; persona tickets + `wf tickets check`; telemetry `human_escalations` and `agent_run`; see `plans/planning-stage-redesign.md`.
- **Event types:** `run_ended` added so the server can distinguish completed, aborted and paused runs.

## 10. Running the workflow on another repository

Use this when the **workflow package** lives in `bmad-based-sdlc-workflow` (or a fork) and the **code you build** lives elsewhere (your product repo).

### Prerequisites on the target project

- Git repo with `origin` on GitHub (for the `pr` stage).
- Node 20.12+, `gh` authenticated, Cursor (or Claude Code / generic harness).
- A realistic dev command the workflow can detect (`package.json` scripts, `pyproject.toml`, etc.).

### Install (once per project)

From the machine that has both trees checked out:

```bash
WF=/path/to/bmad-based-sdlc-workflow
APP=/path/to/your-app

node $WF/installer/install.mjs --target $APP --harness cursor
# optional telemetry:
# node $WF/installer/install.mjs --target $APP --harness cursor --server https://wf.example.com
```

Then in `$APP`:

```bash
node .agent-workflow/wf.mjs init
```

Open `$APP` in Cursor, run `/wf-onboard`, approve rule packs (`wf init --approve-pack …`), and set `config.json` commands (`unit`, `lint`, `e2e`, `product_test_globs`, `dev_url`) for your stack.

### Smoke without LLM agents (sanity)

Follow `docs/PHASE1_MANUAL_TEST.md` in the workflow repo: copy planning fixtures from `.agent-workflow/test/fixtures/planning-minimal/` into `specs/spec-<id>/`, then walk gates with `wf done` / `wf approve`. Confirms hooks and stage order on **your** tree.

### Full agent run (what you implemented)

1. In Cursor on `$APP`: `/wf-run "Add export CSV on the orders list"` (or a Jira key if Atlassian MCP is connected).
2. Let `/wf-start` run the planning pipeline (ingest → grill → SRS → tickets → ACs). Watch `node .agent-workflow/wf.mjs status` and `node .agent-workflow/wf.mjs tickets check`.
3. At **`gate_spec`**: `/wf-gate-brief`, read `specs/spec-<id>/SRS.md` and `tickets/`, then `/wf-approve gate_spec`.
4. **`feasibility`** → approve approach letter → **`tests`** (Playwright red) → **`gate_tests`** → implement → review → verify → **`gate_final`** → `/wf-pr`.

### Good first features to try

| Idea | Why it exercises the flow |
|---|---|
| Small CRUD or filter on an existing screen | REQ + UI/FE/BE tickets, a few `PRD-n.m` e2e cases |
| “Add health check endpoint” | Mostly BE ticket, fast feasibility |
| Bug fix with clear repro | Short grill; one REQ; minimal tickets |

Avoid “rewrite the architecture” as the first run: planning grill cap and ticket traceability are easier to validate on a bounded change.

### Telemetry check (optional)

After a run with `--server` configured: `node .agent-workflow/wf.mjs sync`, then on Postgres query views `agent_timings` and `run_human_escalations` for your `run_id` (see `server/src/migrations/002_planning_metrics.sql`).

### Where to read more

- Operator flow: `docs/USER_GUIDE.md`
- Adapter/hook behaviour: `docs/adapter-contract.md`
- Design record: `plans/planning-stage-redesign.md`

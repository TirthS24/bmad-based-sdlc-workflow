# Implementation plan: harness-agnostic, gated AI SDLC with usage telemetry

Status: Phases 0 and 1 implemented; Phase 1B (stage capabilities) and Phases 2–8 pending.
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

## 4. Stage capabilities: skills, commands, rules and sub-agents

The pipeline only works if each stage has the right capabilities behind it. This section lists what exists, what is missing, and what to add, stage by stage. The agents and skills in this section were approved on review and can be refined during final testing of the workflow. Items still marked elsewhere in the plan are unconfirmed.

### 4.1 Inventory today

| Kind | What exists | Notes |
|---|---|---|
| Stage skills | `wf-run`, `wf-start`, `wf-feasibility`, `wf-test-plan`, `wf-tests`, `wf-implement`, `wf-review`, `wf-verify`, `wf-pr`, `wf-approve`, `wf-reject`, `wf-pause`, `wf-resume`, `wf-abort` | Slash-only. One per stage plus human controls. |
| BMAD skills | `bmad-spec`, `bmad-advanced-elicitation`, `bmad-deep-recon`, `bmad-project-context`, `bmad-review`, `bmad-code-review`, `bmad-walkthrough` | Only some are wired into a stage. `bmad-deep-recon` (research packs), `bmad-project-context`, `bmad-review` lenses and `bmad-walkthrough` are not used by any stage yet. |
| Other skills | `frontend-design`, `unit-testing-test-generate`, `product-quality-assurance`, `prompt-engineering-xml` | Slash-only, not tied to a stage. |
| Sub-agents | `feasibility-analyst`, `test-architect`, `implementer`, `verifier` | All Cursor format (`.cursor/agents/`). |
| Rules | `backend-rules-md.mdc` (Django, DRF, GraphQL, Postgres), `frontend-rules-md.mdc` (TypeScript, React) | Written for one project's stack. |
| Rulesets in `standards.md` | Edge-case checklist, technical scenario checklist, feasibility rubric, review rubric, coding rules | Loaded by heading. |
| Main-agent instructions | `AGENTS.md` | Short pointer: check status, follow `next_action`. |

### 4.2 Design rules

1. **Agent or skill?** Use a sub-agent only when one of these is the point: an independent context (reviewer, verifier), a read-only guarantee (researcher, architect), bulky output that would flood the main context (research, exploratory testing), or parallel work. Everything else is a skill or a `standards.md` section. This keeps the agent count low.
2. **Deterministic first.** Every artifact a stage produces gets a structural check in `wf.mjs` (`done` refuses otherwise). A prompt is never the only control.
3. **Single source for lists.** Checklists live once in `standards.md` and are loaded by heading. Skills point to them and never copy them.
4. **Thin skills, on-demand references.** A `SKILL.md` stays under about 150 lines. Detail goes in `references/` files read only when needed. This is what keeps token use down.
5. **Judges get fresh context.** The code reviewer and verifier never see the implementer's transcript. They get the spec, approach, diff and standards.
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

#### Stage 1: Specification (`grill_spec`, `gate_spec`)
- **Today:** `wf-start` runs `bmad-spec` interactively and `done grill_spec` checks REQ ids and success lines.
- **Gaps:**
  - No research. Specs for a new product surface need market, competitor, user-voice and domain input, but the interview never asks for it.
  - No pass that attacks the spec for ambiguity, missing edge cases or untestable success lines before the human sees it.
  - No non-goals, personas or priority check in the structural test.
- **Add:**
  - Agent `product-researcher`: read-only, uses `bmad-deep-recon` packs (market, competitive, domain, user-voice, technical, academic). Returns `research.md` with sourced facts, inferences and unknowns. Triggered by the interview when the requirement is new, competitor-driven or in an unfamiliar domain, never by default.
  - Skill `wf-research`: the human or the interview invokes it. Chooses the pack, sets the freshness window, dispatches the agent and links the result into `SPEC.md`.
  - Skill `wf-spec-review`: a lens pass using `bmad-review` (adversarial, edge-case hunter, structure, prose) on `SPEC.md`. Runs before `gate_spec`. It reuses existing lenses; no new agent.
  - Skill reuse: `bmad-spec`, `bmad-advanced-elicitation` (for hard requirements).
  - Rules in `standards.md`: a research rubric (sources, freshness, how to mark inference) and spec quality rules (non-goals present, every REQ testable, personas where users are involved).
  - Check: `SPEC.md` has a non-goals section; if `research.md` exists, every claim has a source.

#### Stage 2: Architecture and technical decisions (`feasibility`, `gate_approach`)
- **Today:** `feasibility-analyst` returns a verdict and two or three approaches with blast radius.
- **Gaps:** this is a codebase check, not a solution architect's output. It does not record decisions with their trade-offs, does not cover non-functional needs (security, privacy, performance, migrations, observability, cost, rollout and rollback), does not research build-versus-buy or library choice, and its decisions do not outlive the run.
- **Add:**
  - Agent `solution-architect`: replaces `feasibility-analyst` (the stage id `feasibility` stays, so state and tests are unaffected). Read-only. Reads `SPEC.md`, `research.md` and `project-context.md`. Produces `approach.md`: verdict, 2–3 options, a decision record for the recommended option (context, options, decision, consequences), non-functional section, risks and mitigations, rollout and rollback, and the single-commit-fit line.
  - Skill `wf-feasibility` stays as the entry point, renamed in text to "architecture review".
  - Conditional lenses, loaded as `standards.md` sections rather than agents: security and privacy (auth, PHI/PII, secrets, logging), data and migrations (expand/contract, rollback), integration and failure modes, and cost. The architect applies the ones its triggers match and says which it skipped and why.
  - Technical research: the architect may dispatch `product-researcher` with the technical pack for library or service choices.
  - Persistence (approved): at PR time a short decision record of two lines at most (the decision and the reason, AI-written if needed) is added to `docs/adr/NNNN-title.md` in the PR, so the reasoning outlives `runs/`. The full `approach.md` stays local.
  - Check: `approach.md` has a verdict, at least two options, a decision record, a non-functional section, a risks section and a rollback line.

#### Stage 3a: Test plan (`test_plan`, `gate_plan`)
- **Today:** `test-architect` in plan mode writes a two-tier `test-plan.md`; the check requires every REQ covered and each scenario tagged by layer and automated/manual.
- **Gaps:** nothing separates product/flow scenarios (Playwright, frozen) from technical ones (unit, implementer-owned). Test data, environment and flake risk are not planned. UI states and accessibility depend on the writer remembering.
- **Add (built in Phase 2):**
  - `test-architect` is narrowed to the plan and the Playwright product tests. Unit tests move to the implementer.
  - Rules: Playwright conventions (role-based locators, no fixed sleeps, one flow per test, tags `@REQ-n`/`@PRD-n.m`, fixtures for auth and data), and a test-data rule (synthetic data only).
  - Skill reuse: `product-quality-assurance`.
  - Check: every product scenario names a Playwright file; every REQ maps to at least one product scenario.

#### Stage 3b: Product tests (`tests`, `gate_tests`)
- **Today:** `test-architect` in ATDD mode; `done tests` requires failures that cite scenario ids.
- **Add (built in Phase 2):** skill `wf-playwright-e2e` with the authoring conventions and the commands to run one test; the red-for-the-right-reason check also rejects tests that fail because the app is not running.

#### Stage 4: Implementation (`implement`)
- **Today:** `implementer` with the stack's rule file; the stop hook retries up to the cap.
- **Gaps:**
  - It uses whichever rule file matches its Python/TypeScript guess; other stacks have none.
  - Unit tests are frozen with the product tests today (Phase 2 changes this).
  - No rules for adding dependencies, writing migrations or handling secrets.
  - When the cap is hit nothing tells the human how to continue (section 4.4).
- **Add:**
  - Stack rule packs chosen by `wf-onboard`, plus a generic fallback.
  - Rules: dependency policy (ask before adding), migration policy (expand/contract, reversible), secrets and logging policy (never log PHI/PII, which exists as a line today).
  - Skill reuse: `unit-testing-test-generate` (for the unit tests it now owns), `frontend-design` (when a UI surface is in `config.json`).
  - Agent: `implementer` stays; its brief changes to "own unit tests, do not touch product tests".

#### Stage 5: Review (`review`, `gate_review`)
- **Today:** `/wf-review` runs `bmad-code-review` on the main thread, the same agent that coordinated the implementation.
- **Gaps:** the reviewer is not independent. The review lens set is fixed. `review.md` has no required structure beyond tagged findings. The human gets a wall of findings with no walkthrough.
- **Add:**
  - Agent `code-reviewer`: fresh context, read-only plus one output file. Inputs are the spec, the approved approach, the diff against the baseline and `standards.md`. It runs the four-axis rubric and writes `review.md`.
  - Conditional lens passes through `bmad-code-review` layers and `bmad-review` lenses: security and privacy, test quality, edge cases.
  - Skill reuse: `bmad-walkthrough` offered at `gate_review` so the human can be walked through the change.
  - Fixes stay with `implementer` (a `gate_review` rejection or a high finding returns to `implement`), so the reviewer never edits code.
  - Check: `review.md` has one section per axis and every finding carries a severity tag.

#### Stage 6: Verification and E2E (`verify`, `gate_final`)
- **Today:** `verifier` explores in Cursor's built-in browser and `done verify` runs the configured commands.
- **Gaps:** no Playwright run, no app start/stop or health check, no seeded data, no traces. The evidence bundle has no required shape. Flaky tests have no policy.
- **Add (built in Phase 2):**
  - `verifier` is reframed as a runner and reporter: starts the app, seeds data, runs the frozen Playwright suite, retries a failure once and marks it flaky if it then passes, collects the HTML report, traces, screenshots and an accessibility scan, and maps failures back to REQ ids.
  - Config: `commands.start`, a health URL and seed command in `config.json`.
  - Skill reuse: `wf-playwright-e2e`.
  - Exploratory browser or MCP testing stays optional and harness-specific (open item).
  - Check: evidence bundle contains the report and one result per product scenario.

#### Stage 7: Pull request (`pr`)
- **Today:** `wf-pr` commits, writes the change summary, and `wf pr` pushes and opens the PR.
- **Gaps:** the summary is free text with no format guidance beyond the skill; there is no check that it matches the diff; decision records are not persisted.
- **Add:**
  - Rules: a PR summary guide in `standards.md` (what and why by area, no file lists, no code).
  - The two-line decision record (see Stage 2) and a docs/changelog prompt when behaviour visible to users changed.
  - No new agent; the main agent writes the summary.

### 4.4 Cross-cutting capabilities

| Capability | Why it is needed | Proposal |
|---|---|---|
| Conductor rules | The main agent must know how to orchestrate: status first, follow `next_action`, never self-approve a gate, stop and wait at gates, dispatch the right sub-agent with a clear brief, report escalations. Today `AGENTS.md` is a pointer. | Expand the main-agent file into the conductor ruleset. Phase 7 emits it as `AGENTS.md`, `CLAUDE.md` or the harness equivalent. |
| Gate brief | Six gates risk gate fatigue and rubber-stamping. Humans need a digest, not the whole artifact. | `wf brief <gate>` (command): gathers facts deterministically (artifact paths, size, hash, change since the last version, open-question count, earlier rejections and reasons). Skill `wf-gate-brief`: the agent turns that into a short plain-language brief with decisions to make. |
| Escalation handling | When a loop cap or stuck-loop stop fires, `status --check` fails and the run stalls. No command lets the human choose retry, reject or abort. This is a real gap today. | `wf escalation list/retry/reject/abort` (command) and skill `wf-unblock`. Retry resets the loop with a note; reject returns to an earlier gate's stage; abort ends the run. All recorded as events. |
| Capability manifest and validator | The pieces must stay consistent as they multiply. | `.agent-workflow/capabilities.json` maps each stage to its skill, agent, rule sections and checks. `wf doctor` (command) validates it (see Phase 1B). |
| Sub-agent contract | Agents differ in tools, model and output format, which breaks portability. | A short spec per agent: inputs, the one output file, allowed tools, read-only flag, suggested model tier, and the return format. |
| Jump to a stage | Users sometimes need to start mid-pipeline (existing spec, resumed work). Not possible today. | `wf goto <stage>` (approved): human only, backwards always allowed, forwards only if every earlier artifact passes its check and no gate is skipped without its approval, recorded as an event. |
| Lessons learned | Repeated review findings should become rules instead of repeating. | Optional `wf-retro` skill after a run, writing proposed rule changes for human approval. Not in Phase 1B. |

Suggested model tier per agent (proposed, harness permitting): strongest for `solution-architect` and `code-reviewer` (judgement), strong for `implementer` and `test-architect`, fast for `product-researcher` summaries, `verifier` and gate briefs.

### 4.5 Suggested skills by stage

| Stage | Reuse what exists | Add |
|---|---|---|
| 0 Intake | `wf-run`, `bmad-project-context` | `wf-onboard` |
| 1 Spec | `wf-start`, `bmad-spec`, `bmad-advanced-elicitation`, `bmad-deep-recon` | `wf-research`, `wf-spec-review`, agent `product-researcher` |
| Gate: spec | `wf-approve`, `wf-reject` | `wf-gate-brief` |
| 2 Architecture | `wf-feasibility`, `bmad-deep-recon` (technical pack) | agent `solution-architect`; security, data and cost lenses as `standards.md` sections |
| Gate: approach | `wf-approve`, `wf-reject` | `wf-gate-brief` |
| 3a Test plan | `wf-test-plan`, `product-quality-assurance` | Playwright conventions and test-data rule |
| 3b Product tests | `wf-tests` | `wf-playwright-e2e` |
| 4 Implement | `wf-implement`, `unit-testing-test-generate`, `frontend-design`, stack rule packs | dependency, migration and secrets rules; `wf-unblock` |
| 5 Review | `wf-review`, `bmad-code-review`, `bmad-review`, `bmad-walkthrough` | agent `code-reviewer` |
| 6 Verify | `wf-verify` | `verifier` as Playwright runner; `wf-playwright-e2e` |
| 7 PR | `wf-pr` | PR summary guide; ADR copy |
| Anywhere | `wf-pause`, `wf-resume`, `wf-abort` | `wf-unblock`; `wf goto` if approved |

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
- **Core commands:** `wf brief <gate>`, `wf escalation list|retry|reject|abort`, `wf doctor`, `wf goto <stage>` (approved), and `wf init [--refresh]` with dynamic stack detection.
- **New checks (in `lib/postconditions.mjs`):** spec has non-goals; research has sources when present; `approach.md` has a decision record, a non-functional section, risks and rollback; `review.md` has one section per axis with severity tags.
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

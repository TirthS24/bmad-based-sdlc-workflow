# Plan: Planning stage = ingest → grill/synthesize/escalate → SRS → persona tickets → TDD acceptance criteria

## Context

Today `grill_spec` is one main-thread interview that writes `SPEC.md` via `bmad-spec`, and a separate `test_plan` stage maps REQ-n → PRD-n.m scenarios. Input is usually vague ("implement payment gateway"), and the human answers every question, even ones the company's docs already answer.

The new first stage is an orchestrated sub-agent pipeline. It pulls context from connected MCPs (Confluence, Slack, Jira) and repo docs, grills a draft, and lets a synthesis agent answer from **Confluence + repo docs only**. Anything it can't cite goes to the human. The stage ends with an **SRS** (`SRS.md`) and **persona tickets** (UI/UX, FE, BE, QA) as validated JSON in the repo. Each ticket's acceptance criteria carry the product test **scenarios** (not code). The scenarios replace `test_plan`.

Decisions confirmed with you:
- New order: `planning` → **gate_spec** → `feasibility` → **gate_approach** → `tests` → **gate_tests** → `implement` → `review` → **gate_review** → `verify` → **gate_final** → `pr`. `test_plan` / `gate_plan` are removed.
- The test cases in ACs are Given/When/Then scenarios with PRD-n.m ids. Playwright code is still written in `tests` (after feasibility) and frozen at `gate_tests`.
- Tickets are repo JSON. If Jira is connected, ask the human whether to create Jira issues and how (stories / sub-tasks / epic + stories, project key).
- The synthesizer may cite only Confluence and repo files. A Slack-only mention escalates to you.
- The database stores the **count** of human-escalated questions and the **start/end time of each sub-agent run**.

Also confirmed:
- The stage id is renamed from `grill_spec` to **`planning`** everywhere: workflow, state, CLI, telemetry, tests and docs.
- `implement` stays one implementer that reads all tickets. Per-persona implementers are out of scope for this change.
- The tickets-only TDD step gets its own fresh-context sub-agent, **`acceptance-test-writer`**. `test-architect` keeps only ATDD mode for the `tests` stage.

## Planning stage flow

```
/wf-run <input>
  └─ wf-start (orchestrator = main thread)
     1. requirements-ingestor  (read-only, MCP + repo)   → draft-requirements.md
     2. loop round r = 1..cap (loop_caps.grill, default 5):
          requirements-griller    (read-only)            → new questions (JSON), none ⇒ exit loop
          requirements-synthesizer(read-only, Confluence+repo only) → answer+source | UNANSWERABLE
          orchestrator: UNANSWERABLE → ask human, one at a time (AskUserQuestion)
          orchestrator writes grill/questions.json
        cap hit with open questions ⇒ /wf-unblock (escalation), never silently stop
     3. srs-writer             (read-only)               → SRS.md
     4. ticket-writer          (read-only, persona-* skills) → tickets JSON
     5. acceptance-test-writer (read-only, fresh context) → same tickets with test_cases in each AC
     6. node wf.mjs tickets check                        → schema + traceability validation
     7. node wf.mjs done planning --result specs/spec-<id>/SRS.md
  └─ gate_spec: human approves SRS + tickets together (/wf-gate-brief shows counts)
     If an Atlassian MCP is connected: ask "create Jira issues?" → /wf-jira-tickets (after approval)
```

Read-only agents return text/JSON; the orchestrator writes the files (same rule as today, AGENTS.md).

## Artifacts (all under `specs/spec-<run-id>/`, committed with the change)

| File | Written from | Content |
|---|---|---|
| `draft-requirements.md` | ingestor | Interpreted ask, related context, a **Sources** list (Confluence/Slack/Jira links, repo paths), known gaps |
| `grill/questions.json` | orchestrator | `[{id:"Q-n", round, question, options[], req_refs[], status:"answered", answer, answered_by:"synthesis"\|"human", sources[]}]` |
| `SRS.md` | srs-writer | SRS sections below |
| `tickets/<persona>/<TKT-id>.json` | ticket-writer, then acceptance-test-writer | Ticket format below |

**SRS.md sections** (from IEEE 29148, trimmed): 1 Introduction (Purpose, Scope, Definitions, References) · 2 Overall description (Product perspective, User classes/personas, Operating environment, Constraints, Assumptions & dependencies) · 3 Functional requirements (`- **REQ-n** title`, `intent:`, `success:`, `priority:`, `source:` Q-id or doc link) · 4 External interfaces (UI, API, integrations) · 5 Non-functional (performance, security & privacy, reliability, accessibility) · 6 Non-goals · 7 Traceability (REQ-n → Q-ids/sources). Keeping `REQ-n` + `success:` means `reqIds`/`capabilityBlock` in [postconditions.mjs](.agent-workflow/lib/postconditions.mjs) still work.

**Ticket format** (validated in code; documented with an example in `standards.md` "Ticket format"):
```json
{
  "id": "TKT-BE-001", "persona": "ui_ux|fe|be|qa", "title": "", "purpose": "", "description": "",
  "priority": "P0|P1|P2|P3", "requirements": ["REQ-1"], "depends_on": ["TKT-UX-001"],
  "acceptance_criteria": [{
    "id": "AC-1", "text": "",
    "test_cases": [{ "id": "PRD-1.1", "title": "", "given": "", "when": "", "then": "",
                     "layer": "e2e|ui|api|integration|unit|manual", "automation": "automated|manual|n/a" }]
  }],
  "external": { "jira_key": null }
}
```
Product scenarios use `PRD-n.m` (n = REQ number); technical ones keep `TECH-*`. This keeps `e2e.mjs` id matching and the Playwright title convention unchanged.

## Changes by file

**Core (`.agent-workflow/`)**
- **Rename `grill_spec` → `planning`** (a mechanical rename; grep `grill_spec` across `.agent-workflow/`, `.cursor/`, `installer/`, `server/`, `docs/`):
  - [workflow.json](.agent-workflow/workflow.json) stage id
  - `emptyState` start stage and `NEXT_ACTION` key in [state.mjs](.agent-workflow/lib/state.mjs)
  - the `postcondition()` switch and `checkPlanning` → `checkPlanning`
  - `FILE_CHECKS` in [goto.mjs](.agent-workflow/lib/goto.mjs)
  - [rewind.mjs](.agent-workflow/lib/rewind.mjs) / [escalation.mjs](.agent-workflow/lib/escalation.mjs), if they name it
  - the `mapLocal('run')` stage in [capture.mjs](.agent-workflow/lib/telemetry/capture.mjs)
  - `capabilities.json` key, and every test and doc
  - Server rows already stored with `stage = 'grill_spec'` stay as they are. Migration 002 adds no rewrite, since old runs are history; dashboard queries that filter on the stage name accept both.
  - Bump `workflow.json` / state `schema` to 3. `wf resume` of a paused schema-2 run maps `grill_spec` → `planning` and `test_plan`/`gate_plan` → `feasibility` (one small branch in `cmdResume`).
- [workflow.json](.agent-workflow/workflow.json): drop `test_plan`, `gate_plan`. Set `gate_spec.next = feasibility` and `gate_approach.next = tests`. `planning.writes` = `specs/**`. Add `max_rounds` from `loop_caps.grill`.
- [config.json](.agent-workflow/config.json): add `loop_caps.grill: 5`. Add `ticket_personas: ["ui_ux","fe","be","qa"]` only if [init.mjs](.agent-workflow/lib/init.mjs) must tolerate it. Otherwise hard-code the personas in `tickets.mjs`.
- **New** `lib/tickets.mjs` (the one new module):
  - `loadTickets(state)` reads `tickets/**/*.json`.
  - `checkTickets(state, srsText)` checks: required fields and enums; unique ids; the persona folder matches the `persona` field; `depends_on` points at real tickets; every REQ-n in the SRS is covered by ≥1 ticket and by ≥1 `PRD-n.m` test case; every AC has ≥1 test case.
  - `checkQuestions(state)` checks: every question is answered; `answered_by` is synthesis or human; every synthesis answer has ≥1 source that is a Confluence URL (`/wiki/` or `atlassian.net`) or a repo path that exists; human answers need no source.
  - `plannedScenarios(state)` returns the automated `PRD-n.m` ids on the e2e/ui/api layers.
  - `escalationCount(state)` counts questions answered by the human.
- [postconditions.mjs](.agent-workflow/lib/postconditions.mjs):
  - `checkPlanning` (renamed from `checkPlanning`) reads `SRS.md` (same REQ/success/Non-goals/no-`[OPEN QUESTION]` checks, plus the SRS section headings), then runs `checkQuestions` and `checkTickets`. Keep `checkResearch`.
  - Delete `checkTestPlan` and its `case`.
- [e2e.mjs](.agent-workflow/lib/e2e.mjs): `plannedE2e` calls `plannedScenarios` (tickets) instead of parsing `test-plan.md`; update the error text.
- [commands.mjs](.agent-workflow/lib/commands.mjs):
  - `cmdApprove`: `spec_hash` hashes `SRS.md`; replace `test_plan_hash` with `tickets_hash` (sha of the sorted ticket files, reusing `sha256File` from `io.mjs`).
  - `cmdDone('planning')`: pass `{ human_escalations: escalationCount(state) }` into `appendEvent`.
  - New `cmdTickets('check')` that prints the problems and exits non-zero, so the orchestrator can run it before `done`.
- [wf.mjs](.agent-workflow/wf.mjs): dispatch `tickets check`. `log subagentStart|subagentStop` already routes through `cmdLog`.
- [state.mjs](.agent-workflow/lib/state.mjs): rewrite `NEXT_ACTION.planning` / `gate_spec` for the new flow; delete the `test_plan` / `gate_plan` entries.
- [brief.mjs](.agent-workflow/lib/brief.mjs):
  - `gate_spec` facts: REQ count, tickets per persona and priority, test case count, questions answered by synthesis vs human, sources cited; artifacts = SRS.md, draft-requirements.md, questions.json, tickets dir.
  - Drop `gate_plan` and its entry in the gate list message.
- [goto.mjs](.agent-workflow/lib/goto.mjs): drop `test_plan` from `FILE_CHECKS`.
- [pr.mjs](.agent-workflow/lib/pr.mjs): read `SRS.md`; add a `Tickets:` path line.
- [capabilities.json](.agent-workflow/capabilities.json):
  - `planning`: skills `wf-start`, `wf-research`, `wf-spec-review`, `persona-ui-ux`, `persona-fe`, `persona-be`, `persona-qa`; agents `requirements-ingestor`, `requirements-griller`, `requirements-synthesizer`, `srs-writer`, `ticket-writer`, `acceptance-test-writer`, `product-researcher`; rules + new check text.
  - Remove `test_plan` / `gate_plan`; add `wf-jira-tickets` to `gate_spec`. `wf doctor` then validates it all.
- [standards.md](.agent-workflow/standards.md): new sections "Ingestion rubric", "Grilling rubric" (one question at a time, options listed, multi-select allowed, tied to a REQ), "Synthesis rubric" (allowed sources, cite or `UNANSWERABLE`, never guess), "SRS format", "Ticket format", "Persona tickets". Rename "Technical scenario checklist" usage to ticket ACs.

**Telemetry**
- [capture.mjs](.agent-workflow/lib/telemetry/capture.mjs):
  - Add the event types `human_escalations` (attrs `count`) and `agent_run` (attrs `agent`, `status`, `started_at`, `ended_at`, `duration_ms`) to `EVENT_TYPES` and `ALLOWED`. Never send `task`, `summary`, `description`, `modified_files` or the transcript path, since they can hold ticket text or PHI.
  - `mapLocal('done')` emits `human_escalations` when `extra.stage === 'planning'`.
  - New local types `subagent_start` / `subagent_stop`, built on what the Cursor docs say each hook sends (checked 2026-10-30, [cursor.com/docs/agent/hooks](https://cursor.com/docs/agent/hooks)):
    - `subagentStart` sends `subagent_id`, `subagent_type`, `tool_call_id`, `is_parallel_worker` and others. The core pushes `{agent: subagent_type, started_at: now}` onto a pending list in `queue/agents.json`. The hook always allows; it does not deny, because deny is reportedly not enforced.
    - `subagentStop` sends `subagent_type`, `status` (`completed|error|aborted`) and `duration_ms`, but **no `subagent_id`**, so id pairing is impossible. The core emits `agent_run` directly, using `ended_at = now`, `started_at = now − duration_ms` and `status`. It then removes the oldest pending entry with the same `subagent_type` (first in, first out; parallel workers of the same type can't be told apart, and this only affects the leftover check, not the timings).
    - Leftovers: on `done <stage>` and on run end, any pending start with no stop emits `agent_run{agent, status:'no_stop', started_at, ended_at:null}`. Users report that a lost stop happens (background sub-agents, hooks dropping out until Cursor restarts), and this keeps it visible on the dashboard instead of silently missing.
  - Claude Code: `SubagentStop` sends no duration, so its adapter pairs start and stop by the payload's agent id. Confirm the field names in chunk 1.
- Adapters ([cursor.mjs](.agent-workflow/adapters/cursor.mjs), [claude-code.mjs](.agent-workflow/adapters/claude-code.mjs)): normalize the events into `{event: 'subagentStart'|'subagentStop', agent, subagentId?, status?, durationMs?}`. Update [adapter-contract.md](docs/adapter-contract.md) with the table above.
- Hooks: [.cursor/hooks.json](.cursor/hooks.json) adds `subagentStart` / `subagentStop` → `node .agent-workflow/wf.mjs log <event>` (not fail-closed: telemetry must never block work). The installer's Claude Code hook wiring gets the same.
- The `wf agent start|end <name>` CLI is used **only by the `generic` adapter**, which has no hooks; skills call it around each dispatch when `harnessName() === 'generic'`. Cursor and Claude Code rely on hooks alone, so nothing is counted twice.
- `wf doctor` warns when the last run has `subagent_start` entries but no `subagent_stop` at all, which is the "hooks went quiet, restart Cursor" symptom.
- Server: add both types to `EVENT_TYPES` in [server/src/events.mjs](server/src/events.mjs). New `server/src/migrations/002_planning_metrics.sql` adds two views over `events`:
  - `agent_timings(run_id, stage, agent, status, started_at, ended_at, duration_ms)` (rows with `status = 'no_stop'` have a null `ended_at`)
  - `run_human_escalations(run_id, count)`
  - The rows already persist in `events.attrs`, so no new tables.

**Agents (`.cursor/agents/`)**: new `requirements-ingestor`, `requirements-griller`, `requirements-synthesizer`, `srs-writer`, `ticket-writer`, `acceptance-test-writer`. All `readonly: true`. Each names its required reading and its exact output shape.
- Ingestor: may use the Confluence/Slack/Jira MCPs and the repo; no PHI/PII in queries.
- Synthesizer: may use only the Confluence MCP and repo files; returns `{id, answer, sources[]}` or `{id, UNANSWERABLE, searched[]}`.
- `acceptance-test-writer`: fresh context. Reads only `SRS.md`, the ticket JSON and the standards sections "Ticket format" and "Technical scenario checklist". Returns the tickets with `test_cases` filled per AC (Given/When/Then, PRD-n.m / TECH-*, layer, automation). It changes no other field.
- [test-architect.md](.cursor/agents/test-architect.md): remove plan mode. ATDD mode (the `tests` stage) reads the ticket test cases instead of `test-plan.md`.
- [solution-architect.md](.cursor/agents/solution-architect.md), [implementer.md](.cursor/agents/implementer.md), [code-reviewer.md](.cursor/agents/code-reviewer.md), [verifier.md](.cursor/agents/verifier.md): required reading `SPEC.md` → `SRS.md` + tickets.

**Skills (`.cursor/skills/`)**
- Rewrite [wf-start](.cursor/skills/wf-start/SKILL.md) as the orchestrator script above. It no longer calls `bmad-spec`, since `bmad-spec` is the single writer of `SPEC.md` and the SRS format differs. Keep it under `max_skill_lines` 150.
- Add `persona-ui-ux`, `persona-fe`, `persona-be`, `persona-qa`: short, slash-only; what each persona's tickets must cover and how to set priority.
- Add `wf-jira-tickets` (slash-only, after `gate_spec`): ask for the shape (stories / sub-tasks under a story / epic + stories) and the project key; create the issues via the Atlassian MCP; write `jira_key` back into each ticket. It runs only on an explicit yes.
- Delete `wf-test-plan`. Update `wf-tests`, `wf-feasibility`, `wf-approve` (gate list), `wf-gate-brief` and `wf-spec-review` (checks SRS + tickets).

**Docs/installer**: README stages table, [USER_GUIDE.md](docs/USER_GUIDE.md) (pipeline diagram and the planning flow), IMPLEMENTATION_PLAN (new phase entry). Check that [installer/install.mjs](installer/install.mjs) copies the new agents and skills; if it uses a file list, add them.

## Tests (`.agent-workflow/test/`)

- Rename `grill_spec` → `planning` in every test file.
- Add a `cmdResume` case that maps a paused schema-2 run.
- Update the fixtures in `helpers.mjs` (`withRun`) so a passing planning stage writes `SRS.md`, `grill/questions.json` and two tickets. Remove `test_plan` from `stages`, `gates`, `pipeline`, `lifecycle`, `units` and `part2`.
- `units.test.mjs` cases for `checkTickets`:
  - missing field
  - bad enum
  - duplicate id
  - dangling `depends_on`
  - an uncovered REQ
  - an AC with no test case
  - a valid set passes
- `units.test.mjs` cases for `checkQuestions`:
  - an open question
  - a synthesis answer with no source
  - a Slack-only source rejected
  - a human answer with no source accepted
- `telemetry.test.mjs`:
  - `done planning` emits `human_escalations{count}` with no question text
  - `run_started` / the first `stage_started` carry `stage: 'planning'`
  - a Cursor `subagentStop` with `duration_ms` emits `agent_run` with `started_at = ended_at − duration_ms` and `status`
  - a start with no stop emits `agent_run{status:'no_stop'}` at `done`
  - a stop with no pending start still emits `agent_run`
  - `task`/`summary` never leave the machine
  - Claude Code start/stop pairing by agent id
- Adapter contract tests for the two new events. A server test checks that the new types are accepted and that the views return rows.

## Implementation ToDo (in order, each one a reviewable chunk)

Each chunk ends with `npm test` green before the next one starts. Chunks 1–4 are core, 5–6 are telemetry, 7–9 are agents and skills, 10–12 are docs and end-to-end.

1. **Spike: confirm the hook payloads in practice.** The Cursor docs list `subagentStart` and `subagentStop` with the fields named in Telemetry, so what's left is checking the real payloads. Log raw payloads from a throwaway `hooks.json` entry in your Cursor version for a foreground, a parallel and a background sub-agent. Note any missing `subagentStop` or `duration_ms`. Confirm Claude Code's `SubagentStart`/`SubagentStop` id field. Write the results into `docs/adapter-contract.md`. *No code.*
2. **Rename `grill_spec` → `planning`.** Mechanical rename across core, capabilities, telemetry `mapLocal`, tests and docs. Bump the schema to 3, and make `cmdResume` map paused schema-2 runs. *Done when:* `grep grill_spec` is empty and the tests pass.
3. **Remove `test_plan` / `gate_plan`.**
   - `workflow.json`: rewire `gate_spec → feasibility` and `gate_approach → tests`.
   - Remove the stage from `NEXT_ACTION`, `brief.mjs`, `goto.mjs`, `capabilities.json` and `checkTestPlan`; delete the `wf-test-plan` skill.
   - Update the gate-order tests.
4. **`lib/tickets.mjs` and the planning postcondition.**
   - Add `loadTickets`, `checkTickets`, `checkQuestions`, `plannedScenarios` and `escalationCount`.
   - `checkPlanning` reads `SRS.md` (with the section headings) and runs the questions and tickets checks.
   - Add the `wf tickets check` command.
   - Add the unit tests and update the `withRun` fixtures.
5. **Rewire the downstream readers.**
   - `e2e.mjs` `plannedE2e` reads tickets.
   - `cmdApprove`: `spec_hash` hashes SRS.md, `tickets_hash` replaces `test_plan_hash`.
   - `pr.mjs` reads SRS.md and adds a tickets line; `brief.mjs` `gate_spec` facts.
   - Update the e2e/verify/pr tests.
6. **Client telemetry.**
   - Add the event types `human_escalations` and `agent_run` (EVENT_TYPES and ALLOWED).
   - `done planning` emits the count.
   - `subagentStop` emits `agent_run` from `duration_ms`; `subagentStart` keeps a pending list for the `no_stop` leftovers.
   - Adapters normalize the two hook events; hooks.json and the Claude Code installer wiring call them.
   - Add `wf agent start|end` for the `generic` adapter only, and the `wf doctor` warning when hooks go quiet.
   - Add the telemetry and adapter-contract tests.
7. **Server telemetry.** Accept the two types in `server/src/events.mjs`. Add `002_planning_metrics.sql` with the `agent_timings` and `run_human_escalations` views. *Done when:* `npm run test:server` passes.
8. **Standards and ticket format.** In `standards.md`, add the sections Ingestion, Grilling and Synthesis rubrics, SRS format, Ticket format (with a full JSON example) and Persona tickets. `wf doctor` must pass.
9. **Planning sub-agents.** Add `requirements-ingestor`, `requirements-griller`, `requirements-synthesizer`, `srs-writer`, `ticket-writer` and `acceptance-test-writer` (all read-only, each with an exact output shape). Add them to `capabilities.json`.
10. **Orchestrator and persona skills.**
    - Rewrite `wf-start` as the planning loop: ingest → grill/synthesize/escalate rounds with the cap → SRS → tickets → ACs → `tickets check` → `done`.
    - Add `persona-ui-ux`/`fe`/`be`/`qa`.
    - Update `wf-spec-review`, `wf-approve`, `wf-gate-brief` and `wf-run`.
11. **Downstream agents and skills, plus Jira.**
    - `test-architect`: drop plan mode; ATDD reads ticket test cases.
    - `solution-architect`, `implementer`, `code-reviewer`, `verifier`, `wf-feasibility`, `wf-tests`: read SRS.md and tickets.
    - New `wf-jira-tickets` skill: ask before creating issues, ask what shape to create them in, write the keys back.
    - Update `installer/install.mjs` copy lists.
12. **Docs and the end-to-end check.**
    - Update the README stage table, `USER_GUIDE.md` (diagrams and planning flow) and `IMPLEMENTATION_PLAN.md`.
    - Do a manual run on `examples/sample-app` per Verification below.
    - Check the server views after `wf sync`.

## Dry-run findings (2026-10-30)

This section records what one real run of the implemented plan found; the fixes are planned in [workflow-hardening-after-dry-run.md](workflow-hardening-after-dry-run.md). The run used Claude Code on a separate repo, with a documentation task: "Handover documents for developers and product managers". At the time of the run, `npm test` passed 209/209 and `wf doctor` was clean.

**Worked as planned:** the whole planning stage (ingest → grill/synthesize/escalate → SRS → tickets → AC test cases → `gate_spec`).

**Pain points found:**
1. **The conductor could not run stage skills.** Every `wf-*` skill is `disable-model-invocation: true`, so `/wf-tests`, `/wf-review`, `/wf-verify` and the rest each waited for the human to type them. That cost about five round-trips of "please run X".
2. **The pipeline assumes product code.** A docs-only task could not pass `tests`, because `checkTestsToImplement` requires failing tests and with no tiers configured it reports "the unit tier exited 0". It only passed after a manual config edit. `goto` correctly refused to skip the stage.
3. **Writes through the shell bypass the write guard.** Reproduced: in `implement`, Write to `docs/handover.md` is denied, but Bash `cat > docs/handover.md` is allowed. `guardShell` only checks commit, push and PR creation.
4. **Validators fail one rule at a time and print raw regexes.**
   - `checkPlanning` returns only the first problem.
   - `capabilityBlock` finds the first occurrence of an id, so a cross-reference ("see REQ-10" inside REQ-1) makes REQ-10 appear to lack a success line. Reproduced.
   - `## 1. Introduction` and source paths with line ranges are rejected.
   - The rules for the approach `Decision` heading and for review severity tags were found only by reading `lib/*.mjs`.
5. **Sub-agent output was retyped by hand.** Read-only agents return chat text that the conductor copies into files. Long reports drifted, and `review.md` and the tickets got edited despite the "write verbatim" rule.

**Gaps against this plan:**
- No server test covers the new event types or views; `npm run test:server` was not run.
- Claude Code start/stop events are matched by agent type in arrival order, not by `agent_id`: `cmdLog` drops `subagentId`, and there is no Claude Code telemetry test.
- `readonly: true` is Cursor-only, and the installer copies agents into `.claude/agents` without translating it, so under Claude Code these agents can write.
- Leftovers: README line 121 still mentions `test-plan.md`, the `pr.mjs` header comment says `SPEC.md`, and an empty `.cursor/skills/wf-test-plan/` folder remains.
- Verification steps 3 and 4 below have not been run yet.
- None of the work is committed yet.

## Verification

1. `npm test` and `npm run test:server`, all green.
2. `node .agent-workflow/wf.mjs doctor` reports that capabilities, skills, agents and standards agree.
3. Manual run against [examples/sample-app](examples/sample-app): `/wf-run "implement payment gateway"`. Check that:
   - the ingestor cites sources
   - a gateway-choice question with no Confluence/repo mention escalates to you
   - `wf tickets check` passes
   - `done planning` → `gate_spec` brief shows the escalation count
   - `grep -rn grill_spec .agent-workflow .cursor installer` returns nothing
   - the next stage after approval is `feasibility`
4. `wf sync` to a local server, then `SELECT * FROM agent_timings` and `SELECT * FROM run_human_escalations` for the run. Expect one row per sub-agent dispatch, and the count but no question text. If any row has `status = 'no_stop'`, restart Cursor and check again before treating it as a bug in our code.

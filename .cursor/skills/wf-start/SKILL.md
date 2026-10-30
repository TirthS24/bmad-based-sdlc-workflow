---
name: wf-start
description: "Pipeline stage: planning. Run only when `wf status` says the stage is planning."
---

## Required reading before acting

- `.agent-workflow/config.json` (`loop_caps.grill`)
- `.agent-workflow/standards.md` headings for Ingestion, Grilling, Synthesis, SRS format, Ticket format, Persona tickets
- `node .agent-workflow/wf.mjs status`

## Flow (orchestrator = you)

1. **Ingest** — dispatch `requirements-ingestor` (Task subagent). It writes `specs/spec-<id>/draft-requirements.md` itself. After it returns, run `node .agent-workflow/wf.mjs check` (or `check <stage> --result <path>`) and read the rule names. Send any problems back to the same agent, at most two retries, then `/wf-unblock`. Never hand-edit the agent's file.
2. **Grill loop** — for round 1..`loop_caps.grill` (default 5):
   - `requirements-griller` → new questions JSON; `[]` ends the loop.
   - `requirements-synthesizer` → answers; `UNANSWERABLE` → ask the human one question at a time (AskUserQuestion), record in `grill/questions.json` with `answered_by: human`.
   - Merge synthesis answers into `grill/questions.json` (`answered_by: synthesis`, `sources`).
   - If the cap is hit with open questions → `/wf-unblock`, do not silently stop.
3. **SRS** — `srs-writer` writes `SRS.md` itself. After it returns, run `node .agent-workflow/wf.mjs check` (or `check <stage> --result <path>`) and read the rule names. Send any problems back to the same agent, at most two retries, then `/wf-unblock`. Never hand-edit the agent's file.
4. **Tickets** — `ticket-writer` (use persona-* skills) writes `tickets/<persona>/*.json` itself. After it returns, run `node .agent-workflow/wf.mjs check` (or `check <stage> --result <path>`) and read the rule names. Send any problems back to the same agent, at most two retries, then `/wf-unblock`. Never hand-edit the agent's file.
5. **Acceptance tests** — fresh context: `acceptance-test-writer` updates the ticket JSON with `test_cases` itself.
6. **Validate** — `node .agent-workflow/wf.mjs tickets check` (fix until clean).
7. **Review** — `/wf-spec-review`.
8. **Optional research** — if gaps need `/wf-research`, run it, update SRS, re-run tickets check.

When `harnessName() === 'generic'`, wrap each subagent dispatch with `node .agent-workflow/wf.mjs agent start|end <name>`. Cursor/Claude hooks record timings automatically.

## Outputs

- `draft-requirements.md`, `grill/questions.json`, `SRS.md`, `tickets/**/*.json`

## On finish

```
node .agent-workflow/wf.mjs done planning --result specs/spec-<id>/SRS.md
```

Do not advance the stage yourself — wf.mjs verifies postconditions.

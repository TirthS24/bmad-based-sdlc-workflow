---
name: wf-spec-review
description: "Pipeline stage: planning. Run only when `wf status` says the stage is planning."
---

## Required reading before acting

- `.agent-workflow/standards.md` headings "Spec quality", "SRS format", "Ticket format", "Edge-case checklist"
- `specs/spec-<run-id>/SRS.md`, `grill/questions.json`, `tickets/`

## What this does

1. Walk "Spec quality" and SRS section headings against `SRS.md`. List every miss with the `REQ-n` it affects.
2. Confirm every grill question is answered (`answered_by` synthesis or human); synthesis answers have allowed sources.
3. Run `node .agent-workflow/wf.mjs tickets check` and fix every reported problem.
4. Walk the edge-case checklist per REQ; unmarked gaps are misses.
5. Fix by asking the human one question at a time. Re-run until clean or the human accepts a documented exception.

## Then

Return to `wf-start` for `done planning`. Do not advance the stage yourself.

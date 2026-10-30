---
name: wf-feasibility
description: "Pipeline stage: feasibility. Run only when `wf status` says the stage is feasibility."
---

## Required reading before acting

- `.agent-workflow/config.json`
- `specs/spec-<run-id>/SRS.md`
- `.agent-workflow/standards.md` headings "Feasibility rubric" and "Architecture decision record"

## What this stage does

Thin dispatcher. Gather Jira/ticket context if any, then Task `solution-architect` with the SRS.md path (and `research.md` if it exists). `solution-architect` writes `specs/spec-<run-id>/approach.md` itself. Check it with `node .agent-workflow/wf.mjs check` while the stage is feasibility. Send problems back to the architect, at most two retries, then `/wf-unblock`. Never hand-edit it. Do not explore the codebase in this thread. If the architect reports a library or service choice it cannot settle, run `/wf-research` with the technical pack, then re-dispatch it with `research.md`.

## Inputs

- SRS.md
- `research.md` if present
- Optional ticket text

## Outputs

- `specs/spec-<run-id>/approach.md`

## On finish

```
node .agent-workflow/wf.mjs done feasibility --result specs/spec-<run-id>/approach.md
```

Do not advance the stage yourself — wf.mjs verifies the postcondition.

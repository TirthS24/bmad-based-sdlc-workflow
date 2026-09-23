---
name: wf-feasibility
description: "Pipeline stage: dispatch feasibility-analyst and write approach.md. Invoked only by the pipeline; not for the model to select on its own."
disable-model-invocation: true
---

## Required reading before acting

- `.agent-workflow/config.json`
- `specs/spec-<run-id>/SPEC.md`
- `.agent-workflow/standards.md` heading "Feasibility rubric"

## What this stage does

Thin dispatcher. Gather Jira/ticket context if any, then Task `feasibility-analyst` with the SPEC.md path. Write its final message verbatim to `specs/spec-<run-id>/approach.md`. Do not explore the codebase in this thread.

## Inputs

- SPEC.md
- Optional ticket text

## Outputs

- `specs/spec-<run-id>/approach.md`

## On finish

```
node .agent-workflow/wf.mjs done feasibility --result specs/spec-<run-id>/approach.md
```

Do not advance the stage yourself — wf.mjs verifies the postcondition.

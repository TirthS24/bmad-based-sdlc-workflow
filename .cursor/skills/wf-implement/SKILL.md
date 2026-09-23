---
name: wf-implement
description: "Pipeline stage: one implementer attempt to make frozen tests pass. Invoked only by the pipeline; not for the model to select on its own."
disable-model-invocation: true
---

## Required reading before acting

- `.agent-workflow/config.json`
- `specs/spec-<run-id>/SPEC.md`
- `specs/spec-<run-id>/approach.md` (approved option only)
- `.agent-workflow/standards.md` heading "Coding rules"

## What this stage does

Dispatch `implementer` for **one** attempt. Do not loop in this skill. The `stop` hook re-submits until `wf verify` is green or `loop_caps.implement` / a plateau is hit.

## Inputs

- Approved Gate 1 approach letter from `wf status`
- Frozen tests (read-only)

## Outputs

- Product files the current stage `writes` glob allows (`src/**`, not test_globs)

## On finish

If this attempt's `wf verify` (unit+lint) already exits 0:

```
node .agent-workflow/wf.mjs done implement --result <summary path or HEAD>
```

Otherwise stop the turn and let the stop hook follow up. Do not advance the stage yourself.

---
name: wf-verify
description: "Pipeline stage: suite verify plus verifier exploratory pass and evidence bundle. Invoked only by the pipeline; not for the model to select on its own."
disable-model-invocation: true
---

## Required reading before acting

- `.agent-workflow/config.json`
- `specs/spec-<run-id>/test-plan.md`
- `.agent-workflow/standards.md` heading "Technical scenario checklist"

## What this stage does

1. Run `node .agent-workflow/wf.mjs verify` (empty command tiers are skipped).
2. Dispatch `verifier` for the exploratory pass. It uses the editor browser against `dev_url`. It does not run `E2E/` stage/prod suites.
3. Assemble `.agent-workflow/runs/<id>/evidence/` (pass/fail table, screenshots if the browser pass ran).

If `commands.e2e` is empty, the browser pass runs against `dev_url` only when that URL responds; otherwise the verifier records `e2e skipped` in the bundle and that skip is not a failure.

## Inputs

- test-plan.md technical tier, config `dev_url` / `surfaces`

## Outputs

- `.agent-workflow/runs/<id>/evidence/` (must be non-empty)

## On finish

```
node .agent-workflow/wf.mjs done verify --result .agent-workflow/runs/<id>/evidence/
```

Do not advance the stage yourself — wf.mjs verifies the postcondition.

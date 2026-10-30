---
name: wf-verify
description: "Pipeline stage: run the full verification suite and assemble the evidence bundle. Invoked only by the pipeline; not for the model to select on its own."
disable-model-invocation: true
---

## Required reading before acting

- `.agent-workflow/config.json`
- `specs/spec-<run-id>/SRS.md`
- `specs/spec-<run-id>/tickets/`
- `.agent-workflow/standards.md` headings "Technical scenario checklist" and "Playwright conventions"

## What this stage does

1. Dispatch `verifier`. It runs `node .agent-workflow/wf.mjs verify`: unit, lint, typecheck, format, complexity, then seed and the Playwright e2e suite, then the accessibility command. Empty commands are skipped.
2. The Playwright JSON report and `e2e-summary.md` land in `.agent-workflow/runs/<id>/evidence/`. The verifier adds traces and screenshots there.
3. On a failure, send the failing scenario ids to `/wf-implement`; do not fix tests. Stop at the fix-round cap and tell the human.

`done verify` refuses unless every tier passes and every automated product scenario (`PRD-n.m` tagged `e2e`, `ui` or `api`) from persona tickets has a passing test. Flaky tests (passed on retry) do not block and are listed in the summary.

## Inputs

- SRS.md, tickets, config `commands` / `dev_url` / `surfaces`

## Outputs

- `.agent-workflow/runs/<id>/evidence/` (must be non-empty)

## On finish

```
node .agent-workflow/wf.mjs done verify --result .agent-workflow/runs/<id>/evidence/
```

Do not advance the stage yourself — wf.mjs verifies the postcondition.

---
name: wf-tests
description: "Pipeline stage: write failing ATDD tests, confirm red for the right reason. Invoked only by the pipeline; not for the model to select on its own."
disable-model-invocation: true
---

## Required reading before acting

- `.agent-workflow/config.json`
- `specs/spec-<run-id>/SRS.md`
- `specs/spec-<run-id>/tickets/` (automated `test_cases`)

## What this stage does

Dispatch `test-architect` in **atdd** mode. It writes Playwright product (flow) tests only; follow `/wf-playwright-e2e`. Unit tests are the implementer's, written later. If the `bmad-testarch-atdd` skill is installed under `.agents/skills/` or `.cursor/skills/`, the subagent uses it. Tests may only land under `config.json` `product_test_globs`. Names must include `REQ` / `TECH` / `PRD` ids.

Confirm red via `node .agent-workflow/wf.mjs verify`. `wf done tests` runs the e2e command (the unit tier if none is set) and refuses if it passes or if failures do not cite those ids. That command also stores the freeze hash used by the preToolUse guard.

## Inputs

- SRS.md, tickets, product_test_globs

## Outputs

- Failing Playwright tests under product_test_globs only

## On finish

```
node .agent-workflow/wf.mjs done tests --result <primary test file or directory>
```

Do not advance the stage yourself — wf.mjs verifies the postcondition.

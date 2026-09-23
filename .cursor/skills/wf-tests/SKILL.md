---
name: wf-tests
description: "Pipeline stage: write failing ATDD tests, confirm red for the right reason. Invoked only by the pipeline; not for the model to select on its own."
disable-model-invocation: true
---

## Required reading before acting

- `.agent-workflow/config.json`
- `specs/spec-<run-id>/test-plan.md`
- `specs/spec-<run-id>/SPEC.md`

## What this stage does

Dispatch `test-architect` in **atdd** mode. If the `bmad-testarch-atdd` skill is installed under `.agents/skills/` or `.cursor/skills/`, the subagent uses it. Tests may only land under `config.json` `test_globs`. Names must include `REQ` / `TECH` / `PRD` ids.

Confirm red via `node .agent-workflow/wf.mjs verify`. `wf done tests` refuses if unit tests pass or if failures do not cite those ids. That command also stores the freeze hash used by the preToolUse guard.

## Inputs

- test-plan.md, test_globs

## Outputs

- Failing tests under test_globs only

## On finish

```
node .agent-workflow/wf.mjs done tests --result <primary test file or directory>
```

Do not advance the stage yourself — wf.mjs verifies the postcondition.

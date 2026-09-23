---
name: wf-test-plan
description: "Pipeline stage: two-tier test plan (titles only). Invoked only by the pipeline; not for the model to select on its own."
disable-model-invocation: true
---

## Required reading before acting

- `.agent-workflow/config.json`
- `specs/spec-<run-id>/SPEC.md`
- `specs/spec-<run-id>/approach.md`
- `.agent-workflow/standards.md` heading "Technical scenario checklist"

## What this stage does

Dispatch `test-architect` in **plan** mode: titles only, no test code, both product and technical tiers, map `REQ-n` → `PRD-n.m` and `TECH-*`. If the `bmad-testarch-test-design` skill is installed under `.agents/skills/` or `.cursor/skills/`, the subagent uses it; otherwise it still produces the same ID scheme and tags.

Every `REQ-n` needs ≥1 scenario. Every scenario line includes a layer (unit / integration / e2e / api / ui / manual) and `automated` / `manual` / `N/A`.

## Inputs

- SPEC.md, approach.md, config.json `test_globs` and `surfaces`

## Outputs

- `specs/spec-<run-id>/test-plan.md`

## On finish

```
node .agent-workflow/wf.mjs done test_plan --result specs/spec-<run-id>/test-plan.md
```

Do not advance the stage yourself — wf.mjs verifies the postcondition.

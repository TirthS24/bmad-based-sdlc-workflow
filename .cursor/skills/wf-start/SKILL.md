---
name: wf-start
description: "Pipeline stage: grill the spec. Invoked only by wf-run or the human; not for the model to select on its own."
disable-model-invocation: true
---

## Required reading before acting

- `.agent-workflow/config.json`
- `.agent-workflow/standards.md` heading "Edge-case checklist"
- `node .agent-workflow/wf.mjs status`

## What this stage does

Runs the grill. One question at a time. Explore the codebase before asking. Do not invent answers. Walk the edge-case checklist; mark N/A with a reason.

Writes `specs/spec-<run-id>/SPEC.md` by calling the **bmad-spec** skill (`.agents/skills/bmad-spec` or `.cursor/skills/bmad-spec`). Do not reimplement its contract format. Pass these up front so it does not stall:

- slug = the run id from `wf status`
- output folder `specs/spec-<run-id>/` (team override in `_bmad/custom/bmad-spec.toml`)
- number capabilities as **REQ-n** (not CAP-N)
- each capability has **intent** and **success**
- leave no `[OPEN QUESTION]` markers; ask the human until none remain

bmad-spec is interactive by default and asks for missing input. Stay in that mode. Headless express mode is only for when the user already supplied the full ticket text.

## Inputs

- Jira/ticket context from `/wf-run`
- Existing `SPEC.md` if this is a resume

## Outputs

- `specs/spec-<run-id>/SPEC.md` (and bmad-spec companions in that folder)

## On finish

```
node .agent-workflow/wf.mjs done grill_spec --result specs/spec-<run-id>/SPEC.md
```

Do not advance the stage yourself — wf.mjs verifies the postcondition.

---
name: wf-approve-spec
description: "Pipeline stage: human Gate 1 — record chosen approach A|B|C. Invoked only by the human at the spec gate."
disable-model-invocation: true
---

## Required reading before acting

- `specs/spec-<run-id>/SPEC.md`
- `specs/spec-<run-id>/approach.md`
- `specs/spec-<run-id>/test-plan.md`
- `node .agent-workflow/wf.mjs status` (stage must be gate1)

## What this stage does

Record the human's approach letter. Do not pick A/B/C for them.

## On finish

```
node .agent-workflow/wf.mjs approve gate1 --approach <A|B|C>
```

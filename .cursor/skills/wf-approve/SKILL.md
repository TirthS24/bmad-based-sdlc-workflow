---
name: wf-approve
description: "Pipeline stage: human gate approval. Invoked only by the human at a gate (gate_spec, gate_approach, gate_plan, gate_tests, gate_review, gate_final)."
disable-model-invocation: true
---

## Required reading before acting

- `node .agent-workflow/wf.mjs status` (the current stage must be the gate being approved)
- The artifact that gate covers:

| Gate | Read | Approving means |
|---|---|---|
| `gate_spec` | `specs/spec-<run-id>/SPEC.md` | the product decisions are final |
| `gate_approach` | `specs/spec-<run-id>/approach.md` | you choose approach A, B or C |
| `gate_plan` | `specs/spec-<run-id>/test-plan.md` | the test scenarios are right |
| `gate_tests` | the new failing tests | the tests are frozen and implementation may start |
| `gate_review` | `.agent-workflow/runs/<id>/review.md` | review findings are handled |
| `gate_final` | `.agent-workflow/runs/<id>/evidence/` | commit, push and the PR are unlocked |

## What this stage does

Records the human's decision. Never approve on the human's behalf and never pick the approach letter for them. If the human wants changes, use `/wf-reject` instead.

## On finish

```
node .agent-workflow/wf.mjs approve <gate>
node .agent-workflow/wf.mjs approve gate_approach --approach <A|B|C>
```

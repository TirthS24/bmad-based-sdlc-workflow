---
name: wf-approve
description: "Pipeline stage: human gate approval. Invoked only by the human at a gate."
disable-model-invocation: true
---

## Required reading before acting

- `node .agent-workflow/wf.mjs status` (the current stage must be the gate being approved)
- The artifact that gate covers:

| Gate | Read | Approving means |
|---|---|---|
| `gate_spec` | `SRS.md` and `tickets/` | product requirements and persona tickets are final |
| `gate_approach` | `approach.md` | you choose approach A, B or C |
| `gate_tests` | the new failing tests | tests are frozen and implementation may start |
| `gate_review` | `review.md` | review findings are handled |
| `gate_final` | `evidence/` | commit, push and the PR are unlocked |

## What this stage does

Records the human's decision. Never approve on their behalf. For changes, use `/wf-reject`.

## On finish

```
node .agent-workflow/wf.mjs approve <gate>
node .agent-workflow/wf.mjs approve gate_approach --approach <A|B|C>
```

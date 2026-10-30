---
name: wf-goto
description: "Human-only: jump the run to another stage. Backwards always works; forwards only over stages whose artifact passes its check. Not for the model to select on its own."
disable-model-invocation: true
---

## What this does

`node .agent-workflow/wf.mjs goto <stage>`

- **Backwards:** forgets the stage records from the target on, resets the gates after it to pending, and clears loop counters and escalations. Frozen tests are un-frozen if the target is before `tests`.
- **Forwards:** allowed only if every stage in between has a passing artifact (planning → SRS/tickets, `approach.md`, tests) or is already done. It never skips a gate: an unapproved gate stops the jump.
- To start from an existing SRS: write `SRS.md` and tickets into `specs/spec-<id>/`, then `goto gate_spec` and approve normally.

Only the human asks for this. Each jump is logged as a `goto` event. Do not use it to dodge a failing check.

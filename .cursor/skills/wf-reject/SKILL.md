---
name: wf-reject
description: "Pipeline stage: human gate rejection. Sends the run back to the stage before the gate, with the reason. Invoked only by the human."
disable-model-invocation: true
---

## Required reading before acting

- `node .agent-workflow/wf.mjs status` (the current stage must be the gate being rejected)

## What this stage does

Records the human's reason and returns the run to the stage that feeds the gate. The exception is `gate_review`, which returns to `implement` (review fixes are code changes, so implement and review both run again). `next_action` then says what to revise. The reason is the human's own words; do not rewrite it.

## On finish

```
node .agent-workflow/wf.mjs reject <gate> --reason "<why>"
```

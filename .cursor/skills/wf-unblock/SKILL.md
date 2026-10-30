---
name: wf-unblock
description: "Escalation helper: explain a stalled run and offer the human the ways out. Run when status --check fails or an escalation is pending; not for the model to select on its own."
disable-model-invocation: true
---

## Required reading before acting

- `node .agent-workflow/wf.mjs status`
- `node .agent-workflow/wf.mjs escalation list`

## What this does

A loop cap or stuck-loop stop has halted the run. Tell the human, in a few lines: which stage, why it stopped, what was tried (the failing ids, the number of rounds), and your read of the cause. Then offer the options and wait:

- `escalation retry --reason "<what changes this time>"` resets the loop counters for another try.
- `escalation reject --reason "<why>"` sends the run back to the previous gate's stage (the approach or tests were wrong).
- `escalation abort` ends the run.

Never run one of these yourself. They are the human's decision. Every choice is logged as an event.

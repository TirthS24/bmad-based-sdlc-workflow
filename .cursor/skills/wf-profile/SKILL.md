---
name: wf-profile
description: "Pipeline command: change the run profile (full, pm, dev, docs). Invoked only by the human; not for the model to select on its own."
disable-model-invocation: true
---

## Required reading before acting

- `node .agent-workflow/wf.mjs status` (the profile is shown as `profile:`)
- `.agent-workflow/workflow.json` `profiles` (what each profile skips and auto-passes)

## What this stage does

Switches the active run to another profile. Allowed only while planning runs or before `gate_spec` is approved. Afterwards the profile is fixed.

## Command

```
node .agent-workflow/wf.mjs profile <full|pm|dev|docs>
```

Print the status it returns. Do not switch profiles on the human's behalf: the conductor may propose a profile in the `gate_spec` brief, and only the human runs this command.

---
name: wf-run
description: "Pipeline stage: start a spec-driven run from a Jira key, pasted ticket, or free text. Invoked only by the human; not for the model to select on its own."
disable-model-invocation: true
---

## Required reading before acting

- `.agent-workflow/config.json`
- Output of `node .agent-workflow/wf.mjs status`

## What this stage does

Creates at most one active run. Parses the invocation as a Jira key (e.g. `PAT-1234`), pasted ticket text, or a short description. Uses the Atlassian plugin already in this environment when the input is a Jira key. Does not add MCP servers.

## Inputs

- The `/wf-run` argument
- `wf status` (if a run is active, print it and stop)

## Outputs

- `.agent-workflow/state.json` via `wf.mjs run` only
- Then immediately continue into `/wf-start`

## On finish

```
node .agent-workflow/wf.mjs run <ticket-id-or-description>
```

If that command refuses because a run is already active, stop. Do not start a second run.
Do not advance the stage yourself — `wf.mjs` verifies postconditions later.

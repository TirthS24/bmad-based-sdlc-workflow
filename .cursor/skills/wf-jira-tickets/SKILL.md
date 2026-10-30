---
name: wf-jira-tickets
description: "After gate_spec: optionally create Jira issues from persona tickets via Atlassian MCP. Human must opt in."
disable-model-invocation: true
---

## When to run

Only after `gate_spec` is approved and an Atlassian MCP is connected. Ask the human: create Jira issues? If no, stop.

If yes, ask project key and shape (stories only, sub-tasks under a story, or epic + stories). Create issues via MCP, then write each `jira_key` into the matching ticket JSON under `external.jira_key`. Commit ticket updates with the spec folder.

Never create issues without explicit yes and project key.

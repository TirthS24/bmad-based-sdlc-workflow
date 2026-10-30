---
name: wf-gate-brief
description: "Pipeline gate brief. Run only when `wf status` says a gate is pending."
---

## Required reading before acting

- `.agent-workflow/standards.md` heading "Gate brief format"
- `node .agent-workflow/wf.mjs brief` (facts for the current gate)

## What this does

The human should not have to read the whole artifact to decide. Run `wf brief`, read the artifact it names, and write the brief in the format the standards define: what this is, what changed since the last time, the decisions to make, and anything that worries you. Quote the facts; do not invent numbers.

At `gate_review`, offer the human a walkthrough of the change with `bmad-walkthrough` if that skill is installed under `.agents/skills/` or `.cursor/skills/`.

Stop after the brief. Do not approve or reject; that is the human's call (`/wf-approve`, `/wf-reject`).

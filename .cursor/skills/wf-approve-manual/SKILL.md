---
name: wf-approve-manual
description: "Pipeline stage: human Gate 2 — approve evidence and allow commit/Gerrit push. Invoked only by the human at the manual gate."
disable-model-invocation: true
---

## Required reading before acting

- `.agent-workflow/runs/<id>/evidence/`
- `.agent-workflow/runs/<id>/review.md` (decision-needed items)
- `node .agent-workflow/wf.mjs status` (stage must be gate2)

## What this stage does

Record human approval of the evidence bundle. After this, hooks allow `git commit` and `git push` to `refs/for/`.

## On finish

```
node .agent-workflow/wf.mjs approve gate2
```

---
name: wf-pause
description: "Pipeline stage: archive the active run so work can resume later. Invoked only by the human."
disable-model-invocation: true
---

## On finish

```
node .agent-workflow/wf.mjs pause
```

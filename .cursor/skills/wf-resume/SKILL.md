---
name: wf-resume
description: "Pipeline stage: restore a paused run. Invoked only by the human."
disable-model-invocation: true
---

## On finish

```
node .agent-workflow/wf.mjs resume <run-id>
```

If only one paused run exists, `node .agent-workflow/wf.mjs resume` is enough.

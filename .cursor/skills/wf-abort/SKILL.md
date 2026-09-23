---
name: wf-abort
description: "Pipeline stage: abort the active run and archive it. Invoked only by the human."
disable-model-invocation: true
---

## What this stage does

Ask whether to **keep**, **stash**, or **discard** the working tree. Then:

```
node .agent-workflow/wf.mjs abort
```

`--force` skips the question and leaves the tree as-is:

```
node .agent-workflow/wf.mjs abort --force
```

Hooks become no-ops once no run is active.

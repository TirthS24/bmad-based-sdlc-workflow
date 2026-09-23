---
name: wf-pr
description: "Pipeline stage: one commit then git push to Gerrit refs/for/<current-branch>. Invoked only after gate2 is approved."
disable-model-invocation: true
---

## Required reading before acting

- `.agent-workflow/workflow.json` (protected_files, guarded_shell_patterns)
- `node .agent-workflow/wf.mjs status` (gate2 must be approved)

## Precondition

`state.json.gates.gate2.status == approved`. The beforeShellExecution hook enforces this independently — this check is a fast-fail, not the only guard.

## What this stage does

1. Confirm exactly the intended files are staged (SPEC.md, approach.md, test-plan.md, tests, product code). Do not stage `.agent-workflow/state.json` or `events.jsonl`.
2. Create **one** commit. Message style: `feat:`, `fix:`, `refactor:`, `docs:`, or `chore:` focusing on why. Husky `commit-msg` adds the Gerrit Change-Id. Do not pass `--no-verify`.
3. `git push gerrit HEAD:refs/for/<current-branch>` where `<current-branch>` is `git rev-parse --abbrev-ref HEAD` at submit time.

## New patch set on an existing change

When the Gerrit change already exists and this is another update to the same change:

1. Stage only the files this update changes. Do not stage unrelated agent, skill, or workflow files, or anything else that is not part of this branch and change.
2. `git commit --amend`, keeping the existing `Change-Id` footer. Amend creates the next patch set on that change. A new commit would open a different change.
3. `git push gerrit HEAD:refs/for/<current-branch>` with the same branch as the open change.

## Outputs

- One git commit since `state.run.baseline_sha`
- A Gerrit change on `refs/for/<current-branch>`

## On finish

```
node .agent-workflow/wf.mjs done pr --result <commit-sha>
```

Do not advance the stage yourself — wf.mjs verifies the postcondition.

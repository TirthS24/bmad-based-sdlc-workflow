---
name: wf-review
description: "Pipeline stage: local bmad-code-review plus test review on the main thread. Invoked only by the pipeline; not for the model to select on its own."
disable-model-invocation: true
---

## Required reading before acting

- `.agent-workflow/config.json`
- `.agent-workflow/standards.md` heading "Review rubric"
- `specs/spec-<run-id>/SPEC.md`
- `specs/spec-<run-id>/approach.md`

## What this stage does

Run **bmad-code-review from this main thread** (it spawns its own reviewers; nested subagents cannot nest further). Supply target and spec up front so it never asks:

- Review target: uncommitted changes plus commits since `state.run.baseline_sha` (branch diff against that SHA). Say this explicitly: "uncommitted" / working tree if there is no commit yet, otherwise "commit range `baseline_sha..HEAD` plus uncommitted".
- `spec_file`: `specs/spec-<run-id>/SPEC.md`
- Also pass approach.md as claims/context
- Do not use `gh pr view`

If the `bmad-testarch-test-review` skill is installed under `.agents/skills/` or `.cursor/skills/`, call it after the code review. Findings tagged `decision-needed` go into the review gate (`gate_review`) report, not a human interrupt now.

Write the combined review to `.agent-workflow/runs/<id>/review.md`. `high` / `decision-needed` still open block `wf done review`.

## Inputs

- Diff since baseline, SPEC.md, approved approach

## Outputs

- `.agent-workflow/runs/<id>/review.md` (may also patch `src/**` within round cap; never frozen tests)

## On finish

```
node .agent-workflow/wf.mjs done review --result .agent-workflow/runs/<id>/review.md
```

Do not advance the stage yourself — wf.mjs verifies the postcondition.

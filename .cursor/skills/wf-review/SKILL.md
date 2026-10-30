---
name: wf-review
description: "Pipeline stage: review. Run only when `wf status` says the stage is review."
---

## Required reading before acting

- `.agent-workflow/config.json`
- `.agent-workflow/standards.md` headings "Review rubric" and "Review finding format"
- `specs/spec-<run-id>/SRS.md`
- `specs/spec-<run-id>/approach.md`

## What this stage does

Thin dispatcher. The reviewer is independent: it never sees the implementer's transcript and never edits code.

1. Task `code-reviewer` with the spec path, the approach path and the baseline (`state.run.baseline_sha`, shown by `wf status`). Do not paste the implementation history.
2. Write its final message verbatim to `.agent-workflow/runs/<id>/review.md`.
3. If any `high` or `decision-needed` finding is open, dispatch `implementer` directly with the findings (not your opinion of them), then repeat from step 1. Do not run `/wf-implement` or `wf done implement` here; the run is already in `review`. Stop at the review round cap; `decision-needed` items the human must decide stay in the file and go to `gate_review`.
4. When the diff touches what a lens covers (security and privacy, data and migrations, test quality, edge cases), tell the reviewer to apply that lens; if `bmad-code-review` layers or `bmad-review` lenses are installed, it may use them.
5. If the `bmad-testarch-test-review` skill is installed under `.agents/skills/` or `.cursor/skills/`, run it after the first pass and append its findings in the same format.

## Inputs

- Diff since baseline, SRS.md, approved approach

## Outputs

- `.agent-workflow/runs/<id>/review.md`

## On finish

```
node .agent-workflow/wf.mjs done review --result .agent-workflow/runs/<id>/review.md
```

Do not advance the stage yourself — wf.mjs verifies the postcondition.

---
name: wf-pr
description: "Pipeline stage: commit the run's files and open a GitHub PR. Invoked only after gate_final is approved."
disable-model-invocation: true
---

## Required reading before acting

- `.agent-workflow/workflow.json` (protected_files, guarded_shell_patterns)
- `node .agent-workflow/wf.mjs status` (gate_final must be approved)

## Precondition

`state.json.gates.gate_final.status == approved`. The beforeShellExecution hook enforces this independently for `git commit`, `git push` and `gh pr create` — this check is a fast-fail, not the only guard.

## What this stage does

1. You are on the run branch `wf/<run-id>` (created by `wf run`). Do not switch branches.
2. Run `node .agent-workflow/wf.mjs adr`. It copies the two-line decision record from `approach.md` into `docs/adr/NNNN-<slug>.md`; commit that file with the rest. `wf pr` refuses to open the PR without it.
3. Stage exactly the intended files: SRS.md, tickets, approach.md, tests, the ADR, and product code. Do not stage `.agent-workflow/state.json` or `events.jsonl`.
4. Commit. Message style: `feat:`, `fix:`, `refactor:`, `docs:`, or `chore:` focusing on why. One or several commits are fine. Do not pass `--no-verify`.
5. Write the change summary to `.agent-workflow/runs/<run-id>/pr-summary.md`. It is the "What changed" section of the PR, read by a peer reviewer who has not followed the run. Write it in plain language: what the change does and why, grouped by behaviour or area, in 3–8 short bullets or a couple of short paragraphs. Do not list files (the PR body already attaches the file list), do not paste code, and do not repeat the acceptance criteria. `wf pr` refuses to open the PR without it.
6. Preview the PR: `node .agent-workflow/wf.mjs pr --dry-run`. Show the human the title and body.
7. Open it: `node .agent-workflow/wf.mjs pr`. This pushes the branch to `origin` and runs `gh pr create` with the generated body (summary, acceptance criteria, test results, risk note).

## Outputs

- `docs/adr/NNNN-<slug>.md` committed on the run branch
- At least one commit since `state.run.baseline_sha` on `wf/<run-id>`
- `.agent-workflow/runs/<run-id>/pr-summary.md` (local, not committed)
- A GitHub PR; its URL is printed and stored in `state.pr.url`

## If something fails

- `git push failed` — fix the remote or credentials, then run `wf pr` again.
- `gh pr create failed` — check `gh auth status`, then run `wf pr` again. The push is safe to repeat.
- If the human opened the PR themselves, finish with: `node .agent-workflow/wf.mjs done pr --result <PR URL>`

Do not advance the stage yourself — wf.mjs does it.

# Agent instructions

This repo runs a spec-driven build workflow. Before doing anything else
in a task-shaped request, run: `node .agent-workflow/wf.mjs status`

- If a run is **active**, follow its `next_action` exactly. Don't skip
  stages, edit `.agent-workflow/state.json` directly, or run `git commit`
  / `git push` to `refs/for/` before Gate 2 is recorded — these are
  enforced by hooks and will be blocked.
- If **no run is active** and the request is a new feature or bug fix,
  start one: `/wf-run <ticket-id-or-description>`.
- Trivial edits (typo, one-line fix) you're willing to review yourself
  don't need the workflow — just make the change.

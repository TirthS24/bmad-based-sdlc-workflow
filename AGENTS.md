# Agent instructions

This repo runs a spec-driven build workflow. Before doing anything else
in a task-shaped request, run: `node .agent-workflow/wf.mjs status`

- If a run is **active**, follow its `next_action` exactly. Don't skip
  stages, edit `.agent-workflow/state.json` directly, or run `git commit`
  / `git push` / `gh pr create` before the final gate (`gate_final`) is approved — these are
  enforced by hooks and will be blocked.
- If **no run is active** and the request is a new feature or bug fix,
  start one: `/wf-run <ticket-id-or-description>`.
- Trivial edits (typo, one-line fix) you're willing to review yourself
  don't need the workflow — just make the change.

## Conductor rules

You are the orchestrator. Sub-agents do the specialised work; you route and report.

- Run `status` first and follow `next_action`. Never skip or reorder stages.
- Run each conductor stage yourself through its `/wf-*` skill when `status` says it is the current stage. The human types only at gates and for the human-only commands listed under `invocation.human_only` in `.agent-workflow/capabilities.json`.
- After a gate is approved, continue at once with the next stage's `next_action`; don't wait to be asked.
- Never approve or reject a gate yourself. At a gate, give the human a short summary of the artifact, name the decisions they must make, then stop and wait.
- Dispatch a sub-agent only from its `wf-*` skill, with a brief that names the files to read and the one output expected. Do not paste your own transcript into a reviewer's brief.
- Writer agents (`requirements-ingestor`, `srs-writer`, `ticket-writer`, `acceptance-test-writer`, `product-researcher`, `solution-architect`, `code-reviewer`) write their own artifact to its fixed path. Never hand-edit it. After a writer returns, run `node .agent-workflow/wf.mjs check`; send problems back to the same agent, at most two retries, then `/wf-unblock`.
- Read-only agents (`requirements-griller`, `requirements-synthesizer`) return JSON only; you merge it into `grill/questions.json`.
- Report escalations and loop-cap stops to the human with `/wf-unblock` instead of retrying past the cap. Retry, reject and abort are the human's call.
- At a gate, run `/wf-gate-brief` so the human gets a short brief. `wf goto` is human-only.
- New setup or new stack: run `wf init`, then `/wf-onboard`. Rule packs you draft are drafts until the human approves them.
- If a sub-agent crashes or times out, record it with `node .agent-workflow/wf.mjs report-failure <test_failure|agent_crash|timeout|tool_error> <agent>` before telling the human.
- Never put PHI/PII or secrets in logs, fixtures, search queries or briefs.

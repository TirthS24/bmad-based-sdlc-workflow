# Spec-driven agentic workflow

This repository is a Cursor project for a gated, spec-driven build pipeline. It is not an application. Open the repo in Cursor and drive work with slash skills. The state machine in `.agent-workflow/wf.mjs` decides the stage; hooks block edits, commits, pushes, and PR creation that the current stage does not allow. Delivery is a GitHub PR.

## Prerequisites

- Cursor with project skills and subagents enabled
- Node.js 20.12+
- Git
- `gh` (GitHub CLI), logged in, and an `origin` remote on GitHub for the PR stage
- `uv`, for BMAD skills that run Python helpers

## Layout

| Path | Role |
| --- | --- |
| `AGENTS.md` | Always-on pointer. Check status, then follow `next_action`. |
| `.cursor/skills/wf-*` | Pipeline skills. Slash-only (`disable-model-invocation`). |
| `.agents/skills/bmad-*` | BMAD skills Cursor also loads (spec, review, code review, and others on the allowlist). |
| `.cursor/agents/` | Subagents the pipeline dispatches. One flat `.md` file per agent. |
| `.cursor/hooks.json` | Session status, write guard, shell guard, audit log, implement loop. |
| `.cursor/rules/` | File-scoped engineering rules. They apply by glob, not to every chat. |
| `.agent-workflow/` | Stage definitions, config, standards, and the `wf.mjs` CLI. |
| `_bmad/` | BMAD installer config and scripts. |
| `specs/spec-<run-id>/` | `SPEC.md`, `approach.md`, and `test-plan.md` for a run. Commit these with the change. |

Cursor loads project skills from both `.cursor/skills/` and `.agents/skills/`. Do not copy a skill into both places.

These extra skills stay in `.cursor/skills/` and are slash-only, so they do not interrupt a run: `frontend-design`, `unit-testing-test-generate`, `product-quality-assurance`, `prompt-engineering-xml`.

## Start a run

In Agent chat:

```text
/wf-run <jira-key-or-ticket-or-short-description>
```

If a run is already active, that skill prints status and stops. A one-line fix you will review yourself does not need a run.

Check progress any time:

```bash
node .agent-workflow/wf.mjs status
```

## Stages

`grill_spec` → **gate_spec** → `feasibility` → **gate_approach** → `test_plan` → **gate_plan** → `tests` → **gate_tests** → `implement` → `review` → **gate_review** → `verify` → **gate_final** → `pr`

Every stage exit has a human gate except `implement`, which loops on its own (retry cap and stuck-loop detection) and hands straight to `review`. `wf run` creates the branch `wf/<run-id>` from your current branch; the PR goes from it back to that branch.

| Skill | Who runs it | Result |
| --- | --- | --- |
| `/wf-start` | main thread, via `bmad-spec` | `specs/spec-<id>/SPEC.md` |
| `/wf-feasibility` | `feasibility-analyst` | `approach.md` |
| `/wf-test-plan` | `test-architect` (plan) | `test-plan.md` |
| `/wf-tests` | `test-architect` (ATDD) | failing tests under `config.json` `test_globs` |
| `/wf-implement` | `implementer` | one attempt; the stop hook retries up to the cap |
| `/wf-review` | main thread, `bmad-code-review` | `.agent-workflow/runs/<id>/review.md` |
| `/wf-verify` | `verifier` | evidence bundle under `runs/<id>/evidence/` |
| `/wf-approve <gate>` | human | passes a gate; `gate_approach` also records approach A, B, or C; `gate_final` unlocks commit, push, and PR |
| `/wf-reject <gate> <reason>` | human | sends the run back to the stage before the gate, with the reason (`gate_review` goes back to `implement`) |
| `/wf-pr` | main thread | commit on the run branch, write a plain-language change summary, then `wf pr` pushes it and runs `gh pr create` |
| `/wf-pause`, `/wf-resume`, `/wf-abort` | human | archive, restore, or stop the run |

Advance a stage only with `node .agent-workflow/wf.mjs done <stage> --result <path>`. The CLI checks the postcondition and refuses to move on if it fails.

## Subagents

Defined in `.cursor/agents/`. Invoke them only from the matching `wf-*` skill.

- `feasibility-analyst` — read-only. Returns the text that becomes `approach.md`.
- `test-architect` — plan mode or ATDD mode, as the task states.
- `implementer` — makes the frozen tests pass. Does not edit test globs.
- `verifier` — exploratory pass in the editor browser, then the evidence bundle.

## Development

`wf.mjs` only parses arguments. Logic lives in `.agent-workflow/lib/`, and harness-specific hook handling lives in `.agent-workflow/adapters/` (contract: `docs/adapter-contract.md`). Requirements and the roadmap are in `docs/REQUIREMENTS.md` and `docs/IMPLEMENTATION_PLAN.md`.

```bash
npm test    # node --test .agent-workflow/test/*.test.mjs
```

- Tests run `wf.mjs` against a throwaway git repo (`WF_DIR` and `REPO_ROOT` point at it), so they never touch the real `state.json`, `events.jsonl` or `runs/`.
- To pin new behaviour, add a case to the matching file in `.agent-workflow/test/` using `withRun(t)` from `helpers.mjs`.
- Don't work on the workflow's own files while a `wf` run is active: the write guard will block you.

## What stays out of git

`.agent-workflow/state.json`, `events.jsonl`, and `runs/` are local. So are `_bmad/**/*.user.toml` and `.DS_Store`. Specs, approach, test plan, tests, and product code are committed by `/wf-pr` after `gate_final`.

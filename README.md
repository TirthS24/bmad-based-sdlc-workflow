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
| `server/` | Telemetry server and admin dashboard (its own `package.json`; needs Postgres). |
| `installer/` | `install.mjs`, the per-harness installer. |
| `.cursor/agents/` | Subagents the pipeline dispatches. One flat `.md` file per agent. |
| `.cursor/hooks.json` | Session status, write guard, shell guard, audit log, implement loop. |
| `.agent-workflow/rules/` | Rule packs: shipped `generic.md`, `python.md` and `typescript-react.md`, plus other stacks drafted by `/wf-onboard` and approved by a human. |
| `.agent-workflow/` | Stage definitions, config, standards, and the `wf.mjs` CLI. |
| `_bmad/` | BMAD installer config and scripts. |
| `specs/spec-<run-id>/` | `SRS.md`, persona tickets under `tickets/`, `approach.md`, and product tests for a run. Commit these with the change. |

Cursor loads project skills from both `.cursor/skills/` and `.agents/skills/`. Do not copy a skill into both places.

These extra skills stay in `.cursor/skills/` and are slash-only, so they do not interrupt a run: `frontend-design`, `unit-testing-test-generate`, `product-quality-assurance`, `prompt-engineering-xml`.

## Install into a project

```bash
node installer/install.mjs --target /path/to/project --harness cursor|claude-code|generic [--server https://wf.example.com]
```

Adds the core, skills, agents, rule packs, the harness's hook wiring and the conductor rules (`AGENTS.md`, or `CLAUDE.md` for Claude Code, inside a managed block). Re-running upgrades; it never overwrites `config.json`, `project.json`, the generated project context, drafted rule packs or `scrub-patterns.json`. `generic` is for harnesses without hooks: it installs git hooks (`wf gate-check`) and a CI check (`wf ci-check`), and runs are recorded as `session_unchecked`. Hermes is not packaged separately yet: its hook and subagent capabilities are unknown, so use `generic` until they are checked.

## Usage telemetry

Every run emits typed events (stage times, gates, retries, errors) to a local queue under `.agent-workflow/queue/`. Only ids, counts, durations, error classes and short scrubbed reasons are captured; ticket text, code and prompts never are. Everything the hooks see is scanned for PHI/PII and only the category and count are kept.

| Command | What it does |
|---|---|
| `wf login --server <url> --email <you>` | Logs in (password from a prompt, or `--password-stdin`). The token is cached in `~/.agent-workflow-client/` for the server's session lifetime. |
| `wf sync` | Sends queued batches. A batch is deleted only for events the server acknowledged. Runs automatically when a run ends. |
| `wf whoami`, `wf logout` | Show the login and queue size; end the session. |
| `wf report-failure <class> <agent>` | Records a crashed or timed-out sub-agent. |

With `telemetry.required: true` in `config.json` (the installer sets it when you pass `--server`), `wf run` and `wf init` need a valid login; the cached token works offline. Server, dashboard and operations: `server/README.md`, `docs/RUNBOOK.md`. Baseline: `docs/BASELINE.md`.

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

## Setup

```bash
node .agent-workflow/wf.mjs init            # detect the stack, fill blank test/lint commands
```

Then run `/wf-onboard`. The agent writes `.agent-workflow/context/project-context.md` and drafts a rule pack under `.agent-workflow/rules/` for each detected stack. Read the packs, then approve each with `wf init --approve-pack <stack>`; editing one afterwards returns it to draft. `wf init --check` lists what is left, `wf init --refresh` re-detects (your edits to `config.json` are kept), and `wf init --rules` prints the rule files agents read. `rules/generic.md`, `python.md` and `typescript-react.md` ship and need no approval; any other stack gets a pack drafted for your project.

## Stages

`planning` → **gate_spec** → `feasibility` → **gate_approach** → `tests` → **gate_tests** → `implement` → `review` → **gate_review** → `verify` → **gate_final** → `pr`

Every stage exit has a human gate except `implement`, which loops on its own (retry cap and stuck-loop detection) and hands straight to `review`. `wf run` creates the branch `wf/<run-id>` from your current branch; the PR goes from it back to that branch.

| Skill | Who runs it | Result |
| --- | --- | --- |
| `/wf-onboard` | main thread, after `wf init` | `.agent-workflow/context/project-context.md` and draft rule packs |
| `/wf-start` | main thread orchestrator | ingest → grill → `SRS.md`, `tickets/`, AC test cases |
| `/wf-research` | `product-researcher` (opt-in) | `research.md` |
| `/wf-spec-review` | main thread (from `/wf-start`) | validated SRS + tickets |
| `/wf-feasibility` | `solution-architect` | `approach.md` |
| `/wf-tests` | `test-architect` (ATDD) | failing Playwright product tests under `product_test_globs` |
| `/wf-implement` | `implementer` | one attempt; the stop hook retries up to the cap |
| `/wf-review` | `code-reviewer` (independent); fixes go to `implementer` | `.agent-workflow/runs/<id>/review.md` |
| `/wf-verify` | `verifier` | evidence bundle under `runs/<id>/evidence/` |
| `/wf-approve <gate>` | human | passes a gate; `gate_approach` also records approach A, B, or C; `gate_final` unlocks commit, push, and PR |
| `/wf-reject <gate> <reason>` | human | sends the run back to the stage before the gate, with the reason (`gate_review` goes back to `implement`) |
| `/wf-pr` | main thread | commit on the run branch, write a plain-language change summary, then `wf pr` pushes it and runs `gh pr create` |
| `/wf-pause`, `/wf-resume`, `/wf-abort` | human | archive, restore, or stop the run |

Advance a stage only with `node .agent-workflow/wf.mjs done <stage> --result <path>`. The CLI checks the postcondition and refuses to move on if it fails.

## Commands for the human

| Command | What it does |
| --- | --- |
| `wf brief [gate]` | Facts for the gate you are at (artifacts, hashes, open questions, rejections, change since the last brief). `/wf-gate-brief` turns them into a short brief. |
| `wf goto <stage>` | Jump to another stage. Backwards always works. Forwards only over stages whose artifact passes its check, and never over an unapproved gate. |
| `wf escalation list\|retry\|reject\|abort` | Get out of a loop-cap or stuck-loop stop. `retry` resets the loop, `reject` returns to the previous gate's stage, `abort` ends the run. `/wf-unblock` explains the options. |
| `wf adr` | Copies the run's two-line decision record into `docs/adr/NNNN-<slug>.md`. `wf pr` refuses to open the PR until that file is committed. |
| `wf doctor` | Checks that `capabilities.json`, the skills, the agents and `standards.md` agree. Run it after editing any of them. |

`.agent-workflow/capabilities.json` maps each stage to its skills, agents, rule sections and artifact check.

## Tests

Two kinds, with different owners (`config.json`):

- **Product (flow) tests**: Playwright scripts under `product_test_globs` (default `E2E/tests/**`). `test-architect` writes them from the spec before any code, and they are frozen at `gate_tests`. Test titles start with their ids (`PRD-1.1 REQ-1 ...`).
- **Unit tests**: under `unit_test_globs`. The implementer writes and edits them.

`commands.e2e` should be `npx playwright test --reporter=list,json` (`wf init` suggests it when `@playwright/test` is installed). Verify runs `unit`, `lint`, `typecheck`, `format`, `complexity`, `seed` plus `e2e`, and `a11y`. It needs a passing Playwright test for every ticket test case tagged `e2e`, `ui` or `api` (`automated` cases in `specs/spec-<id>/tickets/**/*.json`), and writes `evidence/e2e-summary.md`. A test that passes only on retry is listed as flaky and does not block.

## Subagents

Defined in `.cursor/agents/`. Invoke them only from the matching `wf-*` skill.

- `solution-architect` — read-only. Returns the text that becomes `approach.md`.
- `test-architect` — plan mode or ATDD mode, as the task states.
- `product-researcher` — read-only, opt-in. Returns sourced research for open spec questions.
- `code-reviewer` — read-only and independent. Returns the text that becomes `review.md`.
- `implementer` — makes the frozen tests pass and owns the unit tests. Does not edit the frozen product tests.
- `verifier` — exploratory pass in the editor browser, then the evidence bundle.

## Development

`wf.mjs` only parses arguments. Logic lives in `.agent-workflow/lib/`, and harness-specific hook handling lives in `.agent-workflow/adapters/` (contract: `docs/adapter-contract.md`). Requirements and the roadmap are in `docs/REQUIREMENTS.md` and `docs/IMPLEMENTATION_PLAN.md`.

```bash
npm test             # workflow core: node --test .agent-workflow/test/*.test.mjs (no database)
npm run test:server  # server: needs Postgres binaries on the machine
cd server && npm run test:ui   # Playwright dashboard tests
```

- Tests run `wf.mjs` against a throwaway git repo (`WF_DIR` and `REPO_ROOT` point at it), so they never touch the real `state.json`, `events.jsonl` or `runs/`.
- To pin new behaviour, add a case to the matching file in `.agent-workflow/test/` using `withRun(t)` from `helpers.mjs`.
- Don't work on the workflow's own files while a `wf` run is active: the write guard will block you.

## What stays out of git

`.agent-workflow/state.json`, `events.jsonl`, and `runs/` are local. So are `_bmad/**/*.user.toml` and `.DS_Store`. Specs, approach, test plan, tests, and product code are committed by `/wf-pr` after `gate_final`.

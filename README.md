# Spec-driven agentic workflow

A gated, spec-driven build pipeline for coding agents (Cursor, Claude Code, or a generic harness). It is not an application. You start a run with one slash command. The main agent thread (the **conductor**) then drives sub-agents through planning, design, tests, implementation, review and verification, and stops only at human **gates**. Delivery is a GitHub PR.

The state machine in `.agent-workflow/wf.mjs` owns the stage. Agents never edit `state.json`. Each stage advances only through `wf done <stage>`, which runs that stage's postcondition and a scope check against the git diff. Hooks block edits outside the stage's allowed paths. They also block `git commit`, `git push` and `gh pr create` until `gate_final` is approved.

## How it works

```
/wf-run <ticket>
  planning ──► gate_spec ──► feasibility ──► gate_approach ──► tests ──► gate_tests
  ──► implement ──► review ──► gate_review ──► verify ──► gate_final ──► pr
```

| Stage | Done by | Produces |
|---|---|---|
| `planning` | conductor via `/wf-start`, with the sub-agents `requirements-ingestor`, `requirements-griller`, `requirements-synthesizer`, `srs-writer`, `ticket-writer` and `acceptance-test-writer` | `specs/spec-<id>/draft-requirements.md`, `grill/questions.json`, `SRS.md`, persona tickets `tickets/<persona>/TKT-*.json` with Given/When/Then test cases on each acceptance criterion |
| `feasibility` | `solution-architect` | `approach.md`: two or more approaches, a decision, risks and rollback |
| `tests` | `test-architect` (ATDD) | Failing Playwright product tests, frozen at `gate_tests` |
| `implement` | `implementer` | Code and unit tests. The stop hook retries up to the loop cap. |
| `review` | `code-reviewer` (independent); fixes go to `implementer` | `.agent-workflow/runs/<id>/review.md` |
| `verify` | `verifier` | Evidence bundle under `runs/<id>/evidence/` |
| `pr` | conductor via `/wf-pr` | Commit on `wf/<run-id>`, ADR, PR summary, then `gh pr create` |

**Planning in brief:**
1. The ingestor collects context from connected MCPs (Confluence, Slack, Jira) and the repo docs.
2. The griller asks questions about the draft.
3. The synthesizer answers what it can, citing **only Confluence or repo files**. A question it can't answer comes to you, one at a time.
4. The loop stops when there are no new questions, or at `loop_caps.grill` (default 5). If it hits the cap with questions still open, it escalates to you.

**Gates:** `gate_spec`, `gate_approach`, `gate_tests`, `gate_review`, `gate_final`. In the `full` profile, all of them are yours. Other profiles skip some gates or auto-pass them under a rule. See [Run profiles](#run-profiles).

**Who types what:** you type only the commands marked *human* below, plus answers to escalated questions. The conductor runs every other stage skill as soon as `wf status` names that stage. It also continues on its own after you approve a gate.

## Prerequisites

- Cursor (project skills and sub-agents enabled) or Claude Code
- Node.js 20.12+, Git
- `gh` (GitHub CLI), logged in, and an `origin` remote on GitHub for the `pr` stage
- `uv`, for the BMAD skills' Python helpers (review, research, onboarding, walkthrough)
- Optional: an Atlassian MCP (Jira/Confluence) and a Slack MCP for ingestion; Postgres for the telemetry server

## Install and set up

Install into a project:

```bash
node installer/install.mjs --target /path/to/project --harness cursor|claude-code|generic [--server https://wf.example.com]
```

The installer adds the core, skills, agents, rule packs, the hook wiring and the conductor rules (`AGENTS.md`, or a managed block in `CLAUDE.md` for Claude Code). For Claude Code, it translates each agent's frontmatter into a tool list: read-only agents get no `Write`/`Edit`/`Bash`, and writer agents get `Write`/`Edit` but no `Bash`.

Re-running the installer upgrades. It never overwrites `config.json`, `project.json`, the project context, drafted rule packs or `scrub-patterns.json`.

Use `generic` for harnesses without hooks. It installs git hooks (`wf gate-check`) and a CI check (`wf ci-check`) instead.

Then, once per project:

```bash
node .agent-workflow/wf.mjs init        # detect the stack, fill blank test/lint commands
```

```text
/wf-onboard                             # writes .agent-workflow/context/project-context.md and drafts rule packs
```

```bash
node .agent-workflow/wf.mjs init --approve-pack <stack>   # after reading each drafted pack
node .agent-workflow/wf.mjs doctor                        # capabilities, skills, agents and standards agree
```

`rules/generic.md`, `python.md` and `typescript-react.md` ship with the workflow and need no approval. Editing an approved pack returns it to draft.

## Run profiles

A run's profile decides which stages run and which gates may auto-pass. You choose it with `/wf-run --profile <name> …` (the default is `full`). Only you can switch it, with `/wf-profile <name>`, and only until `gate_spec` is approved.

| Stage / gate | `full` (default) | `pm` (tickets only) | `dev` (alpha bug) | `docs` |
|---|---|---|---|---|
| planning | runs | runs | runs (≤2 grill rounds, bug repro as the test) | runs |
| gate_spec | you | you | auto: `planning_clean` | you |
| feasibility, gate_approach | runs; you | skipped | runs; auto: `approach_low_risk` | skipped |
| tests, gate_tests | runs; you | skipped | runs; auto: `red_for_right_reason` | skipped |
| implement, review, gate_review | runs; you | skipped | runs; auto: `no_open_high_or_decision` | runs on `docs_globs` only; auto: `no_open_high_or_decision` |
| verify | all tiers | skipped | all tiers | `docs_lint`, `links` |
| gate_final | you | auto: `specs_only_unchanged` | you | you |
| pr | runs, ADR required | specs only | runs | runs |

An auto-pass happens only when the stage before the gate passed its check, the gate has never been rejected or reset in this run, and no escalation is pending. Each auto-pass is recorded with `approved_by: "auto"` and its reason, and listed in the PR body's `## Gates` table. When an auto-pass is declined, the gate waits for you and `wf status` says why. Full rules: [docs/USER_GUIDE.md](docs/USER_GUIDE.md) section 4.

## Skills

Pipeline skills live in `.cursor/skills/`. `capabilities.json` splits them into `human_only` (these keep `disable-model-invocation: true`) and `conductor`. `wf doctor` fails if a skill's flag doesn't match its group.

| Skill | Run by | Purpose |
|---|---|---|
| `/wf-run [--profile <name>] <ticket>` | human | Start a run from a Jira key, pasted ticket or free text, then go into `/wf-start` |
| `/wf-approve <gate>` | human | Pass a gate. `gate_approach` takes `--approach A\|B\|C`. `gate_final` unlocks commit, push and the PR. |
| `/wf-reject <gate> <reason>` | human | Send the run back to the stage before the gate (`gate_review` goes back to `implement`) |
| `/wf-profile <name>` | human | Switch the profile before `gate_spec` is approved |
| `/wf-goto <stage>` | human | Jump stages. Backwards always works; forwards only over stages whose artifact passes its check. |
| `/wf-unblock` | human | Explain a loop-cap or stuck-loop stop and offer retry, reject or abort |
| `/wf-pause`, `/wf-resume`, `/wf-abort` | human | Archive, restore or end the run |
| `/wf-onboard` | human | Project context and draft rule packs, after `wf init` |
| `/wf-jira-tickets` | human | Create Jira issues from the approved tickets (you choose the shape and project key) and write the keys back |
| `/wf-start` | conductor | The planning stage |
| `/wf-research` | conductor | Optional sourced research (`product-researcher`) → `research.md` |
| `/wf-spec-review` | conductor | Review the SRS and tickets before `gate_spec` |
| `/wf-feasibility` | conductor | `solution-architect` → `approach.md` |
| `/wf-tests`, `/wf-playwright-e2e` | conductor | Failing Playwright product tests, following the project's conventions |
| `/wf-implement` | conductor | One `implementer` attempt; the stop hook loops |
| `/wf-review` | conductor | Independent review → `review.md` |
| `/wf-verify` | conductor | Verification tiers and the evidence bundle |
| `/wf-pr` | conductor | Commit, ADR, summary, PR |
| `/wf-gate-brief` | conductor | A short brief at each gate: what to read and what you must decide |
| `persona-ui-ux`, `persona-fe`, `persona-be`, `persona-qa` | conductor | What each persona's tickets must cover |
| `product-quality-assurance` | `acceptance-test-writer` (planning) | Test design for each AC's `test_cases`: traceability, risk-based depth, non-functional cases |
| `frontend-design` | `implementer` (implement) | Applied to every `fe` ticket's UI. The approach, rule packs and existing design system win. |

The pipeline also invokes these BMAD skills from `.agents/skills/`. The installer ships them, together with `_bmad/scripts/` and a minimal `_bmad` config (written only when missing):

| Skill | Invoked by | How |
|---|---|---|
| `bmad-code-review`, `bmad-review` | `code-reviewer` (from `/wf-review`) | Runs the review layers and lenses in sequence; findings go into `review.md` |
| `bmad-deep-recon` | `product-researcher` (from `/wf-research`) | Run mode, with the pack the brief names; workspace `specs/spec-<id>/research/` |
| `bmad-project-context` | `/wf-onboard` | Survey only; never edits `AGENTS.md`/`CLAUDE.md` |
| `bmad-walkthrough` | `/wf-gate-brief` | Walks you through the change at `gate_review`, when that gate waits for you |

`wf prune` deletes every `bmad-*` skill that isn't in `bmad-allowlist.json`.

## Sub-agents

Defined in `.cursor/agents/`. The `wf-*` skills dispatch them; nothing else should.

| Agent | Writes | Notes |
|---|---|---|
| `requirements-ingestor` | `draft-requirements.md` | MCP + repo; no PHI/PII in queries |
| `requirements-griller` | none (returns JSON) | Read-only |
| `requirements-synthesizer` | none (returns JSON) | Read-only; cites Confluence or repo files, or returns `UNANSWERABLE` |
| `srs-writer` | `SRS.md` | |
| `ticket-writer` | `tickets/**` | Uses the persona skills |
| `acceptance-test-writer` | `tickets/**` (only `test_cases`) | Fresh context |
| `product-researcher` | `research.md` | Opt-in |
| `solution-architect` | `approach.md` | Includes the decision block that `dev` auto-pass reads |
| `test-architect` | product tests | ATDD from ticket test cases |
| `implementer` | code, unit tests | Never edits frozen product tests |
| `code-reviewer` | `review.md` | Independent; writes no source |
| `verifier` | evidence | |

After a writer agent returns, the conductor runs `wf check`. Any problems go back to the same agent, with at most two retries, then `/wf-unblock`. The conductor never hand-edits an agent's artifact.

## CLI commands

Run as `node .agent-workflow/wf.mjs <command>`. The table calls it `wf` for short.

| Command | Options | Purpose |
|---|---|---|
| `init` | `--refresh`, `--check`, `--rules`, `--approve-pack <id>` | Detect the stack and set up config; re-detect, list what's left, print active rule files, or approve a drafted pack |
| `run <source>` | `--profile full\|pm\|dev\|docs` | Start the single active run on branch `wf/<run-id>` |
| `status` | `--check`, `--hook` | Show the stage, gates and `next_action`. `--check` exits 1 on a loop cap or a pending escalation. |
| `done <stage>` | `--result <path>` | Run the postcondition and scope check, then advance (and auto-pass the next gate if the profile allows) |
| `check [stage]` | `--result <path>` | Run a postcondition without advancing, and preview whether the next gate would auto-pass |
| `tickets check` | | Validate the tickets and questions (alias of `check planning`) |
| `approve <gate>` | `--approach A\|B\|C` | *Human:* pass a gate |
| `reject <gate>` | `--reason <text>` | *Human:* reject a gate |
| `profile <name>` | | *Human:* switch profile |
| `goto <stage>` | | *Human:* jump stages |
| `brief [gate]` | | Facts for the gate brief (artifacts, hashes, counts, changes since the last brief) |
| `escalation list\|retry\|reject\|abort` | `--reason <text>` | Get out of a loop-cap or stuck-loop stop |
| `adr` | | Copy the decision record into `docs/adr/NNNN-<slug>.md` |
| `verify` | | Run the profile's verify tiers and write the evidence |
| `pr` | `--dry-run` | Push and open the PR (only after `gate_final`) |
| `pause`, `resume [id]`, `abort` | `--force` (abort) | Run lifecycle |
| `agent start\|end <name>` | | Record sub-agent timing (`generic` harness only) |
| `guard <preToolUse\|beforeShellExecution\|stop>` | | Hook: write, shell and stop guards |
| `log <afterFileEdit\|subagentStart\|subagentStop>` | | Hook: audit and telemetry events |
| `report-failure <class> <agent>` | class: `test_failure\|agent_crash\|timeout\|tool_error` | Record a sub-agent failure |
| `doctor` | | Check that capabilities, skills, agents, standards and profiles agree |
| `prune` | `--dry-run` | Delete `bmad-*` skills that aren't in the allowlist |
| `gate-check`, `ci-check` | | Enforcement for the `generic` harness (git hooks / CI) |
| `login` | `--server <url>`, `--email <e>`, `--password-stdin` | Log in to the telemetry server |
| `logout`, `whoami`, `sync` | | End the session; show the login and queue size; send queued events |

## Walkthroughs

In the three examples, `you>` is what you type in the agent chat or terminal, and the indented lines are what the conductor does on its own.

### `full`: a product feature

```text
you> /wf-run PAY-142 implement card payments on checkout
       wf run → branch wf/<id>, stage planning
       /wf-start: ingest → grill rounds → SRS.md → tickets (ui_ux, fe, be, qa) → AC test cases
       asks you each question it could not answer from Confluence or the repo, for example:
         "Which payment provider: Stripe, Adyen, other?"
you> (answer the question)
       wf tickets check → /wf-spec-review → wf done planning → stage gate_spec
       /wf-gate-brief: REQ count, tickets per persona, test cases, escalated questions

you> /wf-approve gate_spec
       (optional, any time after this) you> /wf-jira-tickets
       /wf-feasibility → approach.md with approaches A/B → gate_approach brief

you> /wf-approve gate_approach --approach A
       /wf-tests → failing Playwright tests that cite PRD-n.m ids → gate_tests brief

you> /wf-approve gate_tests
       tests are frozen
       /wf-implement (loops until green, or escalates at the cap)
       /wf-review (fixes go to implementer) → gate_review brief

you> /wf-approve gate_review
       /wf-verify → evidence bundle → gate_final brief

you> /wf-approve gate_final
       /wf-pr: wf adr → commit → pr-summary.md → wf pr --dry-run → wf pr → PR URL
```

To send work back, reject the gate instead of approving it: `/wf-reject gate_review "error states missing"`. If the run stalls at a loop cap, run `/wf-unblock`.

### `pm`: tickets only, optionally pushed to Jira

```text
you> /wf-run --profile pm PAY-150 define the refund flow
       /wf-start: same planning flow as full (ingest → grill → SRS → tickets → AC test cases)
you> (answer any escalated questions)
       gate_spec brief

you> /wf-approve gate_spec
       feasibility, tests, implement, review and verify are marked skipped
       gate_final auto-passes (specs_only_unchanged) if only specs/spec-<id>/** changed
       and SRS.md and the tickets are unchanged since gate_spec

you> /wf-jira-tickets            (optional: choose stories / sub-tasks / epic + stories, and the project key)
       /wf-pr: commit only specs/spec-<id>/**, then wf pr (no ADR required; pr_paths is checked again)
```

Changing anything outside `specs/` after `gate_spec`, or editing the SRS or tickets, sends `gate_final` back to you.

### `docs`: documentation only

Set the doc checks first, or verify will skip those tiers and say so:

```json
"commands": { "docs_lint": "npx markdownlint-cli2 \"**/*.md\"", "links": "npx lychee --offline docs" }
```

```text
you> /wf-run --profile docs Handover documents for developers and product managers
       /wf-start: planning as usual
you> (answer any escalated questions)
       gate_spec brief

you> /wf-approve gate_spec
       feasibility and tests are skipped
       /wf-implement writes only docs_globs (docs/**, **/*.md); a write elsewhere, even through the shell,
       fails `wf done implement` and names the file
       /wf-review (Approach conformance and Test quality are N/A)
       gate_review auto-passes when there's no open high or decision-needed finding (otherwise you approve it)
       /wf-verify runs docs_lint and links → gate_final brief

you> /wf-approve gate_final
       /wf-pr → PR
```

For a `dev` bug fix, use `/wf-run --profile dev <bug>`. A low-risk fix usually stops only at `gate_final`. It also stops at `gate_approach` when the architect flags a contract change, a migration or a new dependency.

## Tests

- **Product tests:** Playwright specs under `product_test_globs` (default `E2E/tests/**`). They are written from the ticket test cases before any code exists, and frozen at `gate_tests`. Test titles start with their ids (`PRD-1.1 REQ-1 …`).
- **Unit tests:** under `unit_test_globs`. The implementer owns them.

`commands.e2e` should be `npx playwright test --reporter=list,json`. In `full` and `dev`, verify runs `unit`, `lint`, `typecheck`, `format`, `complexity`, `seed`, `e2e` and `a11y`. Every automated ticket test case on the `e2e`, `ui` or `api` layer needs a passing Playwright test. A test that passes only on retry is listed as flaky and doesn't block.

## Usage telemetry

Every run writes typed events to `.agent-workflow/queue/`: stage times, gates (human or auto), skipped stages, sub-agent timings, retries, error classes and the count of escalated questions. Ticket text, code and prompts are never captured. Anything that looks like PHI/PII is reduced to a category and a count.

To send the events to a server, log in with `wf login` and run `wf sync`. With `telemetry.required: true`, `wf run` and `wf init` need a login. Server and dashboard: [server/README.md](server/README.md) and [docs/RUNBOOK.md](docs/RUNBOOK.md). Baseline: [docs/BASELINE.md](docs/BASELINE.md).

## Repository layout

| Path | Role |
|---|---|
| `AGENTS.md` | Conductor rules: check status, then follow `next_action` |
| `.agent-workflow/` | `wf.mjs` CLI, `workflow.json` (stages, profiles), `config.json`, `capabilities.json`, `standards.md`, `rules/`, `lib/`, `adapters/`, `test/` |
| `.cursor/skills/`, `.cursor/agents/`, `.cursor/hooks.json` | Pipeline skills, sub-agents and hook wiring |
| `.agents/skills/bmad-*` | BMAD skills the pipeline invokes, plus `_bmad/` for their config and resolver scripts |
| `installer/` | Per-harness installer |
| `server/` | Telemetry server and admin dashboard (needs Postgres) |
| `examples/sample-app/` | Small app for manual end-to-end runs |
| `docs/` | User guide, runbook, adapter contract, baseline |
| `specs/spec-<run-id>/` | Per-run artifacts (SRS, tickets, approach, product tests); commit them with the change |

## Development

`wf.mjs` only parses arguments. The logic lives in `.agent-workflow/lib/`, and harness-specific hook handling lives in `.agent-workflow/adapters/` (contract: [docs/adapter-contract.md](docs/adapter-contract.md)).

```bash
npm test                       # workflow core (no database)
npm run test:server            # server: needs Postgres binaries
cd server && npm run test:ui   # Playwright dashboard tests
```

- Tests run `wf.mjs` against a throwaway git repo, so they never touch the real `state.json`, `events.jsonl` or `runs/`. Add cases with `withRun(t)` from `helpers.mjs`.
- Run `wf doctor` after editing skills, agents, `capabilities.json`, `standards.md` or `workflow.json`.
- Don't edit the workflow's own files while a run is active; the write guard blocks it.

`.agent-workflow/state.json`, `events.jsonl`, `runs/`, `queue/`, `_bmad/**/*.user.toml` and `.DS_Store` stay out of git. Run artifacts and product code are committed by `/wf-pr` after `gate_final`.

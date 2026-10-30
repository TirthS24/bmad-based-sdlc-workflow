# Plan: Workflow hardening after the first dry run

## Context

The planning-stage redesign ([planning-stage-redesign.md](planning-stage-redesign.md)) was implemented and dry-run under Claude Code on a docs-only task. Planning worked. Everything after it hit five pain points, plus the gaps against that plan; see that plan's "Dry-run findings" section. This plan fixes all of them, in this order:

1. The conductor can run the pipeline end to end; you are needed only at gates.
2. Writes through the shell can no longer get past the stage's allowed paths.
3. Validators report every problem, each with its rule and a passing example, and stop rejecting reasonable formatting.
4. Run profiles (`full`, `pm`, `dev`, `docs`) decide which stages run and which gates the harness may auto-pass.
5. Sub-agents write their own artifacts, so you stop retyping their output into files.
6. Close the gaps left from the previous plan.

These stay as they are: all six gates are human in the default `full` profile (other profiles skip or auto-pass gates only as section 4 sets out), `wf approve` / `wf reject` / `wf goto` / `wf profile` remain human-only, the `gate_final` lock on commit, push and PR creation, and the frozen product tests.

## 1. The conductor runs the pipeline

**Cause:** every `wf-*` skill has `disable-model-invocation: true`, which in Claude Code means only a human can start it.

**Change:**
- Split the skills into two groups, recorded in [capabilities.json](.agent-workflow/capabilities.json) as `human_only` and `conductor`.
  - `human_only` (keep the flag): `wf-run`, `wf-approve`, `wf-reject`, `wf-goto`, `wf-abort`, `wf-pause`, `wf-resume`, `wf-unblock`, `wf-onboard`, `wf-profile`, `wf-jira-tickets` (it writes to Jira, so it needs your yes).
  - `conductor` (remove the flag): `wf-start`, `wf-research`, `wf-spec-review`, `wf-feasibility`, `wf-tests`, `wf-implement`, `wf-review`, `wf-verify`, `wf-pr`, `wf-gate-brief`, `wf-playwright-e2e`, `persona-*`.
- Rewrite each conductor skill's `description` to "Pipeline stage X. Run only when `wf status` says the stage is X." The flag existed so that skills wouldn't fire out of order. `wf done` already refuses a wrong stage, so stage order stays enforced.
- [doctor.mjs](.agent-workflow/lib/doctor.mjs): fail if a `human_only` skill is missing the flag, or a `conductor` skill has it.
- `NEXT_ACTION` text in [state.mjs](.agent-workflow/lib/state.mjs) and the conductor rules (`AGENTS.md` and the installer's CLAUDE.md block) say "run `/wf-x`" for conductor stages and "ask the human to run …" only at gates.
- After a gate is approved, the next stage's `next_action` is picked up by the conductor at once, so you don't need to type anything.

## 2. Close the shell-write hole

**Cause:** `guardPreToolUse` checks only Write/Edit tool paths, and `guardShell` only matches commit, push and PR creation. Reproduced: `cat > docs/x.md` is allowed in `implement`.

**Change:** a deterministic scope check on the git diff instead of trying to parse shell commands.
- New `scopeViolations(state, workflow, config)` in [guards.mjs](.agent-workflow/lib/guards.mjs).
  - Changed files are those in `git diff --name-only <baseline_sha>` plus untracked files (`git ls-files --others --exclude-standard`).
  - Allowed paths are the union of the `writes` of every stage up to and including the current one, plus run artifacts (`specs/spec-<id>/**`, `.agent-workflow/runs/<id>/**`).
  - Returns the files that fall outside.
- `cmdDone` calls it for every non-gate stage. A violation fails the postcondition with the file list and the allowed paths.
- The stop hook (`guardStop`) calls it too, so a stray write is reported in the same turn. It does not block; it adds the list to the follow-up.
- `writes` gains a `<run_dir>` token for `review` and `verify`, so `review.md` and `evidence/` are explicitly allowed. Today `verify.writes` is `[]`, yet the evidence bundle still gets written, probably by the same shell route.
- The status line's `writes:` text says "(checked against the git diff at done)" so it matches what is enforced.
- Keep the existing per-tool deny; it is the fast path. The diff check is the backstop.

## 3. Validators that explain themselves

**Causes:**
- `checkPlanning` and the other postconditions return only the first problem.
- Messages print the regex source.
- `capabilityBlock` uses `indexOf(id)` on the whole text, so it matches cross-references and `REQ-1` matches inside `REQ-10`.
- The SRS heading rule rejects `## 1.`, and source paths with line ranges are rejected.

**Change:**
- Every check returns `[{ rule, found, expected, example }]`. `cmdDone` prints all of them as `✗ <rule>: found <x>; expected <y>. Example: <z>`. Postconditions in [postconditions.mjs](.agent-workflow/lib/postconditions.mjs) and [tickets.mjs](.agent-workflow/lib/tickets.mjs) move to this shape. A small `problem()` helper builds them; no framework.
- `capabilityBlock` matches the definition only (`^\s*-\s*\*\*REQ-n\*\*` with a word boundary), not the first mention.
- Relax these rules:
  - SRS headings accept `1`, `1.` and `1)`.
  - Source paths accept `path:12`, `path:12-30` and `path#L12-L30` (strip the range, then check the file exists).
  - The approach `Decision` heading accepts leading numbering or emphasis.
  - In review bullets, the summary line `open: 0` is no longer treated as an untagged finding.
- `wf check [stage]` runs the current (or a named earlier) stage's postcondition without advancing. `wf tickets check` stays as an alias. It also previews whether the profile would auto-pass the next gate (4a.3).
- `standards.md`: each format section ends with "Checked by `wf check <stage>`" and a minimal passing example. The examples are the same strings the error messages print.

## 4. Run profiles: `full` (default), `pm`, `dev`, `docs`

**Cause:** every run went through the whole code pipeline. A docs-only task had no supported path, and PM-only or quick dev fixes would pay for six human gates.

**Profiles × stages.** H = human approves · A = auto-pass if its condition holds, otherwise falls back to H · — = skipped · Run = the stage runs.

| Stage / gate | `pm` (tickets → Jira) | `dev` (alpha bug, internal finding) | `docs` | `full` |
|---|---|---|---|---|
| planning | Run | Run (lite: usually 1 ticket, bug repro as the test case) | Run | Run |
| gate_spec | H | A: every question answered and `wf check` passes | H | H |
| Jira push (`wf-jira-tickets`, human-only) | H (asked at `pr`, before the commit) | optional, H | — | optional, H |
| feasibility / gate_approach | — | Run / A: architect says low-risk (see below) | — | Run / H |
| tests | — | Run (regression test must fail first) | — | Run |
| gate_tests | — | A: tests fail for the right reason and cite the ids (existing check) | — | H |
| implement / review | — | Run | Run (docs paths) | Run |
| gate_review | — | A: no open `high` and no `decision-needed` findings | A: same | H |
| verify | — | Run | Run (markdown lint, links) | Run |
| gate_final | A: diff touches only `specs/**`, unchanged since `gate_spec` | H | H | H |
| pr | Run (specs + tickets only) | Run | Run | Run |

**Rules:**
- **Auto is a fallback, not a skip.** A gate auto-passes only if the profile marks it auto, the preceding stage's check passed, and the gate's extra condition holds. Otherwise it waits for you.
- **Recorded like a human approval.** An auto-pass is stored as `approved_by: "auto"` with a `reason`. It shows in `wf status`, the gate brief and the PR body, and is sent as a telemetry event.
- **The final gate is auto only for `pm`.** That's the only case where everything to be pushed is exactly what you already approved at `gate_spec` (compare the gate's stored `spec_hash` and `tickets_hash`). Any other change sends it back to you.
- **Only you pick the profile.** You choose it at `wf run --profile <name>`, defaulting to `full`. Only you can switch it with `wf profile <name>`, and only before `gate_spec` is approved. The conductor may *propose* a profile in the `gate_spec` brief, never choose one.
- **Escalations always reach you.** Unanswerable grilling questions, loop caps and stuck loops come to you in every profile.
- **`dev` runs feasibility; `gate_approach` auto-passes only for low-risk fixes.** The architect finds the root cause and every place the fix touches, so the implementer doesn't patch one path and leave the other callers broken. It also flags when a bug is really a design change. `approach.md` gains a block the harness can parse:
  ```
  recommended: A
  public_contract_change: no
  migration: no
  new_dependency: no
  files: backend/payments/**, backend/tests/test_payments.py
  ```
  `approach_low_risk` passes when the verdict is `as-is` or `with-changes`, a recommended option is named (the harness records it as the approved approach), all three flags are `no`, and every listed file is inside the ticket scope (the stage's write paths). If any check fails, the gate waits for you, and the brief names which one failed. In `dev`, `approach.md` may list one approach plus a one-line reason (`min_approaches: 1`) instead of the usual two.
- **Skipped stages change review.** When a profile skips feasibility (`pm`, `docs`), the review's "Approach conformance" section becomes N/A. When it skips tests (`pm`, `docs`), "Test quality" becomes N/A. `checkReviewToVerify` accepts `N/A — <reason>` for both (4a.5).

**Change:** fully specified in 4a. In short:
- `profiles` in [workflow.json](.agent-workflow/workflow.json) (4a.1), stored per run (4a.2), chosen with `wf run --profile` / `wf profile` (4a.3).
- `lib/profiles.mjs` with `nextStage`, `effectiveWrites` and `autoPass` (4a.4–4a.6).
- Profile verify tiers, `pr_paths` and derived review sections (4a.5); per-profile behaviour (4a.7); visibility and telemetry (4a.8).
- A fix for every profile with tests: when tickets plan no automated scenarios **and** no test tier is configured, `done tests` records `check: "nothing_planned"` instead of failing with "the unit tier exited 0". In `full`, the gate shows that note to you; in `dev`, `gate_tests` declines auto-pass, because a bug fix needs a failing regression test.
- `goto` keeps refusing forward skips; profiles are the supported way to skip a stage.

## 4a. Profile specification

This section is the implementation contract for section 4. Where it disagrees with section 4's summary, this section wins.

### 4a.1 Profile data (`workflow.json`)

```json
"profiles": {
  "full": { "adr": true },
  "pm": {
    "skip": ["feasibility", "gate_approach", "tests", "gate_tests", "implement", "review", "gate_review", "verify"],
    "auto": { "gate_final": "specs_only_unchanged" },
    "pr_paths": ["specs/spec-<id>/**"],
    "adr": false
  },
  "dev": {
    "auto": {
      "gate_spec": "planning_clean",
      "gate_approach": "approach_low_risk",
      "gate_tests": "red_for_right_reason",
      "gate_review": "no_open_high_or_decision"
    },
    "min_approaches": 1,
    "loop_caps": { "grill": 2 },
    "min_automated_test_cases": 1,
    "adr": false
  },
  "docs": {
    "skip": ["feasibility", "gate_approach", "tests", "gate_tests"],
    "auto": { "gate_review": "no_open_high_or_decision" },
    "writes": { "implement": ["<docs_globs>"], "review": ["<docs_globs>", "<run_dir>"] },
    "verify_tiers": ["docs_lint", "links"],
    "adr": false
  }
}
```

| Key | Type | Default (`full`) | Meaning |
|---|---|---|---|
| `skip` | stage ids | `[]` | Stages and gates that never run in this profile |
| `auto` | `{ gate: condition }` | `{}` | Gates the harness may auto-pass, and which condition decides |
| `writes` | `{ stage: patterns[] }` | stage's own `writes` | Replaces (doesn't merge with) the stage's write patterns |
| `verify_tiers` | tier names | `ALL_TIERS` | Tiers `verify` runs |
| `pr_paths` | patterns | none | If set, the PR may contain only these paths |
| `min_approaches` | number | 2 | Minimum approaches `checkFeasibility` requires |
| `loop_caps` | `{ loop: n }` | `config.loop_caps` | Overrides the caps for this profile only |
| `min_automated_test_cases` | number | 0 | `checkTickets` requires at least this many `automated` test cases (the bug repro for `dev`) |
| `adr` | boolean | `true` | Whether `wf pr` requires the ADR file to be committed |

**Config ([config.json](.agent-workflow/config.json)):**
- `docs_globs: ["docs/**", "**/*.md"]`
- `commands.docs_lint`
- `commands.links`

Blank commands mean the tier is skipped. New write tokens:
- `<docs_globs>`
- `<run_dir>`, which becomes `.agent-workflow/runs/<id>/**`

**Validation (`wf doctor`, fails on any of these):**
- `planning`, `gate_spec`, `gate_final` and `pr` are in a `skip` list. No profile can skip them.
- An `auto` key isn't a gate, or is a gate that's also in `skip`.
- A condition name isn't one of the five in 4a.6.
- `gate_final` is auto with any condition other than `specs_only_unchanged`.
- `specs_only_unchanged` is used in a profile without `pr_paths`.
- A `writes` key isn't a stage, or uses an unknown token.
- A `verify_tiers` entry isn't a known tier.
- `full` has `skip` or `auto` entries.

### 4a.2 State

- `state.run.profile` (string). A missing value means `full`, so old and paused runs keep working; no schema bump.
- `state.run.profile_changes`: `[{ from, to, at }]`, shown in every brief and in the PR body.
- Skipped stage: `state.stages[id] = { status: "skipped", reason: "profile <name>" }`. Skipped gate: `state.gates[id] = { status: "skipped" }`.
- Gate approval record, the same shape for both approval routes:
  ```json
  { "status": "approved", "approved_by": "human" | "auto", "condition": "approach_low_risk", "reason": "…",
    "approved_at": "…", "approach": "A", "spec_hash": "…", "approach_hash": "…", "tickets_hash": "…" }
  ```
  `cmdApprove` sets `approved_by: "human"`, and `condition`/`reason` are omitted.
- Auto-pass declined: `state.gates[id].auto_declined = { condition, reason, at }`. The gate stays `pending`.
- `state.stages.tests.check`: `"red_ok"` or `"nothing_planned"`, saved by `done tests` so `gate_tests` doesn't re-run the tests.

### 4a.3 CLI

| Command | Behaviour |
|---|---|
| `wf run [--profile <name>] <source>` | An unknown name stops with the list of profiles. The profile is stored and printed in status. |
| `wf profile <name>` | Allowed only while the stage is `planning`, or `gate_spec` is still pending. It appends to `profile_changes`, re-marks skipped stages, and records an event. Afterwards it refuses with "profile is fixed once gate_spec is approved". It is human-only, the same way `approve` is: a slash-only skill (`/wf-profile`), listed in `human_only`. |
| `wf status` | Adds `profile: <name>`. The gate list shows `spec=approved(auto)`, `approach=skipped`, and so on. |
| `wf check [stage]` | Also prints, for the next gate, whether the profile would auto-pass it now and why or why not, without approving. |

The harness can't tell whether a slash skill was typed by you or started by the conductor; that's already true of `/wf-approve`. Two things make an unasked-for profile switch visible:
- `profile_changes` appears in every gate brief and the PR body.
- A switch to a profile with more auto gates prints a warning line in status for the rest of the run.

### 4a.4 Stage resolution

- New `nextStage(fromId, state, workflow)` in `lib/profiles.mjs`. It follows `next` and jumps over every id in the profile's `skip`, marking each one `skipped` and emitting `stage_skipped`. `cmdDone`, `cmdApprove`, the auto-pass path and `cmdResume` use it in place of `stg.next`.
- **Reject target:** the gate's `on_reject` if set and not skipped. Otherwise the nearest earlier stage that is neither skipped nor a gate. For example, `pm`'s `gate_final` rejects back to `planning`.
- **`goto`:**
  - A skipped stage counts as done when jumping forward.
  - `goto <skipped stage>` stops with "skipped by profile <name>".
  - Going back past an auto-passed gate resets it to `pending`, and that gate is human-only for the rest of the run (4a.6, rule 3).
- `rewind` never un-skips a stage.

### 4a.5 Writes, scope and verify

- New `effectiveWrites(stage, state, workflow, config)` returns `profile.writes[stage] ?? stage.writes`, with tokens expanded. It is used by:
  - `guardPreToolUse`
  - `scopeViolations` (section 2)
  - the status `writes:` line
- The frozen product-test deny in `implement`/`review` is unchanged.
- `pr_paths` (`pm`): `cmdPr` and `specs_only_unchanged` both require every changed file to match. `cmdPr` checks again at PR time, so nothing outside the specs slips in after an auto-passed `gate_final`.
- **Verify tiers:** `profile.verify_tiers ?? ALL_TIERS`. [verify.mjs](.agent-workflow/lib/verify.mjs) maps `docs_lint` → `commands.docs_lint` and `links` → `commands.links`. The e2e coverage check runs only when `e2e` is among the tiers.
- **Evidence:** `done verify` always writes `evidence/tiers.md` (each tier with ran/skipped and its exit code), so the evidence bundle is never empty. If every tier was skipped, verify still passes. The `gate_final` brief and the PR body then say "no automated checks configured for this profile".
- **Review sections:** the required sections are derived, not configured. "Approach conformance" becomes N/A when `feasibility` is skipped; "Test quality" becomes N/A when `tests` is skipped. N/A means the heading may say `N/A — <reason>`, and the check accepts that.

### 4a.6 Auto-pass conditions

**Common rules (checked before any condition):**
1. The gate is listed in `profile.auto`.
2. The stage just before the gate passed its postcondition in this same `done` call.
3. This gate has never been rejected or reset by `goto` in this run. Once you've stepped in, it stays human.
4. No escalation is pending (`state.escalations` is empty).

If any rule fails, the gate waits for you, and the reason names the rule.

| Condition | Gate · profile | Inputs | Passes when | Example reasons when declined |
|---|---|---|---|---|
| `planning_clean` | `gate_spec` · dev | `checkPlanning`, `questions.json` | No planning problems; every question answered; tickets meet `min_automated_test_cases` | "planning: 1 problem (REQ-2 missing success)", "no automated test case for the bug repro" |
| `approach_low_risk` | `gate_approach` · dev | `approach.md` decision block, `effectiveWrites('implement')`, `product_test_globs` | `checkFeasibility` passes (with `min_approaches`); verdict is `as-is` or `with-changes`; `recommended` is A, B or C and names an approach present in the file; `public_contract_change`, `migration` and `new_dependency` are all `no`; every `files` entry matches the implement write paths and none matches the product tests | "migration: yes", "files outside scope: infra/terraform/main.tf", "no decision block" |
| `red_for_right_reason` | `gate_tests` · dev | `state.stages.tests.check` | `red_ok`. If `nothing_planned`, decline: a bug fix needs a failing regression test | "no automated regression test planned" |
| `no_open_high_or_decision` | `gate_review` · dev, docs | `review.md` (existing per-line parser) | Zero open `high` and zero open `decision-needed`; review rounds under the cap | "1 open decision-needed: …" |
| `specs_only_unchanged` | `gate_final` · pm | `git diff --name-only <baseline>` plus untracked files, gate hashes | Every changed path matches `pr_paths`; `sha(SRS.md) == gate_spec.spec_hash`; `ticketsHash == gate_spec.tickets_hash` | "changed outside specs: README.md", "SRS.md changed since gate_spec" |

**`approach.md` decision block** (spec for `solution-architect` and `standards.md` "Feasibility rubric"). It goes under the `Decision` heading as plain `key: value` lines:

```
recommended: A
public_contract_change: no
migration: no
new_dependency: no
files: backend/payments/**, backend/tests/test_payments.py
```

- Keys are case-insensitive.
- Values `yes`/`no` are required for the three flags. A missing key means declined, with the key named.
- `files` is a comma list of paths or globs.
- In `full`, the block is written but only shown in the brief; it never auto-approves.
- In `dev`, when `approach_low_risk` passes, the gate's `approach` is set to `recommended`, the same field `wf approve gate_approach --approach X` sets.

**`ticketsHash` ignores `external.jira_key`**, so creating Jira issues after `gate_spec` doesn't count as a change to the approved tickets. Every other field is part of the hash.

**Execution in `cmdDone(stage)`:**
1. Run the postcondition and the scope check.
2. `g = nextStage(stage)`.
3. If `g` is a gate and `profile.auto[g]` is set, evaluate the common rules and then the condition.
4. If it passes:
   - Record the approval (4a.2).
   - Emit `approve` with `{ gate: g, by: "auto", condition }`.
   - Print `✓ <g> auto-passed: <reason>`.
   - Continue to `nextStage(g)` and set `next_action` for that stage.
   - Two gates are never adjacent, so this goes at most one step.
5. If it doesn't pass:
   - Set the stage to `g` and record `auto_declined`.
   - `next_action` = the gate's human text plus "Auto-pass not applied: <reason>".

### 4a.7 Per-profile behaviour

**`full`:** unchanged; all six gates are human. The decision block is written, for information only.

**`pm`** (tickets only, maybe pushed to Jira):
- Planning runs in full.
- After you approve `gate_spec`, `nextStage` skips straight to `gate_final`, which auto-passes under `specs_only_unchanged`. The run then lands in `pr`.
- The `wf-pr` skill in `pm` does three things, in order:
  1. Ask whether to run `/wf-jira-tickets`; that stays human-only, and creates nothing on a no.
  2. Commit only `specs/spec-<id>/**`.
  3. Write `pr-summary.md` from the SRS and tickets, then run `wf pr`. The PR title is prefixed `[tickets]`.
- `wf pr` checks `pr_paths` again, and doesn't require an ADR.

**`dev`** (alpha bug, internal finding):
- The planning skill reads the profile. It runs at most two grill rounds; the ticket writer may produce one ticket for any persona; at least one `automated` test case is required, which is the bug repro.
- `gate_spec`, `gate_approach`, `gate_tests` and `gate_review` auto-pass under their conditions. `gate_final` is always human.
- The ADR isn't required. If an approach exists, the PR body still includes its two-line decision summary.

**`docs`:**
- `implement`/`review` write `<docs_globs>`; the implementer and reviewer prompts get the profile.
- Verify runs `docs_lint` and `links`.
- Review requires "Standards" and "Spec conformance"; the other two sections are N/A.
- `gate_review` auto-passes under its condition. `gate_spec` and `gate_final` are human. No ADR.

### 4a.8 Visibility and telemetry

- **Brief:** `wf brief <gate>` shows the profile and `profile_changes`. For a gate the profile can auto-pass, it shows whether it would pass and why.
- **PR body:** a new `## Gates` table (gate · approved by · condition/reason · time), where a skipped gate shows `skipped (profile)`. Any `profile_changes` are listed.
- **Telemetry ([capture.mjs](.agent-workflow/lib/telemetry/capture.mjs)):**
  - `run_started` gains the `profile` attribute.
  - `gate_approved` gains `by` (`human`/`auto`) and `condition`.
  - New event `stage_skipped` with `{ stage }`.
  - New event `gate_auto_declined` with `{ gate, condition }`. The reason text is not sent, because it can name file paths.
  - Add all of these to `ALLOWED`, and the server's `EVENT_TYPES`.
  - Migration `003_profiles.sql` adds a view `gate_decisions(run_id, gate, by, condition, ts)`.

### 4a.9 Tests

- **`profiles.test.mjs`** (new):
  - `nextStage` for each profile
  - reject targets (`pm` `gate_final` → `planning`)
  - `goto` onto a skipped stage refused
  - going back past an auto gate makes it human
  - `wf profile` refused after `gate_spec`
  - a doctor failure for each validation rule in 4a.1
- **Auto-pass conditions:** for each of the five, one case that passes and one case per decline reason in 4a.6. Also cover each common rule:
  - a gate once rejected stays human
  - a pending escalation blocks auto-pass
- **`ticketsHash`:** stays the same when only `jira_key` changes, and changes when anything else does.
- **End-to-end** with `withRun`, one per profile:
  - `pm`: planning → `gate_spec` (human) → `pr`, with a PR body of specs only
  - `dev`: one human stop at `gate_final`
  - `dev` with `migration: yes`: stops at `gate_approach`
  - `docs`: implement writes `docs/x.md`, verify passes with the docs tiers blank, and the "no automated checks" note appears
  - `full`: unchanged
- **Telemetry:** `by`/`condition` on `gate_approved`; `stage_skipped` emitted once per skipped stage; reason text never sent.

## 5. Sub-agents write their own artifacts

**Cause:** read-only agents return chat text that the conductor transcribes, which drifts. Under Claude Code, `readonly: true` is ignored anyway.

**Change:**
- Agents that produce an artifact write it themselves, to one fixed path. The skill names the path, and the guard and the diff check from section 2 keep it within the stage's allowed paths.

  | Agent | Writes |
  |---|---|
  | requirements-ingestor | `specs/spec-<id>/draft-requirements.md` |
  | srs-writer | `specs/spec-<id>/SRS.md` |
  | ticket-writer, acceptance-test-writer | `specs/spec-<id>/tickets/**` |
  | product-researcher | `specs/spec-<id>/research.md` |
  | solution-architect | `specs/spec-<id>/approach.md` |
  | code-reviewer | `.agent-workflow/runs/<id>/review.md` |
- `requirements-griller` and `requirements-synthesizer` stay read-only. They return short JSON, and the conductor merges it into `grill/questions.json`, since that file is the escalation record the conductor owns.
- After a sub-agent returns, the skill runs `wf check` on its artifact. A failure goes back to the *same* agent with the problem list, at most two retries, then `/wf-unblock`. The conductor never hand-edits an agent's artifact; [AGENTS.md](AGENTS.md) and the skills say so.
- The "write verbatim" lines are removed from the skills, since nothing is transcribed now.
- Installer, Claude Code harness: translate the agent frontmatter.
  - `readonly: true` becomes a read-only tool list.
  - Writer agents get `Write`/`Edit`, but no `Bash`, so they can't write through the shell; the diff check covers anything else.
  - MCP tools stay allowed for the ingestor and synthesizer.
  - Spike first: confirm Claude Code's agent frontmatter fields (`tools`, any deny-list field) and how MCP tools are named in it.
- `code-reviewer` stays independent: it writes `review.md` but no source. Its tools exclude edits outside `<run_dir>`, enforced by the stage's allowed paths. The implementer fixes findings, as today.

## 6. Gaps from the previous plan

- Claude Code telemetry: pass `subagentId` through `cmdLog` and match start and stop by `agent_id` when it is present, falling back to type and arrival order. Add the Claude Code tests (sequential, parallel of the same type, stop with no start).
- Server: tests that `human_escalations` and `agent_run` are accepted and that `agent_timings` / `run_human_escalations` return rows; run `npm run test:server`.
- Leftovers:
  - README line 121 still mentions `test-plan.md`; change it to ticket test cases.
  - Fix the `pr.mjs` header comment.
  - Remove the empty `.cursor/skills/wf-test-plan/`.
- Run the previous plan's Verification steps 3 and 4.
- Commits: split the large uncommitted working tree into reviewable commits, one per chunk of the previous plan where possible, when you ask for it.

## Implementation ToDo (in order, each one a reviewable chunk)

Each chunk ends with `npm test` and `wf doctor` green.

1. **Leftovers and commits.** Do the README / `pr.mjs` / empty-folder cleanup, then commit the existing working tree in logical commits (needs your go-ahead). This gives the rest a clean baseline.
2. **Skill invocation split.** Add `human_only`/`conductor` in capabilities.json, update the skill flags and descriptions, the doctor rule, `NEXT_ACTION` and the conductor rules. Test: doctor fails on a wrong flag.
3. **Validator problem shape.** Add the `problem()` helper; every postcondition returns a list; `cmdDone` prints all problems. Add `wf check [stage]`. Update the tests to assert the rule names.
4. **Validator fixes.** The `capabilityBlock` definition match, relaxed headings, line-range source paths, the approach heading and review `open: 0`. Add a regression test for each reported case.
5. **Diff scope check.** Add `scopeViolations`, call it from `cmdDone` and `guardStop`, add the `<run_dir>` token and the status text. Test: a Bash-written `docs/x.md` in `implement` fails `done implement` with the file named.
6. **Run profiles (core), per 4a.1–4a.5.**
   - `profiles` in workflow.json; `docs_globs` and the two commands in config; doctor validation.
   - `state.run.profile` and `profile_changes`; `wf run --profile`; `wf profile` with `/wf-profile` (human-only).
   - `nextStage` with skip marking; reject targets; `goto` rules; `effectiveWrites`.
   - `pr_paths`; profile verify tiers with `evidence/tiers.md`; derived N/A review sections; `adr`, `min_approaches`, `loop_caps` and `min_automated_test_cases`.
   - Tests: `profiles.test.mjs`.
7. **Auto-pass gates, per 4a.6–4a.9.**
   - The common rules and the five conditions; the `approach.md` decision block (and `standards.md`); `ticketsHash` ignoring `jira_key`.
   - The `cmdDone` auto-pass path; `auto_declined`; `wf check` previewing the next gate.
   - The `pm` flow in `wf-pr`; the `## Gates` table in the PR body.
   - Telemetry fields and events; migration `003_profiles.sql`.
   - Tests: 4a.9 auto-pass, hash, end-to-end and telemetry cases.
8. **Spike: Claude Code agent frontmatter.** Confirm the tool-list and deny fields and MCP tool naming. Write the result into `docs/adapter-contract.md`. *No code.*
9. **Agents write their artifacts.** Update the agent `.md` files and skills with fixed paths; `wf check` after each agent with at most two retries; remove the "verbatim" rules; add the AGENTS.md rule against hand-editing.
10. **Installer frontmatter translation.** For Claude Code, map `readonly` and writer agents to tool lists (per chunk 8). Installer test: a translated agent has no `Write` or `Bash` when read-only.
11. **Telemetry and server gaps.** Claude Code pairing by `agent_id` with tests; server tests for the new types and views; `npm run test:server`.
12. **End-to-end verification and docs.**
    - Update `USER_GUIDE.md`: the profiles × stages table, the auto-pass rules, conductor-run stages, `wf check` and `/wf-profile`.
    - Update the README stage and command tables, and the AGENTS.md / CLAUDE.md conductor rules (profiles, auto-passed gates, never hand-edit artifacts).
    - Re-run the docs task with `--profile docs`, a small `full` task on `examples/sample-app`, a `pm` task and a `dev` bug, as in Verification.

## Verification

1. `npm test`, `npm run test:server` and `wf doctor` all pass.
2. Re-run the handover-docs task under Claude Code with `/wf-run --profile docs …`. Expect:
   - you type only at gates
   - `tests` / `gate_tests` are skipped and shown as such
   - `implement` writes `docs/**`
   - a write to `backend/` through Bash fails `done implement` with the file named
   - no artifact is hand-edited by the conductor
   - `gate_review` auto-passes (or says why it didn't)
3. Re-run a small code task on `examples/sample-app` with the `full` profile. Planning through PR should work with failing-first Playwright tests, and every validator failure along the way should print its rule and an example.
4. Run a `pm` task (tickets only) and a `dev` task (one alpha bug). Expect:
   - `pm`: you're asked only at `gate_spec` and for the Jira yes; the PR has only `specs/**`
   - `dev`: you're asked only at `gate_final` for a low-risk fix, and also at `gate_approach` when the architect flags a contract change, migration or new dependency; every auto-passed gate lists its reason in the PR body
5. After `wf sync`, `agent_timings` has one row per dispatch, with Claude Code rows matched by `agent_id`. `run_human_escalations` shows the count.

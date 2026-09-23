# Cursor Setup Plan — Spec-Driven Agentic Coding Workflow

This is an implementation plan, not a narrative doc. Each phase produces
specific files at specific paths. Work through it in order — later phases
assume earlier ones exist. Every file format below (skills, subagents,
hooks, rules, MCP) is Cursor's current documented format, not carried over
from another tool.

## 0. Prerequisites

- Cursor 2.4+ (subagents require it).
- Node.js 20.12+, `uv` (BMAD's Python-backed skills need it), Git.
- A repo with at least one commit, so `git diff`/baseline comparisons work.
- Playwright installed if the project has a UI: `npx playwright install`.
- Decide your Jira access path now: Atlassian MCP server, or paste-in
  ticket text. Phase 6 assumes MCP; skip that block if you're pasting text.

## 1. Final Directory Layout

```
<repo-root>/
├── AGENTS.md                        # Phase 2 — always-loaded, short
├── .cursor/
│   ├── mcp.json                     # Phase 6
│   ├── hooks.json                   # Phase 5
│   ├── skills/
│   │   ├── wf-run/SKILL.md
│   │   ├── wf-start/SKILL.md
│   │   ├── wf-feasibility/SKILL.md
│   │   ├── wf-test-plan/SKILL.md
│   │   ├── wf-tests/SKILL.md
│   │   ├── wf-implement/SKILL.md
│   │   ├── wf-review/SKILL.md
│   │   ├── wf-verify/SKILL.md
│   │   ├── wf-pr/SKILL.md
│   │   ├── wf-approve-spec/SKILL.md
│   │   ├── wf-approve-manual/SKILL.md
│   │   ├── wf-abort/SKILL.md
│   │   ├── wf-pause/SKILL.md
│   │   ├── wf-resume/SKILL.md
│   │   └── bmad-*/                  # installed + pruned in Phase 0
│   ├── agents/
│   │   ├── feasibility-analyst.md
│   │   ├── test-architect.md
│   │   ├── implementer.md
│   │   └── verifier.md
│   └── hooks/
│       ├── guard.mjs                # one script, dispatches by hook event
│       └── format-payload.mjs       # optional: shared payload parsing
├── .agent-workflow/
│   ├── workflow.json                # Phase 1 — static stage definitions
│   ├── state.json                   # Phase 1 — live status (gitignored)
│   ├── events.jsonl                 # Phase 1 — audit log (gitignored)
│   ├── config.json                  # Phase 1 — stack commands, thresholds
│   ├── standards.md                 # Phase 1 — edge-case + technical checklists
│   ├── bmad-allowlist.json          # Phase 0
│   ├── wf.mjs                       # Phase 1 — the state machine CLI
│   └── runs/<run-id>/               # archived/paused runs, evidence bundles
├── _bmad/                           # BMAD config + scripts (from installer)
└── specs/spec-<run-id>/
    ├── SPEC.md                      # written by bmad-spec, committed
    ├── approach.md                  # written by wf-feasibility, committed
    └── test-plan.md                 # written by wf-test-plan, committed
```

`.gitignore` additions: `.agent-workflow/state.json`, `.agent-workflow/events.jsonl`,
`.agent-workflow/runs/`.

## 2. Context Budget Rules — read this before writing any skill or agent

Cursor loads an entire skill's body into context the moment it activates,
and recommends keeping a `SKILL.md` under roughly 500 lines, pushing
detail into files that load only on demand. `AGENTS.md` is applied to
every conversation regardless of any relevance setting, so it is the
most expensive file in the whole setup per token — keep it under ~40
lines. A `.mdc` rule with `alwaysApply: true` has the same always-on
cost; use `globs` instead wherever a rule only matters for certain files.

Apply these rules to everything you write in this plan:

1. **AGENTS.md carries only the pointer, never the process.** It says a
   workflow exists, how to check its status, and the one rule about not
   free-lancing mid-run. The stage instructions live in skills, loaded
   only when that stage runs.
2. **Each `wf-*` skill's `SKILL.md` is a short driver**: what this stage
   does, what it reads, what it writes, what it hands to `wf.mjs` to
   verify. Long checklists (edge cases, technical test categories, the
   review rubric) live once in `standards.md` or a skill's own
   `references/` file, and the driver says "read `references/x.md`"
   rather than inlining it.
3. **Subagents, not the main thread, do the reading.** Codebase
   exploration, full diffs, and verbose tool output belong inside
   `feasibility-analyst`, `test-architect`, `implementer`, and
   `verifier` — each with its own context window. Their prompts end
   with an explicit instruction to return a short summary plus file
   paths, not their full working output, since a subagent's detailed
   result still consumes the parent's context when it reports back.
4. **`disable-model-invocation: true` on every `wf-*` skill.** These
   are a deterministic pipeline driven by `wf.mjs`, not suggestions
   for the model to reach for on its own. Without this flag Cursor's
   agent may decide a skill is "relevant" and invoke it unprompted.
5. **One state file, read small.** The main thread reads `state.json`
   through `wf status` (a short text summary), never the raw JSON,
   except when a hook needs the full object.

## 3. Phase 0 — Install and Prune BMAD

```bash
npx bmad-method install --yes --modules bmm --tools cursor
```

This writes BMAD's skills into `.agents/skills/` per BMAD's own
convention, but Cursor also reads `.claude/skills/` and `.cursor/skills/`
for the same purpose — check where the installer actually put them for
the `cursor` target and adjust the prune script's search path below
before running it. `uv` is required by some BMAD skills; a missing `uv`
only warns, it doesn't fail the install.

Create `.agent-workflow/bmad-allowlist.json`:

```json
{
  "keep": [
    "bmad-project-context",
    "bmad-spec",
    "bmad-review",
    "bmad-code-review",
    "bmad-advanced-elicitation",
    "bmad-testarch-test-design",
    "bmad-testarch-atdd",
    "bmad-testarch-test-review",
    "bmad-testarch-trace",
    "bmad-testarch-nfr",
    "bmad-testarch-framework",
    "bmad-deep-recon",
    "bmad-walkthrough"
  ]
}
```

Add a `prune` command to `wf.mjs` (Phase 1) that deletes every
`bmad-*` skill directory not in this list, across whichever skills
directory the installer used. Run it once now, and again after every
`bmad-method` update — the installer doesn't delete stale directories
on its own, and every unused skill description still costs tokens once
loaded into the picker.

Do this once, by hand, before pruning: dry-run each kept BMAD skill
(`bmad-spec`, `bmad-code-review`, at minimum) to see whether it prompts
interactively mid-run. `bmad-code-review` is documented to confirm its
target and target spec with you before launching reviewers — your
`wf-review` skill (Phase 3) must supply that up front so it doesn't
stall waiting for a response nobody sends.

Verify: open `.cursor/skills/` (or wherever it landed) and confirm only
the allowlisted `bmad-*` directories remain, plus your own `wf-*` ones.

## 4. Phase 1 — Scaffold the State Machine

### `workflow.json` (static, committed)

This is the source of truth for stage order, who executes each stage,
and what each stage is allowed to touch. `wf.mjs` reads it; hooks read
it to authorize or deny actions; nothing else needs to duplicate it.

```json
{
  "schema": 1,
  "stages": [
    { "id": "grill_spec",  "executor": "main",
      "writes": ["specs/**"], "next": "feasibility" },
    { "id": "feasibility", "executor": "agent:feasibility-analyst",
      "writes": ["specs/**"], "next": "test_plan" },
    { "id": "test_plan",   "executor": "agent:test-architect",
      "writes": ["specs/**"], "next": "gate1" },
    { "id": "gate1",       "executor": "human",
      "writes": [], "next": "tests" },
    { "id": "tests",       "executor": "agent:test-architect",
      "writes": ["<test_globs>"], "next": "implement" },
    { "id": "implement",   "executor": "agent:implementer",
      "writes": ["src/**", "!<test_globs>"], "max_attempts": 5,
      "next": "review" },
    { "id": "review",      "executor": "main+bmad-code-review",
      "writes": ["src/**", "!<test_globs>"], "max_rounds": 3,
      "next": "verify" },
    { "id": "verify",      "executor": "agent:verifier",
      "writes": [], "max_fix_rounds": 2, "next": "gate2" },
    { "id": "gate2",       "executor": "human",
      "writes": [], "next": "pr" },
    { "id": "pr",          "executor": "main",
      "writes": [], "next": "done" }
  ],
  "guarded_shell_patterns": [
    "^git\\s+commit", "^git\\s+push", "^gh\\s+pr\\s+create"
  ],
  "protected_files": [".agent-workflow/state.json", ".agent-workflow/workflow.json"]
}
```

`<test_globs>` is resolved from `config.json` (below) at guard time, so
this file stays stack-independent.

### `config.json` (per-repo, committed)

Written once by a `wf-init` pass (fold this into `wf-run`'s first call
rather than a separate skill — it's one-time setup, not a pipeline
stage). It inspects the repo and proposes values; you confirm them.

```json
{
  "test_globs": ["tests/**", "**/*.spec.*", "**/*.test.*"],
  "commands": {
    "unit": "npm test", "lint": "npm run lint",
    "complexity": "npx eslint . --rule complexity",
    "e2e": "npx playwright test", "a11y": "npm run test:a11y"
  },
  "surfaces": ["ui", "api"],
  "dev_url": "http://localhost:3000",
  "loop_caps": { "implement": 5, "review": 3, "verify_fix": 2 }
}
```

### `state.json` (live, gitignored)

Created by `wf run <source>`, updated only by `wf.mjs`, never edited
directly by an agent or a person. See the earlier design for its shape
— `run`, `current`, `gates`, `stages`, `loops`, `escalations`,
`deferred`. Keep the frontmatter-style top fields (`current.stage`,
`current.next_action`, `gates.*.status`) short enough that `wf status`
prints in under 10 lines; that printed summary, not the file, is what
the main thread reads.

### `wf.mjs` command surface

Build these commands; each is deterministic code, not model reasoning:

| Command | Effect |
|---|---|
| `wf run <source>` | Creates a run id, `state.json`, calls `wf-start`. |
| `wf status` | Prints the short summary (see Phase 5's `sessionStart` hook). |
| `wf status --check` | Non-zero exit if a stage is stalled or a loop cap is hit. |
| `wf done <stage> --result <path>` | Re-verifies the stage's own postcondition (see the transition-guard table below), then advances `current.stage` and appends to `events.jsonl`. Refuses if the postcondition fails. |
| `wf approve gate1 --approach <A\|B\|C>` | Only callable from `wf-approve-spec`; records approach + hashes of SPEC.md/approach.md/test-plan.md. |
| `wf approve gate2` | Only callable from `wf-approve-manual`. |
| `wf verify` | Runs the commands from `config.json` for the current stage's required tiers; used by both the agent and the `implement`/`verify` stages to get a real pass/fail, not a self-report. |
| `wf guard <hook-event>` | Reads the hook's JSON payload from stdin, checks it against `workflow.json`, writes exit code 0/2 per the Cursor hook protocol. |
| `wf prune` | Deletes non-allowlisted `bmad-*` skill directories. |
| `wf abort [--force]` | See Phase 8. |
| `wf pause` / `wf resume` | Archives/restores `state.json` under `runs/<id>/`. |

Postconditions for `wf done`, one per transition (from the earlier
design — implement these as functions, not prose the agent has to
remember):

| Transition | Checked by `wf.mjs`, not the agent's word |
|---|---|
| grill_spec → feasibility | `SPEC.md` has numbered `REQ-n` IDs and a success condition per capability; no `[OPEN QUESTION]` markers left |
| feasibility → test_plan | `approach.md` has a verdict, ≥2 approaches, and a single-commit-fit line |
| test_plan → gate1 | every `REQ-n` in SPEC.md has ≥1 scenario in `test-plan.md`; every scenario has a layer and automated/manual/N/A tag |
| tests → implement | `wf verify` shows the new tests failing, and the failure names cite the right `REQ`/`TECH` ids (not an unrelated crash) |
| implement → review | `wf verify` (unit+integration) exits 0 |
| review → verify | no findings tagged `high`/`decision-needed` remain open in the review output |
| verify → gate2 | `wf verify` (all tiers) exits 0 and the evidence bundle file exists |
| pr → done | exactly one commit since `state.json`'s recorded baseline SHA |

### `standards.md`

One file, sectioned: edge-case checklist (validation, errors,
concurrency, idempotency, auth, backward compatibility, migrations,
observability), the technical scenario checklist (UI states, contrast
states to scan, API contract, data, robustness, runtime health,
non-functional, regression), and the review rubric axes (standards,
spec conformance, approach conformance, test quality). Skills reference
sections of this file by heading rather than duplicating them.

## 5. Phase 2 — `AGENTS.md`

Cursor applies this file to every conversation and merges nested
`AGENTS.md` files with the parent, so keep it minimal:

```markdown
# Agent instructions

This repo runs a spec-driven build workflow. Before doing anything else
in a task-shaped request, run: `node .agent-workflow/wf.mjs status`

- If a run is **active**, follow its `next_action` exactly. Don't skip
  stages, edit `.agent-workflow/state.json` directly, or run git
  commit/push/gh pr create before Gate 2 is recorded — these are
  enforced by hooks and will be blocked.
- If **no run is active** and the request is a new feature or bug fix,
  start one: `/wf-run <ticket-id-or-description>`.
- Trivial edits (typo, one-line fix) you're willing to review yourself
  don't need the workflow — just make the change.
```

That's the entire file. Everything else lives in skills, loaded only
when relevant.

## 6. Phase 3 — Skills (`.cursor/skills/wf-*/SKILL.md`)

Frontmatter fields Cursor supports for skills: `name` (must match the
folder), `description`, `paths` (glob-based auto-attach — not used
here, since these are pipeline stages, not file-type domain skills),
`disable-model-invocation`, `metadata`. Every skill below sets
`disable-model-invocation: true` per the rule in Phase 2 (§4).

Template for every `wf-*` skill:

```markdown
---
name: wf-<stage>
description: "Pipeline stage: <one line>. Invoked only by wf-run or the human; not for the model to select on its own."
disable-model-invocation: true
---

## Required reading before acting
- .agent-workflow/config.json
- specs/spec-<run-id>/SPEC.md            (if it exists)
- .agent-workflow/standards.md#<relevant-section>

## What this stage does
<3-6 sentences>

## Inputs
<files/state fields this stage reads>

## Outputs
<exact file(s) this stage writes, and nothing else>

## On finish
Call: node .agent-workflow/wf.mjs done <stage> --result <path>
Do not advance the stage yourself — wf.mjs verifies the postcondition.
```

Per-skill specifics to fill in (keep each `SKILL.md` under ~150 lines;
push anything longer into `references/<topic>.md` inside that skill's
folder):

- **wf-run** — the entry point. Not `disable-model-invocation` for the
  *user* (they type `/wf-run`), but the model shouldn't self-invoke it
  either, so keep the flag. Body: read `wf status`; if no run active,
  parse the invocation (Jira key via MCP, a pasted ticket, or free
  text) and hand off to `wf-start`; if a run is active, print the
  status and stop — don't start a second run.
- **wf-start** — runs the grill. One question at a time, exploring the
  codebase before asking. Reads `standards.md#edge-case-checklist`.
  Writes `specs/spec-<id>/SPEC.md` (via `bmad-spec` — call that skill,
  don't reimplement its contract format). Calls `wf done grill_spec`.
- **wf-feasibility** — thin dispatcher. Its whole job is: gather the
  Jira/ticket context if any, then hand off to the `feasibility-analyst`
  subagent (Phase 4) with the SPEC.md path, and write its returned
  analysis into `approach.md`. Keep this skill itself tiny — the heavy
  reading happens in the subagent's own context, not here.
- **wf-test-plan** — dispatches to `test-architect` in plan mode
  (titles only, both tiers, `REQ-n`→`PRD-n.m` and `TECH-*` ids). Uses
  `bmad-testarch-test-design` internally, per Stage 3's earlier design.
- **wf-tests** — dispatches to `test-architect` in ATDD mode
  (`bmad-testarch-atdd`) to write the actual failing tests, confirms
  red for the right reason via `wf verify`, then calls `wf done tests`
  which registers the freeze hash used by the Phase 5 guard.
- **wf-implement** — dispatches to `implementer`. Loop is bounded by
  `config.json`'s `loop_caps.implement`; the *skill* doesn't loop
  itself — the `stop` hook (Phase 5) re-submits the implementer up to
  the cap, so this skill's body is one attempt, not a manual `while`.
- **wf-review** — runs `bmad-code-review` from the **main thread**
  (not from inside a subagent — `bmad-code-review` spawns its own
  reviewers, and Cursor subagents can't nest further subagents), with
  target and spec context supplied up front so it never has to ask.
  Also calls `bmad-testarch-test-review`. Findings tagged
  `decision-needed` go into the Gate 2 report, not back to you now.
- **wf-verify** — dispatches to `verifier` (Phase 4), which owns the
  Playwright MCP calls. Runs `wf verify` for suites first, then the
  subagent's exploratory pass, then assembles the evidence bundle
  under `.agent-workflow/runs/<id>/evidence/`.
- **wf-pr** — your custom PR instructions (content to be supplied
  separately). Only reachable after `gate2` is `approved` — the Phase
  5 shell-command guard enforces this independently of the skill body.
- **wf-approve-spec**, **wf-approve-manual** — thin: call
  `wf approve gate1 --approach <X>` / `wf approve gate2`. These are the
  only two skills a person, not the model, ever runs deliberately at a
  decision point — keep them to a few lines each.
- **wf-abort**, **wf-pause**, **wf-resume** — call the matching
  `wf.mjs` command; `wf-abort` additionally asks (per Phase 8) what to
  do with the working tree before calling `wf abort`.

## 7. Phase 4 — Subagents (`.cursor/agents/*.md`)

File format: YAML frontmatter (`name`, `description`, and optionally
`tools`/`model` for scoped access) followed by the system prompt in
Markdown. Cursor also reads `.claude/agents/` for the same files if you
want Claude Code to share them — `.cursor/agents/` takes precedence on
a name conflict. Each prompt below opens with its own "required
reading" list so the subagent's *own* context stays scoped — it does
not inherit skills from the parent conversation, so anything it needs
must be named explicitly.

```markdown
---
name: feasibility-analyst
description: Read-only codebase and architecture analysis for a drafted spec. Use only via wf-feasibility.
tools: read, grep, glob
---

Required reading: specs/spec-<id>/SPEC.md, AGENTS.md, standards.md
(feasibility rubric section).

You are read-only. Investigate whether the codebase and architecture
can satisfy the spec's capabilities. Produce, in your final message
only (the parent does not see your intermediate exploration):

1. Verdict: as-is / with-changes / not-satisfiable
2. Current-state map — file references only, no code paste
3. Limitations — coupling, data model, concurrency, auth, API/back-compat,
   migrations, dependencies, test infra
4. 2-3 approaches with trade-offs, blast radius, and a recommendation
5. Whether this fits one commit, or a proposed split
6. Spec gaps found (send back to grill if any)

Every codebase claim needs a file:line reference or an explicit
[ASSUMPTION] tag. Keep the final message under ~2 pages — it becomes
approach.md verbatim.
```

```markdown
---
name: test-architect
description: Writes the two-tier test plan (product + technical) and, on request, the ATDD failing tests. Use only via wf-test-plan / wf-tests.
tools: read, write, edit, grep, glob, terminal
---

Required reading: specs/spec-<id>/SPEC.md, approach.md,
standards.md (technical checklist), config.json (test_globs, surfaces).

Mode is passed in your task: "plan" (titles only, no code, both tiers,
REQ-n -> PRD-n.m and TECH-* ids) or "atdd" (write the actual failing
tests named with their scenario ids). In atdd mode, run the project's
test command yourself to confirm red-for-the-right-reason before
returning. Do not touch any file outside config.json's test_globs.
```

```markdown
---
name: implementer
description: Makes the frozen tests pass, per the approved approach. Use only via wf-implement.
tools: read, write, edit, grep, glob, terminal
---

Required reading: specs/spec-<id>/SPEC.md, approach.md (approved
option only), standards.md (coding rules section).

Implement per the approved approach only. Run
`node .agent-workflow/wf.mjs verify` yourself before reporting done —
do not report success from your own read of the output; the exit code
is the source of truth. If a change would go outside the approved
approach's blast radius or alter a public contract, stop and report
that instead of improvising. Log anything out-of-scope you notice into
.agent-workflow/runs/<id>/deferred.md instead of fixing it now. Do not
edit files under the frozen test globs.
```

```markdown
---
name: verifier
description: Runs the exploratory browser/API pass and assembles the Gate 2 evidence bundle. Use only via wf-verify.
tools: read, grep, glob, terminal, mcp__playwright
mcpServers:
  playwright:
    command: npx
    args: ["-y", "@playwright/mcp@<pinned-version>"]
---

Required reading: specs/spec-<id>/test-plan.md (technical tier),
config.json (dev_url, surfaces, a11y states to scan).

Walk the product flows named in test-plan.md at config.json's dev_url.
For each UI surface, trigger hover/focus/dark states before any
contrast check — a scan taken in the default state misses state-only
failures. Capture console errors and failed network requests during
each flow; treat a real one as a bug, not a note, and send it back
through wf-implement with a regression-test requirement rather than
fixing it yourself. Write screenshots and a short pass/fail table per
tier to .agent-workflow/runs/<id>/evidence/.
```

Pin the Playwright MCP version explicitly — an unpinned minor release
has been reported to multiply token usage. Defining the server inline
on this one subagent, rather than in the shared `.cursor/mcp.json`,
keeps its tool descriptions out of every other agent's context.

## 8. Phase 5 — Hooks (`.cursor/hooks.json`)

Schema: `{"version": 1, "hooks": {"<event>": [{...}]}}`. Hook fields:
`command`, `type` (`"command"` default, or `"prompt"`), `timeout`,
`matcher`, `failClosed` (default `false` — fails open on error/timeout
unless set), `loop_limit`. Exit code `0` = success, `2` = block/deny,
anything else fails open unless `failClosed: true`. All the gates
below set `failClosed: true` — a crashing guard script must not
silently let a blocked action through.

```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [
      { "command": "node .agent-workflow/wf.mjs status --hook", "timeout": 5 }
    ],
    "preToolUse": [
      { "command": "node .agent-workflow/wf.mjs guard preToolUse",
        "matcher": "Write|MultiEdit|Edit", "failClosed": true, "timeout": 10 }
    ],
    "beforeShellExecution": [
      { "command": "node .agent-workflow/wf.mjs guard beforeShellExecution",
        "failClosed": true, "timeout": 10 }
    ],
    "afterFileEdit": [
      { "command": "node .agent-workflow/wf.mjs log afterFileEdit", "timeout": 5 }
    ],
    "stop": [
      { "command": "node .agent-workflow/wf.mjs guard stop",
        "loop_limit": 5, "timeout": 10 }
    ]
  }
}
```

What each does, and why it's designed this way:

- **`sessionStart`** — prints the same short status block described in
  the earlier design (run id, stage, attempt, gate status, next
  action) so a fresh chat or a post-compaction session re-aligns
  without re-reading the whole state file. `--hook` mode outputs
  plain text sized to inject as context, not raw JSON.
- **`preToolUse`** on `Write|MultiEdit|Edit` — the exact tool-name
  matcher can vary by Cursor version, so `wf.mjs guard` doesn't trust
  the matcher alone: it re-reads `tool_name`/`file_path` from the JSON
  payload on stdin and checks it against `workflow.json`'s `writes`
  glob for the current stage and against `protected_files` and the
  frozen test-glob list. This is the mechanism behind the whole
  "writes allowed: src/\*\* / blocked: tests/\*\* (frozen)" line from
  the status block.
- **`beforeShellExecution`** — matches the current shell command
  against `workflow.json`'s `guarded_shell_patterns` (`git commit`,
  `git push`, `gh pr create`). Denies unless `state.json.gates.gate2.status
  == "approved"`. This is what makes Gate 2 a real barrier rather than
  a convention the agent is trusted to honor.
- **`afterFileEdit`** — appends one line to `events.jsonl`; not a
  gate, just the audit trail.
- **`stop`** — this is what turns "implementer loops until tests pass"
  from a manual `while` loop inside a skill into a real bounded loop:
  if `current.stage == "implement"` and `wf verify` still fails and
  `loops.implement.round < max`, the guard script exits in a way that
  re-submits the implementer (Cursor's stop hook can auto-continue a
  session, capped by `loop_limit`); once the cap or a plateau
  (identical failing-test set two rounds running) is hit, it instead
  writes a CRITICAL escalation into `state.json.escalations` and lets
  the turn end normally so you see it.

Two things worth testing before you trust this: confirm the exact
`tool_name` values Cursor sends for edit-type tools in your installed
version (log one payload from `preToolUse` and read it), and confirm
`failClosed: true` actually blocks on a deliberately-broken guard
script — don't assume it from the docs alone.

## 9. Phase 6 — MCP Servers (`.cursor/mcp.json`)

Project-level config, committed:

```json
{
  "mcpServers": {
    "atlassian": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-atlassian"],
      "env": { "ATLASSIAN_API_TOKEN": "${env:ATLASSIAN_API_TOKEN}" }
    }
  }
}
```

Confirm the actual Atlassian MCP package name and env vars against
whatever your organization already uses — the entry above is a
placeholder shape, not a verified package. Playwright is deliberately
**not** here; it's scoped inline to the `verifier` subagent (Phase 4)
so its tool descriptions don't sit in every other agent's context.

## 10. Phase 7 — PR Skill

`wf-pr/SKILL.md` is a placeholder until your instructions arrive:

```markdown
---
name: wf-pr
description: "Pipeline stage: creates the single-commit PR. Invoked only after gate2 is approved."
disable-model-invocation: true
---

## Required reading before acting
- .agent-workflow/workflow.json (protected_files, guarded_shell_patterns)
- <your PR instructions file, once supplied>

## Precondition
state.json.gates.gate2.status == "approved". The beforeShellExecution
hook enforces this independently — this check is a fast-fail, not the
only guard.

## On finish
node .agent-workflow/wf.mjs done pr --result <commit-sha>
```

## 11. Phase 8 — Dry Run Checklist

Run these before trusting the setup on a real ticket:

1. `wf status` with no active run — should say so cleanly, not error.
2. Start a run on a throwaway, low-stakes ticket. Confirm `wf-start`
   actually stops to ask you questions rather than guessing.
3. At `implement`, manually try to edit a frozen test file — confirm
   the `preToolUse` hook blocks it, and read the denial message it
   returns for clarity.
4. At `implement`, manually run `git commit` — confirm
   `beforeShellExecution` blocks it before Gate 2.
5. Force a failing test on purpose and confirm the `stop` hook
   actually re-submits the implementer, and that it stops re-submitting
   at the configured cap instead of looping forever.
6. Run `bmad-code-review` once standalone (outside the pipeline) to see
   whether it prompts for anything the `wf-review` skill doesn't
   already supply.
7. Confirm `SPEC.md`, `approach.md`, `test-plan.md`, and the test files
   are not gitignored and do land in the final PR commit.
8. Kill Cursor mid-`implement` and reopen — confirm `sessionStart`
   reprints the correct stage and `next_action`.

## 12. Ending the Workflow Manually

Same commands as the state-machine design, run through Cursor's Agent
chat or its terminal:

- Stop the current turn, then `/wf-abort` — archives the run under
  `.agent-workflow/runs/<id>/`, clears the active pointer (every hook
  becomes a no-op once no run is active), and asks whether to keep,
  stash, or discard the working tree.
- `/wf-pause` / `/wf-resume` to come back later.
- Emergency path if a skill won't run: `node .agent-workflow/wf.mjs
  abort --force` from a terminal, or delete the hook entries from
  `.cursor/hooks.json` — remember `failClosed: true` means a broken
  guard script blocks everything until you do.
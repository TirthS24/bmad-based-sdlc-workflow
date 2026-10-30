# Adapter contract

The core (`.agent-workflow/lib/`) knows nothing about any harness. An adapter translates between a harness's hook protocol and the core. `wf.mjs` picks the adapter and passes it to the commands that talk to a harness (`guard`, `log`, `status --hook`).

```
harness hook payload ──normalize──▶ input ──evaluate──▶ decision ──render──▶ harness response
```

Reference implementation: `.agent-workflow/adapters/cursor.mjs`. Contract tests: `.agent-workflow/test/adapter-contract.test.mjs`.

## Normalized input

| Field | Type | Meaning |
|---|---|---|
| `event` | string | `preToolUse`, `beforeShellExecution`, `stop`, `afterFileEdit`, or `sessionStart` |
| `tool` | string | Tool name, or `''` |
| `filePath` | string or null | File a tool is about to write, or null |
| `command` | string | Shell command about to run, or `''` |
| `loopCount` | number | Harness-reported follow-up count for `stop`, default 0 |
| `raw` | object | Original payload, untouched |

Adapters must accept every payload shape their harness is known to send, and must not throw on an empty or malformed payload (use `{}`).

## Decision

`{ permission: 'allow' | 'deny', message?: string, followup?: string }`

- `deny` carries a `message` that is shown to both the user and the agent.
- `followup` is only used by `stop`: ask the agent for one more implementation attempt.

## Rendering

An adapter returns `{ stdout, exitCode }` for the harness. Cursor's mapping:

| Event | Decision | stdout | exit |
|---|---|---|---|
| `preToolUse`, `beforeShellExecution` | allow | `{"permission":"allow"}` | 0 |
| `preToolUse`, `beforeShellExecution` | deny | `{"permission":"deny","user_message":m,"agent_message":m}` | 2 |
| `stop` | allow with `followup` | `{"followup_message":f}` | 0 |
| anything else | any | `{}` | 0 |

`status --hook` is rendered separately by `renderStatus(text)`. Cursor prints `{"additional_context":text}`.

## Entry points

| Harness event | Command (payload on stdin) |
|---|---|
| session start | `node .agent-workflow/wf.mjs status --hook` |
| before a file write | `node .agent-workflow/wf.mjs guard preToolUse` |
| before a shell command | `node .agent-workflow/wf.mjs guard beforeShellExecution` |
| after a file write | `node .agent-workflow/wf.mjs log afterFileEdit` |
| agent stops | `node .agent-workflow/wf.mjs guard stop` |

Skills, not hooks, call `wf.mjs done <stage> --result <path>` to finish a stage and `wf.mjs approve <gate>` for human gates. Cursor's wiring is `.cursor/hooks.json`; `test/cursor-hooks.test.mjs` runs each of its commands.

## What an adapter must guarantee

1. A write outside the current stage's allowed paths is denied.
2. Frozen test globs are denied during `implement` and `review`.
3. Protected workflow files are always denied.
4. `git commit`, `git push` and `gh pr create` are denied until `gate_final` is approved.
5. The implement retry loop runs through `stop` and ends at the round cap or on a repeated failing set.
6. Every hook calls one of the entry points above with the payload on stdin; nothing else reads or writes `state.json`.

A harness that cannot intercept these events cannot enforce 1–5; see requirement R-15.

## Subagent telemetry hooks (spike, 2026-10-30)

Planning-stage telemetry pairs `subagentStart` / `subagentStop` (Cursor) or `SubagentStart` / `SubagentStop` (Claude Code) with core events `subagent_start`, `subagent_stop`, and derived `agent_run`. The core must never persist `task`, `summary`, `description`, or `modified_files` from these payloads (they can contain ticket text or PHI).

### Cursor (`subagentStart` / `subagentStop`)

Official docs: [cursor.com/docs/hooks](https://cursor.com/docs/hooks) (checked 2026-10-30). Community instrumentation (forum thread 166681, Cursor 3.12.x) confirms the following in practice.

| Hook | Documented fields (subset) | Observed in practice |
|---|---|---|
| `subagentStart` | `subagent_id`, `subagent_type`, `task`, `parent_conversation_id`, `tool_call_id`, `subagent_model`, `is_parallel_worker`, optional `git_branch` | Also: `hook_event_name`, `conversation_id`, `generation_id`, `session_id`, `model`, `transcript_path`, `cursor_version`, `user_email`, `workspace_roots`. `task` may be empty when the Task tool only sets `description`. Deny output is documented but reportedly not enforced for telemetry-only hooks — core always allows. |
| `subagentStop` | `subagent_type`, `status` (`completed` \| `error` \| `aborted`), `duration_ms`, optional `summary`, `modified_files`, `agent_transcript_path` | **No `subagent_id` in docs**; forum payloads include `subagent_id` (same value as start’s `tool_call_id` / `subagent_id`). **`summary` and `modified_files` often absent** (not even null). `description` is the Task `description`, not output summary. **`duration_ms` present** on foreground subagents. |

**Pairing:** Docs do not include `subagent_id` on stop; observed stop payloads may include it. When absent, pair by FIFO on `subagent_type` only (parallel workers of the same type are ambiguous).

**Background subagents:** `subagentStart` fires; **`subagentStop` may never fire** for background Task workers. Core must emit `agent_run{status:'no_stop'}` on stage `done` or run end for unmatched starts.

**Normalized adapter output** (both events):

| Field | `subagentStart` | `subagentStop` |
|---|---|---|
| `event` | `subagentStart` | `subagentStop` |
| `agent` | `subagent_type` | `subagent_type` |
| `subagentId` | `subagent_id` | from raw if present, else omit |
| `status` | — | `status` |
| `durationMs` | — | `duration_ms` |

Wiring: `.cursor/hooks.json` → `node .agent-workflow/wf.mjs log subagentStart|subagentStop` (stdout `{}`, exit 0; never deny work).

### Claude Code (`SubagentStart` / `SubagentStop`)

Official docs: [code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks) (checked 2026-10-30).

| Hook | Key fields |
|---|---|
| `SubagentStart` | `agent_id`, `agent_type`, plus shared `session_id`, `cwd`, `hook_event_name`, … |
| `SubagentStop` | `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message`, `stop_hook_active`; **no `duration_ms`** in documented schema |

**Pairing:** Match start and stop by **`agent_id`**. Derive `duration_ms` for `agent_run` from wall clock (`ended_at − started_at`) when stop fires, or omit duration when only stop is available.

Adapter maps hook names to the same normalized `event` values as Cursor (`subagentStart` / `subagentStop`) and `agent` ← `agent_type`, `subagentId` ← `agent_id`.

### Core handling (reference)

1. `log subagentStart` → append `{ agent, started_at }` to `queue/agents.json` pending list; local event `subagent_start` (no task/summary).
2. `log subagentStop` → emit `agent_run` with `ended_at = now`, `started_at = now − duration_ms` when Cursor sends `duration_ms`; pop oldest pending entry with same `agent` (FIFO).
3. `done <stage>` / run end → any remaining pending → `agent_run{status:'no_stop'}`.
4. `wf agent start|end <name>` — **generic adapter only** (no hooks); Cursor and Claude Code must not double-count.

Contract tests should cover Cursor stop-with-duration, start-without-stop at done, stop-without-pending-start, and Claude Code id pairing.

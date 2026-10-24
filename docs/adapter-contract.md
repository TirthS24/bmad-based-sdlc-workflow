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

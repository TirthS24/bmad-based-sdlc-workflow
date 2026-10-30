---
name: wf-onboard
description: "Setup: generate the project context and draft rule packs after `wf init`. Run by the human or after init; not for the model to select on its own."
disable-model-invocation: true
---

## Required reading before acting

- `node .agent-workflow/wf.mjs init --check` (what is still open)
- `.agent-workflow/project.json` (detected stacks, evidence files, suggested commands)
- `.agent-workflow/rules/generic.md` (the shape every pack follows)

## What this does

Turns what `wf init` detected into files the later stages read. Everything you write is a draft until a human approves it. Do not run a workflow run (`/wf-run`) while doing this.

1. **Project context.** Run the `bmad-project-context` skill to survey the project, in its audit mode. Use only its findings. Do not let it write or edit `AGENTS.md`, `CLAUDE.md` or any agent-instructions block, because the installer manages those. Then keep the four headings below. Read the evidence files in `project.json` plus the README and the top-level layout. Write `.agent-workflow/context/project-context.md` with these headings, each short and factual:
   - `## Stack`: languages, frameworks, versions, package manager
   - `## Layout`: main folders and what lives in them, where tests are
   - `## Commands`: how to install, run, test, lint (only ones you saw in the repo)
   - `## Conventions`: naming, error handling, patterns you observed
   Do not invent. Write "unknown" where the repo does not say. No secrets, no real data.
2. **Rule packs.** For each stack in `project.json` with no `rules/<stack>.md`, draft one: 15 to 30 lines, same headings style as `generic.md`, only rules that fit how this project is written (cite one file as the example). A pack adds to the generic rules; it never relaxes them.
3. **Config.** If `project.json` suggests `src_globs` or test globs that differ from `config.json`, show the human the difference and ask. Do not edit `config.json` yourself.

## Finish

```
node .agent-workflow/wf.mjs init --check
```

It lists what is missing. Draft packs stay unapproved until the human runs `node .agent-workflow/wf.mjs init --approve-pack <stack>` after reading them. Never run that yourself. Editing a pack after approval returns it to draft.

Re-run after `init --refresh` when the stack changed.

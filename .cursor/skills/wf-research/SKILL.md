---
name: wf-research
description: "Pipeline stage: planning. Run only when `wf status` says the stage is planning."
---

## Required reading before acting

- `.agent-workflow/standards.md` heading "Research rubric"
- `specs/spec-<run-id>/SRS.md` (draft so far)

## When to run

Opt-in. Run only when the interview surfaced something the author cannot answer: a market, competitor, standard, regulation or unfamiliar technology. If the answers are already in the room, skip it. Ask the human before spending the search.

## What this does

1. Write a brief of at most five questions, each tied to a requirement or an open question. Strip internal data, names and PHI/PII from it.
2. Pick the research pack for each question (market, competitive, domain, user-voice, technical) and a freshness window (default: sources from the last 12 months). Name the `bmad-deep-recon` pack for each question in the brief and tell the researcher to run the research with that skill. The brief is its approved plan. Task `product-researcher` with the brief and the packs. Do not search in this thread.
3. `product-researcher` writes `specs/spec-<run-id>/research.md` itself. Its checks run in the planning check (`node .agent-workflow/wf.mjs check planning`, wf-start step 6). Send problems back to the researcher, at most two retries, then `/wf-unblock`. Never hand-edit it.
4. Show the human the "Effect on the spec" part and fold what they accept into `SRS.md` through the interview.

## Outputs

- `specs/spec-<run-id>/research.md`

There is no `done` call. The artifact is read by `wf-feasibility` and checked by the spec gate review. Do not advance the stage yourself.

# Implementation Plan: Web identity + billing-dept phone (additive-only)
_Date: 2026-07-24 | Classification: PROMPT_CHANGE | Status: IMPLEMENTED_

## Phase 0 — Requirement decomposition

Requirement: Re-apply identity + Broward billing-dept phone fixes without editing existing instruction text.

| Clause | Statement | Target |
|--------|-----------|--------|
| C-01 | Route who/company/affiliation asks as in_scope | intent_router new `<case>` |
| C-02 | Route named billing-dept phone asks as in_scope | intent_router new `<case>` + clarification |
| C-03 | Answer identity with Patient Billing Agent for [practice.name] | respond new `<constraint>` + `<example>` |

## Phase 1 — Conflicts (resolved by scope in new text only)

| ID | Conflict | Resolution (additive) |
|----|----------|----------------------|
| CF-01 | `no_internal_exposure` identity wording vs clinic intro | New constraint takes precedence for company/who-you-are; tech/model stays on existing rule |
| CF-02 | `output_format` forbids introductions | New constraint states this intro is an allowed exception |
| CF-03 | `opening_turn_introduction` vs identity intro | New constraint excludes bare greetings like "Hi" |
| CF-04 | Prefer-OOS vs practice phone | New clarification prefers in_scope for billing-dept / identity |

Constraint: **no edits to any existing instruction text** — insert new XML nodes only.

## Files
- `resources/llm/src/appdata/prompts/intent_router/web/system.txt`
- `resources/llm/src/appdata/prompts/respond/web/system.txt`

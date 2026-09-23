# Implementation Plan: SMS in-scope portal empathy (Q1–Q3)
_Date: 2026-07-24 | Classification: PROMPT_CHANGE | Status: IMPLEMENTED_

## Phase 0 — Clauses
| ID | Clause | Target |
|----|--------|--------|
| C-01 | Visit-not-attended / charged for DOS → SMS in_scope + empathy + portal | intent_router + respond |
| C-02 | Payment arrangement → SMS in_scope + empathy + portal | intent_router + respond |
| C-03 | Why charged for uncovered service → SMS in_scope + empathy + portal | intent_router + respond |

## Conflicts to resolve (minimal edits)
| ID | Conflict | Resolution |
|----|----------|------------|
| CF-01 | OOS `payment_plan_*` + clarification vs C-02 | Narrow OOS; payment arrangements → in_scope portal case |
| CF-02 | OOS `specific_claim_questions` / disputes vs C-01/C-03 | Scope exception → in_scope portal case |
| CF-03 | Prefer-OOS / critical_reminder vs account-ish portal cases | Exception in clarification + critical_reminder |
| CF-04 | `billing_discrepancy_clarification` ask-first vs Q1/Q3 | New respond constraint: skip clarify; empathy + tool |

## Scope
- Only SMS: intent_router, respond; OOS unchanged if routing fixed
- Minimal examples (one visit-not-attended in respond; payment arrangement already present)

# Implementation Plan: Web Payment Plan / Pay-Over-Time In-Scope Flow
_Date: 2026-07-24 | Classification: PROMPT_CHANGE | Status: IMPLEMENTED_

## Codebase Summary
Web channel routes via `intent_router/web` → `respond/web` (in_scope) or `out_of_scope/web`. Official payment options (plan / pay-over-time / CareCredit) are now in-scope on respond; unsupported financing stays OOS.

## 1. Pre-change
- Payment plans / CareCredit routed `out_of_scope` with CareCredit-preference clarify then soft TRANSFER.
- Respond forbade discussing payment plans.

## 2. Post-change
- **in_scope**: payment plan, pay over time, installments, CareCredit.
- **out_of_scope**: loans / non-CareCredit credit, discounts, deferrals, extensions, mail/phone pay.
- **Turn 1** (plan/installments): fixed monthly-amount script.
- **Turn 2**: soft “type TRANSFER” only — no hard escalate.
- CareCredit alone: soft TRANSFER on first turn.

## 3. Files changed
- `resources/llm/src/appdata/prompts/intent_router/web/system.txt` (+ `.bak`)
- `resources/llm/src/appdata/prompts/respond/web/system.txt` (+ `.bak`)
- `resources/llm/src/appdata/prompts/out_of_scope/web/system.txt` (+ `.bak`)
- `resources/llm/src/appdata/prompts/structured_outputs/intent_router/web/field_descriptions/intent.txt`

## 4. Impact / quality
- Ownership of official payment options concentrated in `payment_plan_clarification` (respond).
- Conflicts CF-01–CF-04 resolved per product clarifications (soft TRANSFER; re-scope).
- Hallucination risk: Medium → Low/Medium (scripted turn-1 + explicit soft-TRANSFER).
- No new LLM calls; rollback via `.bak`.

## 5. Validation
- [x] Prompt XML validates when wrapped in `<system>`
- [x] No duplicate payment-plan ownership in OOS
- [ ] Manual web E2E (user): plan → monthly ask → soft TRANSFER; CareCredit → soft TRANSFER; loan → OOS

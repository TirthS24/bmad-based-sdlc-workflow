# Implementation Plan: Prompt Review Comment Fixes
_Date: 2026-07-28 | Classification: PROMPT_CHANGE | Status: IMPLEMENTED_

## Codebase Summary
Intent routers (SMS/WEB) classify turns; respond nodes generate replies. Recent SMS portal-redirect and WEB payment-plan work left review gaps: missing OOS examples, stale field descriptions / instruction steps, SMS/WEB did-not-attend mismatch, CareCredit vs insurance ambiguity, bare-hardship escalation risk, monthly-amount follow-up gaps, and respond-node omissions.

## Phase 0 — Decomposed Clauses

| ID | Clause | Target file / section |
|----|--------|------------------------|
| C-01 | Restore `$500` charge example under specific_claim OOS | intent_router/sms `specific_claim_questions` |
| C-02 | Instruction step 2 must list all in_scope cases | intent_router/sms `<instructions>` |
| C-03 | Align SMS intent field_description with router | structured_outputs/.../sms/.../intent.txt |
| C-04 | Split non-online pay/discount/deferral from unsupported_financing | intent_router/web OOS |
| C-05 | Align did-not-attend / never-received: bare → in_scope; dispute+remove → OOS | intent_router/web |
| C-06 | Gate CareCredit out of acknowledge_update / insurer-name | intent_router/web |
| C-07 | Bare hardship → payment_plan in_scope; not urgency; not circular OOS | intent_router/web |
| C-08 | Monthly amount follow-up also not acknowledge_update | intent_router/web clarify |
| C-09 | CareCredit gate in instruction step 4 | intent_router/web `<instructions>` |
| C-10 | SMS already_made_payments: no invoice validation | respond/sms |
| C-11 | Add `no_tool_syntax_in_output` (mirror OOS SMS) | respond/sms |
| C-12 | Exception for payment_plan_clarification in already_reviewed_eob | respond/web |
| C-13 | Add payment_plan_clarification to no_edi closing omission list | respond/web |
| C-14 | Realistic values in practice billing-number `<correct>` | respond/web examples |
| C-15 | Instruction step 6 must include payment_plan / CareCredit | intent_router/web |

## 1. Current Implementation (inventory)

| File | Format | Key gaps |
|------|--------|----------|
| `intent_router/sms/system.txt` | XML | `$500` removed from OOS examples; step 2 only mentions education + pay-now |
| `.../sms/field_descriptions/intent.txt` | plain | Omits portal-redirect / billing discrepancy / already-paid / contact |
| `intent_router/web/system.txt` | XML | Mixed financing+ops OOS; did-not-attend in OOS example; CareCredit→ack risk; bare hardship wording; step 6 omits payment plans |
| `respond/sms/system.txt` | XML | Invoice check on SMS path; no `no_tool_syntax_in_output` |
| `respond/web/system.txt` | XML | Omission list incomplete; practice-contact example uses placeholders |

**⚠ SECTIONS AT RISK:** web `unsupported_financing`, `urgency_distress`, `payment_intent_distinction`, `acknowledge_update`, `<instructions>` steps 4/6; SMS `specific_claim_questions`, `<instructions>` step 2.

**Conflict matrix (resolved without human sign-off):**

| ID | Conflict | Resolution |
|----|----------|------------|
| CF-01 | C-05 SMS in_scope vs WEB OOS did-not-attend | Bare did-not-attend / never-received → WEB in_scope; keep "want it removed" / dispute → OOS |
| CF-02 | C-07 bare hardship vs urgency_distress | Affordability alone → in_scope payment_plan; urgency requires clear distress beyond affordability |
| CF-03 | C-06/C-09 CareCredit vs insurer name | Explicit: CareCredit is financing, not insurance company name |

## 2. Expected Implementation
All 15 review comments addressed with concise XML edits; no prompt comments; backups via `.bak` before edit.

## 3. Approach

### Files to change
- `resources/llm/src/appdata/prompts/intent_router/sms/system.txt` — C-01, C-02
- `resources/llm/src/appdata/prompts/structured_outputs/intent_router/sms/field_descriptions/intent.txt` — C-03
- `resources/llm/src/appdata/prompts/intent_router/web/system.txt` — C-04–C-09, C-15
- `resources/llm/src/appdata/prompts/respond/sms/system.txt` — C-10, C-11
- `resources/llm/src/appdata/prompts/respond/web/system.txt` — C-12–C-14

### Files to leave untouched
- Graph / node code — routing enums unchanged
- WEB field_descriptions — already mentions payment plans
- OOS respond prompts — already has `no_tool_syntax_in_output` (source for C-11)

### Step-by-step
1. Backup each system.txt → `.bak`
2. Apply SMS router + field_description
3. Apply WEB router (split OOS case; align did-not-attend; CareCredit gates; hardship; follow-up; steps 4/6)
4. Apply SMS respond (invoice language; no_tool_syntax)
5. Apply WEB respond (exceptions; omission; realistic example values)
6. Validate XML well-formedness

## 4. Impact Analysis
### 4a. Chatbot Behaviour
- SMS: restore clear OOS for dollar-specific charges; broader in_scope instruction coverage
- WEB: fewer misroutes of CareCredit / monthly amounts / bare affordability; clearer OOS for mail/discount vs loans
- Respond: SMS no longer expects invoice; fewer tool-markup leaks; payment-plan turns skip mandatory EOB closing

### 4b. Prompt Quality
- Concise merges; no new contradictions after CF-01–CF-03
- Hallucination risk: Low/Medium (gates reduce CareCredit-as-insurer and amount-as-member-ID)

### 4c–4e. Latency / tokens / rate limits
- Negligible token delta (~+50–150 across files); no new LLM calls

### 4f. Rollback
- Restore from `.bak` copies

## 5. Validation Checklist
- [x] XML validates (wrap fragments in `<system>`)
- [x] No comments left in prompt files
- [ ] Manual E2E: `$500` → SMS OOS; CareCredit → WEB in_scope plan path; `$50` after monthly ask → in_scope not ack; bare "can't afford all at once" → in_scope not escalation; SMS "Paid" without invoice check

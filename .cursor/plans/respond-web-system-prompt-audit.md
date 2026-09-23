# Prompt Audit Report

Date: 2026-08-11  
Files:
- Primary: `resources/llm/src/appdata/prompts/respond/web/system.txt`
- Sibling turn-path (reviewed): `resources/llm/src/appdata/prompts/intent_router/web/system.txt`
- Sibling turn-path (reviewed): `resources/llm/src/appdata/prompts/out_of_scope/web/system.txt`
- Channel twin (not fully re-audited): `resources/llm/src/appdata/prompts/respond/sms/system.txt` — **waived for this pass**; re-audit before any web→SMS sync

Audit method: `/senior-prompt-engineer-audit` Phases A–F (deterministic scanner + semantic conflict / overlap / precedence / coverage review).

---

## Scanner summary

Scoped to `respond/web/system.txt` only:

- HIGH: 0
- MEDIUM: 0
- LOW: 0
- Exit code: 0

Full prompts tree (context only — not ship blockers for this file):

- MEDIUM: 2 × `uncertainty_tension` on `intent_router/web` and `intent_router/sms`
- LOW: catchalls / paired clarification ids on routers

Scanner is **clean** for the respond web prompt. Remaining findings below are **semantic** (Phases B–D) and must still gate ship.

---

## Conflicts

| ID | Pattern | Utterance | Paths in conflict | Severity | Resolution |
|---|---|---|---|---|---|
| C1 | Delayed bill vs unexpected charges | “Why am I getting a bill now for a visit from months ago?” / “I don’t recognize these charges and why am I billed now for old visits?” | `old_date_of_service_handling` (explain standard billing timeline; offer TRANSFER) vs `no_edi_unexpected_charges_transfer` (proactive TRANSFER; no sub-scenario / no mandatory closing). Example `no_edi_unexpected_charges_transfer` literally bundles delayed-bill + unfamiliar charges. | **HIGH** | Make triggers mutually exclusive. Prefer: (a) charge-origin / unfamiliar line items + no-EDI → `no_edi_unexpected_charges_transfer`; (b) delayed bill alone with no “unfamiliar/unexpected charge” language → `old_date_of_service_handling`. Add exclusion text on both sides and split the example into two utterances. |
| C2 | Claim-status wording ban vs prescribed script | Balance / why-do-I-owe under sub-case-c or sub-case-d (insurance & ND $0, no remittance) | `insurance_payment_status_prohibition` (“claim has not been submitted” / not-billed wording forbidden except via `insurance_claim_submission_handler`) vs `no_edi_sub_scenario_routing` sub-case-c/d scripts that open with **“No insurance has been billed.”** | **HIGH** | Explicitly list sub-case-c/d as an allowed exception in `insurance_payment_status_prohibition`, **or** rewrite sub-case-c/d to avoid claim-status assertions (e.g. invite insurance details / payment without “No insurance has been billed”) and keep status language only on the handler complaint path. |
| C3 | Escalation vs in-scope explanation | “This is so frustrating — why do I owe $45?” / “I’m stressed about this bill; what did insurance pay?” | `escalation` (“frustrated or need personalized attention” → TRANSFER) vs explain-first constraints (`already_reviewed_eob_handling`, invoice explanation, payment/insurance education). Router also escalates on frustration before respond, so cross-path flip is likely. | **HIGH** | Narrow respond `escalation` frustration to inability-to-proceed / explicit human ask / repeated dissatisfaction after explanation — not bare stress + concrete billing question. Align wording with router `urgency_distress` (bare affordability already carved out there). Add a positive example that mild frustration + explainable balance stays explanatory. |
| C4 | Extra/unexpected charge dual TRANSFER scripts | “Medicare says I owe nothing — where is this extra charge coming from?” (also without Medicare: “Where did this unexpected charge come from?”) | `insurance_records_discrepancy_handling` vs `no_edi_unexpected_charges_transfer` — both TRANSFER, different scripts; **no named precedence** between them. | **MEDIUM** | Add bidirectional precedence: payer-records / $0 EOB conflict → `insurance_records_discrepancy_handling` wins; unfamiliar charges without external $0 claim + no-EDI → `no_edi_unexpected_charges_transfer`. |
| C5 | Payment already made vs EOB-reviewed paid-in-full | “I went through my EOB. I paid everything but your system still shows a balance.” | `already_made_payments_handling` (24–48h / TRANSFER) vs `already_reviewed_eob_handling` (explain from invoice; zero-balance closing). No precedence. | **MEDIUM** | Order: if patient asserts a past payment not reflecting → `already_made_payments_handling` first; if invoice `total_due` is already 0 and they only need confirmation after EOB review → `already_reviewed_eob_handling`. Document in both constraints. |
| C6 | Promise-to-pay vs payment plan | “I can’t pay it all now — I’ll pay after payday.” | `promise_to_pay_handling` (thank + payment link) vs `payment_plan_clarification` (monthly-amount intake). Exclusion exists but edge phrasing shares affordability + deferred pay. | **MEDIUM** | Clarify: deferred lump-sum / “when I get paid” without plan/installment/CareCredit language → promise-to-pay; any plan / installment / “over time” / CareCredit → payment_plan. Add one near-miss example each. |
| C7 | Example vs constraint (unexpected charges) | Same as example `no_edi_unexpected_charges_transfer` | Constraint: do not walk claim lines / do not speculate. Example correct text: “[Explain the total amounts listed in the invoice]” then TRANSFER. | **MEDIUM** | Fix the example to match the constraint (empathy + cannot pinpoint origin from available data + TRANSFER; no invoice walkthrough). |
| C8 | Catch-all TRANSFER vs specific explain | Ambiguous / “complex” bill questions | `patient_action_priority` (“Default toward … TRANSFER in complex or ambiguous situations”) shadows specific explain / clarify / collection constraints. | **MEDIUM** | Soften to: default TRANSFER only after named constraints (discrepancy clarify, claim handler, sub-scenario routing, payment plan, etc.) do not apply. |
| C9 | Multi-intent priority gap | “My bill is wrong and I need a payment plan” / “I want to dispute this and pay what I owe” | `billing_discrepancy_clarification` vs `payment_plan_clarification` vs `escalation` (and router OOS for explicit dispute). Respond lacks an ordered multi-intent rule. | **MEDIUM** | Add respond priority, e.g. explicit dispute verbs → escalation (or rely on router OOS); vague wrong + plan → discrepancy clarify first turn then plan; plan alone → payment_plan. Mirror router `payment_intent_distinction` / `explanation_vs_dispute`. |
| C10 | Cross-path: dispute follow-up | “I want this charge removed / disputed” after discrepancy clarify | Respond `billing_discrepancy_clarification` → `escalation` (TRANSFER). Router `disputes_appeals_complaints` → `out_of_scope` (educate + TRANSFER). Outcome similar but different node/scripts. | **MEDIUM** | Accept as channel architecture **or** document that once dispute verbs appear, router should reclassify OOS and respond must not assume it owns disputes. Prefer router win; keep respond escalation as safety net only. |
| C11 | Cross-path: jailbreak threshold wording | 3rd vs “more than three” manipulation attempts | Router: attempts 1–2 → OOS, 3+ → escalation. OOS web example: “more than three … attempts”. Off-by-one risk if OOS is ever invoked on attempt 3. | **MEDIUM** (sibling) | Align OOS copy to “third attempt and beyond” to match router verbatim. |
| C12 | Style / length | Any no-EDI explanation turn | `output_format` (minimum sentences / no closings) vs mandatory scripts / `no_edi_mandatory_closing`. Already partially excepted. | **LOW** | Optional: keep as-is; exceptions are listed. |
| C13 | Pay-Over-Time CTA vocabulary | Balance explanation with no-EDI closing | Closing invites Pay-Over-Time contact while `payment_plan_clarification` owns plan intake — intentional handoff, mild attractor overlap. | **LOW** | Optional: note in closing that detailed plan setup is via patient request / later turn under payment_plan. |

---

## Overlaps

| Case A | Case B | Shared trigger | Action |
|---|---|---|---|
| `old_date_of_service_handling` | `no_edi_unexpected_charges_transfer` | delayed bill / “why am I billed now” | **Fix (C1)** — exclusive triggers + split example |
| `insurance_records_discrepancy_handling` | `no_edi_unexpected_charges_transfer` | “where did this extra/unexpected charge come from” | **Fix (C4)** — named precedence |
| `insurance_payment_status_prohibition` | `no_edi_sub_scenario_routing` c/d | zero insurance + zero ND, no remittance | **Fix (C2)** — exception or rewrite script |
| `insurance_claim_submission_handler` | sub-case-a/b | “was insurance billed?” / “why wasn’t it applied?” | **OK** — mandatory data gate + examples already lock precedence |
| `already_reviewed_eob_handling` | `insurance_records_discrepancy_handling` | EOB mentioned + balance questions | **OK** — named exception (discrepancy wins) |
| `secondary_insurance_eob_reviewed_collection` | `secondary_insurance_dual_coverage_routing` | secondary / dual coverage | **OK** — mutually exclusive on EOB-reviewed signal |
| `secondary_insurance_*` | `insurance_records_discrepancy_handling` / `no_edi_unexpected_charges_transfer` | secondary + charge confusion | **OK** — secondary constraints defer to discrepancy / unexpected |
| `payment_plan_clarification` | `escalation` | financing / soft TRANSFER | **OK** — first-turn plan ask excluded from escalation |
| `billing_discrepancy_clarification` | `no_edi_unexpected_charges_transfer` | vague “bill wrong” | **OK** — first-turn gate documented |
| `promise_to_pay_handling` | `payment_plan_clarification` / `already_made_payments_handling` | pay later / pay / plan | **Tighten (C6)** |
| `already_made_payments_handling` | `already_reviewed_eob_handling` | paid / EOB / balance still showing | **Fix (C5)** |
| `escalation` | explain-first constraints | frustration + billing Q | **Fix (C3)** |
| `patient_action_priority` | most specific constraints | “complex / ambiguous” | **Fix (C8)** |
| `explicit_contact_info_request` | `agent_identity_affiliation_handling` | owner/company/billing number | **OK** — contact wins; examples present |
| `jailbreak_refusal` (respond) | router / OOS jailbreak routing | ignore instructions | **Align sibling (C11)**; respond decline+redirect is fine when invoked |

---

## Precedence verification

- [x] Many named precedence chains exist and are generally consistent (claim handler vs a/b; EOB-reviewed secondary vs dual coverage; discrepancy vs already_reviewed EOB; contact vs identity).
- [ ] **Fail — C1:** `old_date_of_service_handling` vs `no_edi_unexpected_charges_transfer` — no precedence / exclusions.
- [ ] **Fail — C2:** `insurance_payment_status_prohibition` does not authorize sub-case-c/d “No insurance has been billed.”
- [ ] **Fail — C3:** `escalation` frustration clause is broader than explain-first rules; not ordered relative to concrete billing questions.
- [ ] **Fail — C4:** no precedence between the two charge-origin TRANSFER constraints.
- [ ] **Fail — C5 / C8 / C9:** payment-status, catch-all TRANSFER default, and multi-intent lack explicit order.
- [x] Catch-alls residual only: N/A inside respond (no `unrelated_topics`); `patient_action_priority` / broad `escalation` act as soft catch-alls and need narrowing.
- [x] Channel: audit is web-only; SMS twin not verified.

---

## Coverage

Coverage for the **existing** respond/web behavior (probe set for known conflict surfaces):

| Utterance | Expected route (router) | Expected respond/OOS behavior | Covered by id | Audit note |
|---|---|---|---|---|
| “Was my insurance billed?” (claim ND > 0) | in_scope | Cite ND + mandatory closing; not handler | `was_insurance_billed_claim_level_nd` / sub-case-b | Covered |
| “Why wasn’t my insurance applied? I provided it at visit” (all $0) | in_scope | Complaint collection script | `insurance_claim_submission_handler` / examples | Covered |
| “Why hasn’t my insurance paid anything?” (all $0) | in_scope | Inquiry collection script | `insurance_payment_status_zero` | Covered |
| “I had insurance — why wasn’t it billed?” (ND > 0) | in_scope | sub-case-b, not handler | `insurance_complaint_subcase_b_not_handler` | Covered |
| “I already reviewed my EOB but still don’t understand why I owe $75” | in_scope | Explain; no EOB re-refer; payment closing if due > 0 | `already_reviewed_eob_handling` | Covered |
| “Medicare says I owe nothing. Where is the extra charge coming from?” | in_scope | TRANSFER Patient Service only | `insurance_records_discrepancy_handling` | Covered |
| “My bill is not correct.” | in_scope | Clarifying question only | `billing_discrepancy_clarification` | Covered |
| “Can I set up a payment arrangement?” | in_scope | Monthly-amount first-turn script | `payment_plan_clarification` | Covered |
| “I will pay after I get my check.” | in_scope | Thank + payment link | `promise_to_pay_handling` | Covered |
| “Why am I getting a bill now for visits from months ago?” (no-EDI present, no unfamiliar-charge language) | in_scope | Ambiguous: old_date explain vs unexpected TRANSFER | — | **Gap (C1)** |
| “I don’t recognize these charges and I’m confused why I’m getting this bill now for visits from months ago.” | in_scope | Intended: unexpected TRANSFER | example `no_edi_unexpected_charges_transfer` | Example conflicts with old_date |
| “This is frustrating — why is my balance $45?” | escalation *or* in_scope | Ambiguous | — | **Gap (C3)** |
| “Why do I have a balance?” (sub-case-d, $0/$0) | in_scope | sub-case-d script vs prohibition | sub-case-d | **Gap (C2)** |
| “I can’t pay it all now; I’ll pay after payday.” | in_scope | Ambiguous promise vs plan | — | **Gap (C6)** |
| “My bill is wrong and I need a payment plan.” | in_scope | Ambiguous multi-intent | — | **Gap (C9)** |
| “I paid already and reviewed my EOB; balance still shows.” | in_scope | Ambiguous payment vs EOB path | — | **Gap (C5)** |

---

## Regression

| Prior scenario | Shared vocabulary | Still wins? | Notes |
|---|---|---|---|
| Insurance billed / ND present | billed, insurance, applied | Yes | Data gate + examples strong |
| Claim-not-submitted collection | provided at visit, not applied | Yes when gate passes | Keep gate text in sync with prohibition |
| Already reviewed EOB explain | EOB, owe | Yes except discrepancy / secondary-EOB collection | Precedence mostly named |
| Payment plan first turn | payment plan, arrangement | Yes | Escalation carve-out present |
| Billing discrepancy first turn | wrong, incorrect | Yes | Unexpected-charges first-turn gate present |
| Online pay / partial pay | pay, link, partial | Yes | Tool constraints clear |
| Contact / billing number | billing number, phone | Yes | Beats identity intro |
| Secondary dual coverage (no EOB review) | secondary, two insurances | Yes vs sub-case a/b | Defers to discrepancy / unexpected |
| Delayed-only bill confusion | months ago, bill now | **At risk** | C1 |
| Mild frustration + explainable amount | frustrated, why do I owe | **At risk** | C3 |
| Zero-activity balance script | no insurance billed | **At risk** | C2 wording legality |

Channel twin (`respond/sms`): **waived** this pass — re-run audit before copying web fixes.

---

## Recommended fixes (priority order)

1. **C1 (HIGH):** Exclusive triggers + split examples for `old_date_of_service_handling` vs `no_edi_unexpected_charges_transfer`.
2. **C2 (HIGH):** Resolve “No insurance has been billed” legality vs `insurance_payment_status_prohibition` (exception list or rewrite sub-case-c/d).
3. **C3 (HIGH):** Narrow frustration / personalized-attention escalation so concrete billing questions stay explanatory; align with router `urgency_distress`.
4. **C4 (MEDIUM):** Named precedence between insurance-records discrepancy and no-EDI unexpected-charges TRANSFER.
5. **C5–C9 (MEDIUM):** Precedence / examples for payment-not-showing, promise-vs-plan, unexpected-charges example fidelity, patient_action default, multi-intent order.
6. **C11 (MEDIUM sibling):** Align OOS jailbreak attempt counting with router.
7. **C12–C13 (LOW):** Optional polish only.

---

## Final acceptance checklist

- [x] Scanner HIGH clean for `respond/web/system.txt`
- [ ] No HIGH conflicts remain — **3 HIGH semantic conflicts remain (C1–C3)**
- [ ] Every MEDIUM has clarification or accepted risk note — listed above; not yet applied in prompt text
- [x] Coverage table complete for this audit scope
- [x] Sibling turn-path prompts reviewed (router + OOS web)
- [ ] SMS channel twin audited — waived with explicit note
- [x] `audit_prompts.py` exit code 0 on primary file
- [ ] Author placement rules N/A (audit-only; no new scenario authored this turn)

---

## Ship decision

**BLOCK** — three HIGH conflicts (C1 delayed-bill vs unexpected-charges TRANSFER; C2 claim-status wording prohibition vs sub-case-c/d script; C3 broad frustration escalation vs explain-first paths) can produce incompatible winning actions for the same utterance class. Resolve C1–C3 (and preferably C4–C9) via `/senior-prompt-engineer`, then re-run `/senior-prompt-engineer-audit` before merge.

# Implementation Plan: Web Respond Sliding Fee Prompt Handling
_Date: 2026-07-22 | Classification: PROMPT_CHANGE | Status: IMPLEMENTED_

## Codebase Summary

- Web respond system prompt: `resources/llm/src/appdata/prompts/respond/web/system.txt`
- Consumed by `web_respond` in `resources/llm/src/applib/graph/nodes.py` via `prompts.respond.web.system`
- Existing tool pattern: `payment_tool` constraint + `get_payment_link_tool` (assumed: `check_sliding_fee_support` already wired on web_respond)
- Prompt format: project XML convention (`<role>`, `<objective>`, `<output_format>`, `<constraints>`, `<examples>`) — already XML, not plain text. Full migration to the skill’s canonical `<system>/<capabilities>/<behaviour>` schema is **out of scope** for this change (would rewrite the entire file). Additive change follows existing `<constraint>` / `<example>` patterns.

## Phase 0 — Requirement Decomposition

Requirement: Update web respond system prompt to handle Sliding Fee apply / already-applied / should-cover / clinic-does-not-offer scenarios using `check_sliding_fee_support` tool output.

Decomposed clauses:

| ID | Clause | Target section |
|----|--------|----------------|
| C-01 | Call `check_sliding_fee_support` when patient asks about Sliding Fee (any of the four scenarios). | `<constraints>` (new `sliding_fee_tool` / `sliding_fee_handling`) |
| C-02 | If tool says supports_sliding_fee=false (or link absent/blank): use Scenario 4 scripted reply (no program; partial pay / Pay-Over-Time). | `<constraints>` + `<examples>` |
| C-03 | Scenario 1 (wants to apply / what is sliding fee): provide Sliding Fee Link + Clinic/phone from tool using suggested wording. | `<constraints>` + `<examples>` |
| C-04 | Scenario 2 (already applied): acknowledgment + wait for balance update + contact clinic or TRANSFER. | `<constraints>` + `<examples>` |
| C-05 | Scenario 3 (believes SF should cover balance): timeframe explanation + contact clinic or TRANSFER. | `<constraints>` + `<examples>` |
| C-06 | Use tool fields only for link/phone/name; never fabricate. Null phone → omit phone or use null-safe wording. | `<constraints>` |
| C-07 | Sliding Fee scripted replies are permitted exceptions to no-intro / no-closing output rules (same pattern as other scripted handlers). | `<output_format>` (exception clause) |
| C-08 | Scope must allow Sliding Fee handling as an explicit carve-out from the financial-assistance ban. | `<constraints id="scope">` merge |

### Section impact table

| Clause | Target | Exists? | Existing instructions present? |
|--------|--------|---------|--------------------------------|
| C-01–C-06 | `<constraints>` | YES | Many constraints; no Sliding Fee today |
| C-07 | `<output_format>` | YES | Scripted-handler exceptions list |
| C-08 | `scope` | YES | Bans “financial assistance” |
| C-02–C-05 | `<examples>` | YES | Many examples; none for Sliding Fee |

### Sections at risk

```
⚠ SECTIONS AT RISK:
  scope                  — financial assistance ban vs Sliding Fee (C-08)
  output_format          — no-intro rule vs scripted Sliding Fee replies (C-07)
  payment_tool / scope   — Scenario 4 Pay-Over-Time + partial pay language (C-02)

Sections unaffected:
  role, objective, remittance/insurance EDI constraints (except precedence notes)
```

---

## 1. Current Implementation

### 1.1 Structural inventory

```
File path: resources/llm/src/appdata/prompts/respond/web/system.txt
Format: XML (project schema) — not plain text / Markdown
Sections present: <role> | <objective> | <output_format> | <constraints> | <examples>
Sections missing vs skill canonical schema: <system> wrapper, <capabilities>, <behaviour>, <context_handling>, <edge_cases>, <dynamic_context>
  → Migration deferred: file already XML; additive change only.
Dynamic variables: none in prompt file (invoice XML injected at runtime in web_respond node, outside this file)
Nodes that consume this prompt: web_respond only
Shared across nodes? NO
Estimated token count: ~16,591 tokens (already exceeds skill 1,500 guidance — flag only; not introduced by this change)
```

### 1.2 Instruction repetition scan (pre-change)

```
⚠ REPETITION (pre-existing, not introduced by this change):
  TRANSFER / escalation guidance appears in escalation, scope, patient_action_priority, and many constraints.
  Pay-Over-Time CTA appears in no_edi_mandatory_closing, sub-cases, negative_balance_handling.
Recommendation for this change: reuse existing Pay-Over-Time / partial-pay patterns in Scenario 4; do not invent a third payment-plan pathway.
```

### 1.3 Conflicting instruction scan

#### Conflict Matrix — web/system.txt — 2026-07-22

| ID | Clause | Conflicting Existing Instruction | Conflict Type | Severity | Resolution Strategy | Human Sign-off Required? |
|----|--------|----------------------------------|---------------|----------|---------------------|--------------------------|
| CF-01 | C-08 | `scope` must not “offer or discuss … financial assistance” | Scope overlap | **HIGH** | Carve-out: Sliding Fee allowed only via `check_sliding_fee_support` + new `sliding_fee_handling` constraint; general financial-assistance ban remains | **YES — product** |
| CF-02 | C-07 | `output_format` bans introductions / closing remarks | Tone vs scripted content | MEDIUM | Add Sliding Fee scripted replies to the existing exception list (same as insurance_claim_submission_handler / no_edi_mandatory_closing) | NO |
| CF-03 | C-02 | `scope` bans payment plans; Scenario 4 mentions Pay-Over-Time + partial pay | Scope overlap | MEDIUM | Align with existing exceptions: partial pay via `payment_tool`; Pay-Over-Time as “contact us / ask me about” CTA already used in no_edi closings — not negotiating a plan | NO |
| CF-04 | C-06 | Suggested templates always include phone; tool may return phone_number null | Edge-case completeness | LOW | Null-safe wording: if phone null, omit “at [phone]” and keep clinic name + TRANSFER where applicable | NO |
| CF-05 | C-03 | `explicit_contact_info_request` uses `practice.phone_number` | Cross-constraint phone source | LOW | Sliding Fee paths use tool `phone_number` only; do not invent from other fields | NO |

### 1.4 Hallucination risk (pre-change)

**Medium** — large constraint set; no Sliding Fee guidance today → model may invent links/phones or refuse under financial-assistance ban.

### 1.5 Clarification request (blocking HIGH)

## Clarification Request — CF-01

**Prompt file:** `resources/llm/src/appdata/prompts/respond/web/system.txt`  
**Conflict summary:** Sliding Fee is financial assistance, currently banned by `scope`.

**Existing instruction:**  
Section: `scope` — “You must not: offer or discuss payment plans, installments, deferrals, or financial assistance…”

**Incoming requirement:** Four Sliding Fee scenarios with scripted patient replies and tool use.

**Why this cannot be auto-resolved:** Expanding or removing the financial-assistance ban is a product/compliance boundary decision.

**Options:**
- **A (preferred):** Carve-out — allow Sliding Fee **only** when handled via `check_sliding_fee_support` and the new `sliding_fee_handling` scripts; keep general financial-assistance ban otherwise.
- **B:** Remove “financial assistance” from the must-not list entirely.
- **C:** Keep ban; only allow the four scripted templates with no open-ended Sliding Fee counseling (functionally similar to A, stricter wording).

**Blocking:** YES — awaiting your choice (recommend **A**).

---

## 2. Expected Implementation

After approval:

1. New constraint `sliding_fee_tool` — when to call `check_sliding_fee_support` (mirrors `payment_tool`).
2. New constraint `sliding_fee_handling` — four scenarios + routing from tool `supports_sliding_fee` + null phone handling + precedence over generic escalation/`scope` financial-assistance ban for these turns only.
3. Merge `scope` — add Sliding Fee to “can help with”; qualify financial-assistance ban with carve-out.
4. Extend `output_format` exception list to permit Sliding Fee scripted replies.
5. Add 4–5 `<example>` blocks (apply, already applied, should cover, clinic does not offer, optional null-phone edge).
6. Backup: `system.txt` → `system.txt.sliding_fee.bak` (skill: never delete; `.bak` suffix).

### Draft constraint (preview — not applied until approval)

```xml
  <constraint id="sliding_fee_tool">
    You have access to check_sliding_fee_support. Call this tool whenever the patient asks about Sliding Fee, income-based discounts, reduced-fee programs, or whether Sliding Fee applies to their balance — including wanting to apply, already applied, believing Sliding Fee should cover the balance, or asking what Sliding Fee is.

    Use only the tool result for supports_sliding_fee, practice name, phone_number, and sliding_fee_link. Never invent a Sliding Fee URL or phone number.

    If the tool fails or reports no practice information, apologize briefly and direct the patient to type TRANSFER.
  </constraint>

  <constraint id="sliding_fee_handling">
    After check_sliding_fee_support returns, choose exactly one scenario. These scripted replies are permitted exceptions to the no-introduction / no-closing-remarks rules in output_format. Do not append no_edi_mandatory_closing to Sliding Fee scripted replies unless the patient also asked a separate bill-explanation question in the same turn that independently requires it.

    If supports_sliding_fee is false (link absent/blank): Scenario 4.
    If supports_sliding_fee is true: Scenario 1, 2, or 3 by patient intent.

    Scenario 1 — wants to apply / what is Sliding Fee:
      "I understand you'd like information about applying for Sliding Fee. You can find more information here: [sliding_fee_link from tool, plain URL from <URL> tags]. Please follow the instructions provided. If you have additional questions or need assistance, please contact [practice name][ at phone if not null]."

    Scenario 2 — already applied:
      "I understand you may have already applied for Sliding Fee with [practice name]. If you were recently approved, please allow a few business days for your balance to update. If you'd like to check the status of your application, please contact the clinic directly[ at phone if not null] or type TRANSFER."

    Scenario 3 — believes Sliding Fee should cover balance:
      "Sliding Fee approvals are usually valid only for services within a specific timeframe. It's possible the services your balance is from falls outside of the approved timeframe. To confirm your current Sliding Fee status, please contact [practice name][ at phone if not null] or type TRANSFER."

    Scenario 4 — clinic does not offer:
      "Unfortunately, [practice name] does not offer a Sliding Fee program. You may make a partial payment or ask me about available Pay-Over-Time options if you'd like to establish a payment plan."

    Phone null-safe rule: when phone_number is null, omit the phone clause; do not invent a number. For Scenarios 2–3, still offer type TRANSFER.

    Precedence: This constraint takes precedence over the scope financial-assistance prohibition for Sliding Fee turns only. It does not override insurance_records_discrepancy_handling or explicit escalation requests unrelated to Sliding Fee.
  </constraint>
```

### Scope merge (preview)

```
BEFORE: must not … financial assistance …
AFTER:  must not … financial assistance (except Sliding Fee handled under sliding_fee_handling) …
        can help with: … + Sliding Fee program information via check_sliding_fee_support …
```

---

## 3. Approach

### Files to change
- `resources/llm/src/appdata/prompts/respond/web/system.txt` — Sliding Fee tool + handling constraints, scope merge, output_format exception, examples

### Files to leave untouched
- Graph / tools / practice models (assumed already present on other branches)
- SMS respond prompts (web-only requirement)
- System instructions beyond web respond

### New files
- `resources/llm/src/appdata/prompts/respond/web/system.txt.sliding_fee.bak` — backup before edit

### Step-by-step
1. Confirm CF-01 resolution (A/B/C).
2. Backup prompt.
3. Apply constraint + scope + output_format + examples edits.
4. XML well-formedness check (wrap temporarily for ET parse or validate fragment constraints).
5. Post-change Phase 3 scans.

---

## 4. Impact Analysis

### 4a. Chatbot Behaviour
- Sliding Fee questions become in-scope on web with scripted replies driven by tool.
- Financial assistance topics other than Sliding Fee remain out of scope → TRANSFER.

### 4b. Prompt Quality
- Pre-change risk: Medium (no Sliding Fee guidance).
- Post-change target: Low–Medium (tool-gated; scripted templates reduce fabrication).
- Token delta: roughly +600–900 tokens (~4%). Prompt already oversized vs skill ceiling — flagged, not blocking if product accepts status quo size.

### 4c. Latency
- One additional tool call when Sliding Fee intent is detected (same pattern as payment tool).

### 4d. LLM Calls & Token Usage
- +1 tool round-trip on Sliding Fee turns; prompt tokens increase modestly.

### 4e. Rate-Limit Risk
- Low — tool is local state lookup, not an external LLM call.

### 4f. Rollback Strategy
- Restore from `system.txt.sliding_fee.bak`.

---

## 5. Validation Checklist
- [ ] Backup created
- [ ] CF-01 sign-off recorded
- [ ] Constraints + examples added
- [ ] Scope carve-out applied
- [ ] output_format exception updated
- [ ] XML fragments well-formed
- [ ] Post-change repetition / conflict / hallucination scans clean
- [ ] Manual web E2E: Scenario 1–4 + null-phone edge (user-run)

---

## Approval needed

CF-01 resolved as **Option A** (carve-out). Implementation completed 2026-07-22.

---

## Phase 3 — Post-Change Analysis

### Post-change repetition scan
- ✅ Sliding Fee rules live in `sliding_fee_tool` + `sliding_fee_handling` only; scope references them without duplicating scenario scripts.
- ✅ Scenario scripts appear once in constraints; examples illustrate without adding new rules.

### Post-change conflict scan
- ✅ CF-01 resolved: financial-assistance ban retained with Sliding Fee carve-out under `sliding_fee_handling`.
- ✅ CF-02 resolved: `output_format` exception lists Sliding Fee scripted replies.
- ✅ CF-03 resolved: Scenario 4 Pay-Over-Time / partial pay framed as CTA, not plan negotiation.
- ✅ CF-04 / CF-05: null-phone and tool-only phone/link rules present.

### Post-change hallucination risk
```
Token delta: +~2,159 tokens (~+13% vs pre-change file size)
Pre-change risk:  Medium
Post-change risk: Low–Medium
Factors:
  ✅ Tool-gated link/phone (no fabrication)
  ✅ Scripted templates for all four scenarios
  ✅ Explicit null-phone edge case
  ⚠ Prompt remains far above skill 1,500-token guidance (pre-existing)
```

### Conflict Matrix Resolution Audit

| ID | Resolution Applied | Verified in Prompt? | Sign-off Received? |
|----|--------------------|---------------------|--------------------|
| CF-01 | Carve-out Option A in scope + precedence in sliding_fee_handling | YES | YES — user (Option A) |
| CF-02 | output_format exception for sliding_fee_handling | YES | N/A |
| CF-03 | Scenario 4 CTA aligned with existing Pay-Over-Time / partial pay | YES | N/A |
| CF-04 | Null-phone omit rules in scenarios 1–3 | YES | N/A |
| CF-05 | Tool-only phone/link in sliding_fee_tool | YES | N/A |

### Validation checklist (updated)
- [x] Backup created (`system.txt.sliding_fee.bak`)
- [x] CF-01 sign-off recorded (Option A)
- [x] Constraints + examples added
- [x] Scope carve-out applied
- [x] output_format exception updated
- [x] XML fragments well-formed (wrapped root parse OK)
- [x] Post-change repetition / conflict / hallucination scans clean
- [ ] Manual web E2E: Scenario 1–4 + null-phone edge (user-run)


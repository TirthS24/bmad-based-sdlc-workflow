# Implementation Plan: Practice Billing Number → In-Scope Contact Reply
_Date: 2026-07-27 | Classification: PROMPT_CHANGE | Status: IMPLEMENTED_

## Codebase Summary

- **Intent router (web)** already has `practice_provider_information` and `billing_department_or_named_practice_contact` for practice phone/email, but does **not** treat “billing number” (owner / company / organization) as a synonym for practice phone. Uncertain classifications prefer `out_of_scope` (instruction §8), which matches the reported misroute.
- **Respond (web)** already has `explicit_contact_info_request`, which returns `practice.phone_number` / `practice.email_address`, but (a) does not list “billing number” phrasing, (b) uses “our office” instead of `[practice.name]`, and (c) does not hard-limit to contact-only (no extra details).
- Practice fields are injected via invoice XML (`practice.name`, `practice.phone_number`, `practice.email_address`) from `invoice_xml/macros.jinja`.
- **SMS** channel uses a different contact pattern (payment-link redirect) — left untouched unless requested.

## Phase 0 — Requirement Analysis

**Requirement:** When a patient asks about the owner/company/organization billing number, route `in_scope` and reply with practice contact fields from input: `You can contact [practice.name] on [practice.phone_number] or [practice.email]`. Preserve existing PHI / personal-info limits; do not add further details.

**Decomposed clauses:**

| Clause | Statement | Target section |
|--------|-----------|----------------|
| C-01 | Treat owner/company/organization “billing number” asks as practice contact → `in_scope` | intent_router `<routes>/<in_scope>` + `<clarification>` |
| C-02 | “Billing number” in that context = practice phone (not patient account/invoice number) | intent_router + respond `<constraints>` |
| C-03 | Reply using `practice.name`, `practice.phone_number`, `practice.email_address` from input | respond `explicit_contact_info_request` |
| C-04 | Do not disclose patient/personal identifiers; answer with contact fields only — no further details | respond `explicit_contact_info_request` + existing `phi_handling` |
| C-05 | When contact + agent-identity signals co-occur (“your company billing number”), contact handling wins | respond + intent_router clarification |

**Section impact table:**

| Clause | Target | Exists? | Existing instructions present? |
|--------|--------|---------|--------------------------------|
| C-01 | intent_router in_scope cases | YES | YES — practice_provider_information, billing_department_or_named_practice_contact |
| C-02 | intent_router + respond | YES | YES — phone examples; no “billing number” synonym |
| C-03 | respond explicit_contact_info_request | YES | YES — different reply template (no practice.name) |
| C-04 | respond phi_handling + contact constraint | YES | YES — PHI minimization already present |
| C-05 | agent_identity vs contact | YES | YES — agent_identity_or_affiliation / agent_identity_affiliation_handling |

**⚠ SECTIONS AT RISK:** intent_router `in_scope` + `clarification`; respond `explicit_contact_info_request`; cross-node with `agent_identity_*`.

---

## 1. Current Implementation

### 1.1 Structural Inventory

| File | Format | Notes |
|------|--------|-------|
| `resources/llm/src/appdata/prompts/intent_router/web/system.txt` | XML-like sections (`role`, `objective`, `routes`, `clarification`, `instructions`) | ~10.5k tokens |
| `resources/llm/src/appdata/prompts/respond/web/system.txt` | XML-like (`role`, `objective`, `output_format`, `constraints`, `examples`) | ~18k tokens |

Dynamic variables used for this change (from invoice XML, not prompt placeholders): `practice.name`, `practice.phone_number`, `practice.email_address`.

Consumers: intent_router node → respond node (web). Shared across nodes? **NO** (separate prompts; coordinated change).

### 1.2 Repetition Scan
- Practice contact appears in both router cases and respond `explicit_contact_info_request` — intentional (route vs answer). No harmful duplication to remove.
- `phi_handling` already covers not echoing patient identifiers.

### 1.3 Conflicting Instruction Scan

| ID | Conflict | Severity | Resolution |
|----|----------|----------|------------|
| CF-01 | `agent_identity_or_affiliation` / `agent_identity_affiliation_handling` treat “company/organization” as identity intro; new requirement treats “company/organization **billing number**” as contact | HIGH | Scope qualifier: if message asks for billing/phone/contact number of owner/company/organization/practice, use contact path — not identity intro |
| CF-02 | Respond template says “You can reach our office at…”; expected is “You can contact [practice.name] on [phone] or [email]” | MEDIUM | Update contact reply templates to include practice.name when available; keep absence fallbacks |
| CF-03 | Router instruction §8 prefers `out_of_scope` when uncertain; “billing number” is ambiguous (account # vs phone) | HIGH | Add clarification case: practice/owner/company/organization “billing number” → in_scope contact; patient “my billing/account number” → do not invent; escalate or decline per PHI |
| CF-04 | PHI: do not return patient personal/account numbers while returning practice contact | LOW | Explicitly scope contact replies to practice fields only; no extra details |

**Human sign-off required?** NO for CF-01–CF-04 (product intent is explicit in the user case). SMS parity deferred (assumed out of scope).

### 1.4 Hallucination Risk (pre-change)
**Medium** for this gap — model may invent phone numbers if contact rule is vague. Existing “Do NOT fabricate” helps; will reinforce.

### 1.5 Conflict Matrix

| ID | Clause | Conflicting Existing | Type | Severity | Strategy | Sign-off? |
|----|--------|----------------------|------|----------|----------|-----------|
| CF-01 | C-05 | agent_identity_* | Cross-intent priority | HIGH | Contact wins when billing/phone/contact number present | NO |
| CF-02 | C-03 | explicit_contact template | Format | MEDIUM | Merge to expected template | NO |
| CF-03 | C-01/C-02 | prefer out_of_scope when uncertain | Scope / ambiguity | HIGH | Clarification + examples | NO |
| CF-04 | C-04 | phi_handling | Scope overlap | LOW | Narrow contact reply; no patient IDs | NO |

---

## 2. Expected Implementation

**Patient:** “What is your owner/company/organization billing number?”  
**Router:** `in_scope`  
**Respond:** `You can contact [practice.name] on [practice.phone_number] or [practice.email_address].`  
(Use whichever of phone/email are present; omit missing channel; if neither present, existing TRANSFER fallback.)  
No patient PHI, no extra education, no identity intro on that turn.

---

## 3. Approach

### Files to change
- `resources/llm/src/appdata/prompts/intent_router/web/system.txt` — expand practice-contact cases + clarification so “billing number” routes `in_scope`
- `resources/llm/src/appdata/prompts/respond/web/system.txt` — expand `explicit_contact_info_request` (synonyms, template with practice.name, minimal reply, precedence over identity)

### Files to leave untouched
- `resources/llm/src/appdata/prompts/out_of_scope/web/system.txt` — no longer receives these turns if router is correct
- SMS prompts — different contact UX (portal link); not requested
- Graph / tools / Python — no graph change; data already in invoice XML

### New files
- None (backup copies with `.bak` per skill during implement)

### Step-by-step implementation order
1. Backup both web prompt files.
2. **intent_router:** Extend `practice_provider_information` and/or `billing_department_or_named_practice_contact` with “billing number” / owner / company / organization examples; add clarification distinguishing practice billing number vs patient account number; note precedence over `agent_identity_or_affiliation` and `unrelated_topics`.
3. **respond:** Update `explicit_contact_info_request` — include billing-number triggers; reply shape with practice.name; contact-only (no further details); precedence over `agent_identity_affiliation_handling` when contact is requested; keep fabricate/absence rules.
4. Add one respond `<example>` for the canonical case.
5. XML well-formedness check + placeholder sanity check.
6. Post-change repetition / conflict / hallucination scans (Phase 3).

### Proposed diffs (preview)

**intent_router — extend `billing_department_or_named_practice_contact` (and/or practice_provider):**
```
BEFORE:
  examples include billing department / practice phone only.

AFTER:
  Also include: "What is your billing number?" / "What is your company billing number?" /
  "What is the organization billing number?" / "What's the owner billing number?" /
  "What is your practice billing phone number?"
  Clarify: these are practice contact requests → in_scope (same family as practice phone).
```

**intent_router — new clarification case:**
```
practice_billing_number_vs_patient_account:
  owner/company/organization/practice "billing number" → in_scope (practice phone/contact).
  "my billing number" / "my account number" / patient invoice number → NOT practice contact;
  do not treat as practice phone (respond/PHI will handle; prefer escalation path only if needed —
  for router: still in_scope only if clearly asking for practice contact; otherwise out_of_scope
  or leave to existing PHI/escalation behavior — prefer: route in_scope for practice contact
  phrasing only; patient-own account number asks → out_of_scope OR in_scope with respond declining).
```

**Preferred router decision for patient-own account number:** `out_of_scope` (or keep existing if any) — product case only covers practice/owner/company billing number. Respond will not invent account numbers regardless.

**respond — `explicit_contact_info_request`:**
```
BEFORE:
  If both present: "You can reach our office at [phone_number] or [email_address]."

AFTER:
  Triggers also include: practice/owner/company/organization "billing number".
  If name + phone + email: "You can contact [practice.name] on [practice.phone_number] or [practice.email_address]."
  If name + phone only / name + email only / phone+email without name: graceful variants.
  Reply with contact fields only — no additional explanation, suggestions, or identity intro.
  Precedence: when contact/billing-number is requested, this constraint overrides agent_identity_affiliation_handling for that turn.
  Do not return patient personal identifiers or account/invoice numbers.
```

---

## 4. Impact Analysis

### 4a. Chatbot Behaviour
- Previously misrouted “company/organization billing number” → out_of_scope redirect.
- After: in_scope + short practice contact reply.
- Identity-only asks (“Who do you work for?”) unchanged.
- Patient “what’s my account number?” remains non-disclosure (PHI).

### 4b. Prompt Quality
- Adds disambiguation; reduces uncertainty-driven out_of_scope.
- Template aligned to product expected wording.
- Token delta: small (~80–150 tokens across both files).

### 4c. Latency
- Negligible (same nodes, no new LLM call).

### 4d. LLM Calls & Token Usage
- No new calls. Slight system-prompt token increase.

### 4e. Rate-Limit Risk
- None.

### 4f. Rollback Strategy
- Restore `.bak` copies of both prompt files.

---

## 5. Validation Checklist
- [x] Prompt XML validates / remains well-formed (wrapped `<system>` parse OK)
- [ ] Manual WS test: “What is your company billing number?” → in_scope + contact template
- [ ] Manual: “Who do you work for?” → still identity intro
- [ ] Manual: “What is my account number?” → no practice phone as substitute; no PHI echo
- [x] Token delta small (~+200–300 across both files); existing prompts already >1500

## 6. Post-Change Prompt Quality (Phase 3)

### Repetition scan
- Practice contact still intentionally split: router routes, respond answers. No harmful duplicate.
- PHI non-disclosure referenced from contact constraint + existing `phi_handling` — complementary, not contradictory.

### Conflict scan
- CF-01 resolved: contact/billing-number takes precedence over agent identity on that turn.
- CF-02 resolved: reply template uses `You can contact [practice.name] on [phone] or [email]`.
- CF-03 resolved: clarification `practice_billing_number_vs_patient_account` + expanded examples.
- CF-04 resolved: contact-only reply; patient account asks excluded.

### Hallucination risk
- Pre: Medium (gap + uncertain → out_of_scope / possible invent).
- Post: Low–Medium — fabricate ban retained; absence fallback retained; explicit field list.

### Conflict Matrix Resolution Audit

| ID | Resolution Applied | Verified in Prompt? | Sign-off |
|----|--------------------|---------------------|----------|
| CF-01 | Precedence + clarification | YES | N/A |
| CF-02 | Template with practice.name | YES | N/A |
| CF-03 | Clarification + examples | YES | N/A |
| CF-04 | Contact-only + PHI exclusions | YES | N/A |

---

## Clarifying Question (one)

1. **SMS parity:** Web is in scope for this plan. SMS currently redirects contact asks to the payment link rather than echoing practice phone/email. Update SMS as well, or web only?

**Assumption if unanswered:** web only.

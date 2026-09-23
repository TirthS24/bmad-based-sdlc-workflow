# Workflow standards

Skills load a section by heading. Do not copy these lists into skill drivers.

## Edge-case checklist

Walk each capability in SPEC.md against this list during grill and feasibility. Mark N/A with a reason.

- Validation: empty, malformed, boundary, type mismatch, duplicate submit
- Errors: user-visible vs operator, retry, timeout, partial failure
- Concurrency: two writers, lost update, idempotent retry
- Idempotency: same request twice, webhook/replay, unique keys
- Auth: unauthenticated, wrong role, cross-tenant, expired session
- Backward compatibility: public API, stored data, clients on old payloads
- Migrations: expand/contract, rollback, default for existing rows
- Observability: no PHI/PII in logs (names, DOB, phones, emails, account identifiers, invoice contents)

## Technical scenario checklist

Use when writing the technical tier of `test-plan.md`. Each scenario gets a layer and an automated / manual / N/A tag.

- UI states: empty, loading, error, success, permission denied
- Contrast states: default, hover, focus, dark (scan after triggering the state)
- API contract: status codes, error body, auth, pagination
- Data: create, update, delete, missing row, stale read
- Robustness: timeout, 5xx from a dependency, invalid payload
- Runtime health: process start, required env missing
- Non-functional: obvious latency cliffs, payload size
- Regression: adjacent screens or routes that share the changed state

## Feasibility rubric

Produce a verdict of `as-is`, `with-changes`, or `not-satisfiable`. Every codebase claim needs a `file:line` reference or an `[ASSUMPTION]` tag.

Cover: coupling, data model, concurrency, auth, API/back-compat, migrations, dependencies, test infra. Offer 2–3 approaches with blast radius and a recommendation. State whether the work fits one commit or needs a split.

## Review rubric

Four axes. Tag each finding `low` / `medium` / `high` / `decision-needed`.

- Standards: [.cursor/rules/](../.cursor/rules/) (`backend-rules-md.mdc`, `frontend-rules-md.mdc`)
- Spec conformance: SPEC.md `REQ-n` capabilities
- Approach conformance: the Gate 1 approved option in approach.md only
- Test quality: frozen tests still name `REQ` / `TECH` ids; no silent deletes of failing cases

`high` and `decision-needed` block `review` → `verify`. `decision-needed` is copied into the Gate 2 report.

## Coding rules

Do not duplicate the repo standards here. Implementers read:

- [.cursor/rules/backend-rules-md.mdc](../.cursor/rules/backend-rules-md.mdc) for Python
- [.cursor/rules/frontend-rules-md.mdc](../.cursor/rules/frontend-rules-md.mdc) for TypeScript and React

Stay inside the approved approach blast radius. Do not edit frozen test globs. Do not log PHI/PII.

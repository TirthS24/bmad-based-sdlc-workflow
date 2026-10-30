# Workflow standards

Skills load a section by heading. Do not copy these lists into skill drivers.

## Edge-case checklist

Walk each capability in SRS.md against this list during planning and feasibility. Mark N/A with a reason.

- Validation: empty, malformed, boundary, type mismatch, duplicate submit
- Errors: user-visible vs operator, retry, timeout, partial failure
- Concurrency: two writers, lost update, idempotent retry
- Idempotency: same request twice, webhook/replay, unique keys
- Auth: unauthenticated, wrong role, cross-tenant, expired session
- Backward compatibility: public API, stored data, clients on old payloads
- Migrations: expand/contract, rollback, default for existing rows
- Observability: no PHI/PII in logs (names, DOB, phones, emails, account identifiers, invoice contents)

## Technical scenario checklist

Use when writing `test_cases` on ticket acceptance criteria (and the technical tier in the `tests` stage). Each scenario gets a layer and an automated / manual / N/A tag.

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

- Standards: the rule files from `wf init --rules`, plus any project rules the harness loads
- Spec conformance: SRS.md `REQ-n` capabilities
- Approach conformance: the option approved at `gate_approach` in approach.md only
- Test quality: frozen tests still name `REQ` / `TECH` ids; no silent deletes of failing cases

An open `high` finding blocks `done review`; it goes back to the implementer. `decision-needed` items stay in `review.md` for the human to decide at `gate_review`.

## Coding rules

Rule files are listed by `node .agent-workflow/wf.mjs init --rules`: the shipped `rules/generic.md` plus every stack pack a human has approved. Read those, and any project-specific rules your harness loads for the files you touch. Do not copy their content into skills or agents.

Stay inside the approved approach blast radius. Do not edit frozen test globs. Do not log PHI/PII.

## Research rubric

Opt-in. Run it only when the interview shows an unknown market, competitor, standard, regulation or technology.

- Output is `specs/spec-<id>/research.md`, at most two pages.
- Three labelled groups: **Sourced** (claim, URL, access date), **Inferred** (claim, the reasoning), **Unknown** (what could not be found).
- A claim with no URL goes under Inferred or Unknown, never Sourced.
- Cover only what the open questions need: comparable products, relevant standards or regulations, known pitfalls. No survey for its own sake.
- Never put internal data, customer names, PHI/PII or secrets in a search query or in the notes.
- End with "Effect on the spec": the requirements or non-goals this research changes.

## Ingestion rubric

Used by the requirements ingestor at the start of planning.

- Read the human ask, connected MCPs (Confluence, Slack, Jira when available) and repo docs under the project.
- Output `draft-requirements.md`: interpreted scope, related context, a **Sources** list (links and repo paths), and known gaps.
- Do not invent facts. Mark uncertainty explicitly.
- Never put PHI/PII or secrets in queries, notes or the draft.

## Grilling rubric

Used by the requirements griller each round.

- One focused question at a time, with concrete `options[]` (multi-select allowed when useful).
- Tie each question to at least one `REQ-n` via `req_refs`.
- Stop the round when there are no new material questions.
- Questions are JSON objects; the orchestrator persists `grill/questions.json`.

## Synthesis rubric

Used by the requirements synthesizer after each grill round.

- Answer only from Confluence pages (URLs containing `/wiki/` or `atlassian.net`) and repo file paths that exist.
- Every answer cites one or more allowed sources, or returns `UNANSWERABLE` with `searched[]`.
- Slack-only or Jira-only mentions without Confluence/repo backing are `UNANSWERABLE` (orchestrator escalates to the human).
- Never guess or blend uncited inference into an answer.

## SRS format

The srs-writer produces `SRS.md` with these numbered sections:

1. **Introduction** — purpose, scope, definitions, references.
2. **Overall description** — product perspective, user classes/personas, operating environment, constraints, assumptions and dependencies.
3. **Functional requirements** — bullets `- **REQ-n** title` with `intent:`, `success:`, `priority:`, `source:` (Q-id or doc link).
4. **External interfaces** — UI, API, integrations.
5. **Non-functional** — performance, security and privacy, reliability, accessibility.
6. **Non-goals** — explicit out-of-scope items.
7. **Traceability** — map each `REQ-n` to question ids and/or source links.

No `[OPEN QUESTION]` markers remain when planning finishes.

## Ticket format

Persona tickets live at `tickets/<persona>/<TKT-id>.json`. Required fields and enums are enforced by `wf tickets check`.

Example:

```json
{
  "id": "TKT-BE-001",
  "persona": "be",
  "title": "Payment capture API",
  "purpose": "Persist authorized charges",
  "description": "Expose POST /payments aligned to REQ-2",
  "priority": "P0",
  "requirements": ["REQ-2"],
  "depends_on": ["TKT-UX-001"],
  "acceptance_criteria": [
    {
      "id": "AC-1",
      "text": "Authorized payment is stored idempotently",
      "test_cases": [
        {
          "id": "PRD-2.1",
          "title": "Duplicate client ref returns same payment id",
          "given": "a valid card and client reference",
          "when": "the client submits the same reference twice",
          "then": "one payment row exists and both responses share its id",
          "layer": "api",
          "automation": "automated"
        }
      ]
    }
  ],
  "external": { "jira_key": null }
}
```

Product scenarios use `PRD-n.m` where `n` matches the REQ number. Technical scenarios may use `TECH-*`. Each acceptance criterion needs at least one test case before `done planning`.

## Persona tickets

Split work across four personas under `tickets/`:

- **ui_ux** — flows, layout, accessibility, empty/error states visible to users.
- **fe** — client behaviour, routing, forms, API integration from the browser.
- **be** — APIs, persistence, auth, idempotency, background jobs.
- **qa** — cross-cutting verification, data setup, manual-only checks where automation is `manual` or `n/a`.

Every `REQ-n` in `SRS.md` must appear on at least one ticket and on at least one automated `PRD-n.m` test case where the requirement is user-visible. Dependencies use `depends_on` ticket ids only (no fictional ids).

## Spec quality

Checked before `done planning`.

- Every capability is `REQ-n` with an intent and a testable success line in `SRS.md`.
- A **Non-goals** section exists, even if short.
- No `[OPEN QUESTION]` marker is left.
- Each capability can be turned into a pass/fail check without asking the author. Reword vague success lines ("fast", "easy").
- Users and permissions are named for every capability that touches data.
- Anything the research changed is reflected, with a pointer to it.

## Architecture decision record

`approach.md` keeps the Feasibility rubric format and adds these, in this order after the approaches:

- **Decision** (two lines at most): the chosen approach and the one reason it won. This is what gets copied into the PR.
- **Non-functional notes**: performance, security and privacy, availability, cost. One line each, or "N/A" with a reason.
- **Risks**: what could go wrong and how it would be noticed.
- **Rollback**: how to undo the change, and what cannot be undone.

## Security and privacy lens

Applied by the architect and the reviewer when the change touches auth, user data, files, network calls or logging.

- Who can call this? Check authentication and authorisation on the server side, not only the UI.
- What data moves, where is it stored, who can read it? Mark anything that could be PHI/PII.
- Input: injection, path traversal, unsafe deserialisation, oversized payloads.
- Secrets: none in code, logs, fixtures or error messages.
- Third parties: what leaves the system, and is it allowed to?

## Data and migration lens

Applied when the change touches a schema, stored data or a public payload.

- Expand, deploy, contract. No step breaks the previous release.
- Existing rows: default, backfill, and how long the backfill takes.
- Rollback: is the migration reversible, and is data lost if it is reversed?
- Old clients and old stored payloads still work, or the break is stated and approved.

## Dependency policy

- Default is no new dependency. A proposal names what it replaces, size, licence, last release and who maintains it.
- A new dependency is a `decision-needed` item for the human at the next gate.

## Review finding format

`review.md` has one section per axis (Standards, Spec conformance, Approach conformance, Test quality). Each finding is one bullet:

`- [severity] path:line - what is wrong - what to change`

Severity is `low`, `medium`, `high` or `decision-needed`. Write `open: 0` under an axis with no findings. On a later round, keep a fixed finding's bullet and add `[resolved]` after the severity: `- [high][resolved] path:line - ...`. Only that tag closes a finding; prose elsewhere in the file does not. The reviewer reports only, and fixes go back to the implementer.

## PR summary guide

For the person reviewing the pull request, in plain language.

- Say what changed and why, grouped by area, in a short paragraph or a few bullets.
- No file lists, no code, no ticket history.
- Name anything a reviewer must check by hand, and any behaviour a user will notice.
- Note a docs or changelog update if user-visible behaviour changed.

## Playwright conventions

Product (flow) tests are Playwright scripts under `product_test_globs` (default `E2E/tests/**`). They are written from the spec and approach before any implementation, and frozen at `gate_tests`.

- One test per automated product scenario (`PRD-n.m` tagged `e2e`, `ui` or `api`). The title starts with its ids: `PRD-1.1 REQ-1 <what the user sees>`.
- Test through the UI or API the user would use. Do not import application code.
- Locators: role, label or `data-testid`. No CSS chains, no `nth` guesses, no fixed sleeps. Wait on a condition.
- Each test creates the data it needs and does not depend on another test's order.
- Test data is made up. Never real PHI/PII, tokens or production accounts.
- Red for the right reason: before implementation a test fails on the missing behaviour, not on a crash, a bad locator or the app being down.
- `retries: 1` in the Playwright config. A test that passes only on retry is flaky: it is reported, not hidden.
- The app is started by the config's `webServer` option. Seed data uses `commands.seed`.
- Unit tests are not written here. The implementer owns them.

## Gate brief format

Written for a human who has not read the artifact. At most 15 lines, plain language.

- **What this is:** one sentence.
- **Since last time:** what changed, or "first version". If the gate was rejected before, say how the reason was addressed.
- **Decide:** the specific choices or risks the human must weigh, as questions. Include `decision-needed` items.
- **Watch:** anything odd in the facts (open questions, assumptions, flaky tests, skipped checks, a new dependency).
- Use only numbers from `wf brief`. Do not recommend approval.

---
name: wf-playwright-e2e
description: "Pipeline stage: tests or verify. Run only when `wf status` says the stage is tests or verify."
---

## Required reading before acting

- `.agent-workflow/standards.md` heading "Playwright conventions"
- `.agent-workflow/config.json` (`product_test_globs`, `commands.e2e`, `commands.seed`, `dev_url`)
- `specs/spec-<run-id>/SRS.md` and persona tickets (product-tier `test_cases`)

## Writing (stage `tests`)

One Playwright test per automated `PRD-n.m` scenario tagged `e2e`, `ui` or `api`. The test title starts with its ids: `PRD-1.1 REQ-1 user sees the greeting`. The stage check and the verify report both match on those ids. Write only under `product_test_globs`. Use role and `data-testid` locators, never CSS chains. Each test sets up its own data.

Tests must be red for the right reason: they fail on the missing behaviour, not on a crash, a bad locator or the app being down. Run `node .agent-workflow/wf.mjs verify` and read the failure before returning.

## Running (stages `implement` and `verify`)

`commands.e2e` should be `npx playwright test --reporter=list,json`. `wf` sets `PLAYWRIGHT_JSON_OUTPUT_NAME`, so the JSON report lands in `runs/<id>/evidence/` and is mapped back to ids. Start the app with Playwright's `webServer` option in `playwright.config.ts`, not by hand. Put `retries: 1` in the config: a test that passes only on retry is reported as flaky and does not block, but it is listed in `e2e-summary.md` for the human.

Seed data goes in `commands.seed`. It runs before the e2e command and a failure fails the tier.

## Not here

Exploratory browser or MCP testing is optional and harness-specific. Do not use it to replace a failing scripted test.

# Phase 2 manual test: Playwright product tests, red then green

Uses `examples/sample-app` (one Playwright test for a `/greeting` page the app does not have yet). Runs in a scratch copy so the real repo is untouched. Needs Node 20+ and network for the first install.

```bash
S=$(mktemp -d) && cp -R examples/sample-app/. $S && mkdir $S/.agent-workflow
cp -R .agent-workflow/{wf.mjs,lib,adapters,workflow.json,config.json,bmad-allowlist.json} $S/.agent-workflow/
cd $S && printf 'node_modules/\ntest-results/\n.agent-workflow/state.json\n.agent-workflow/events.jsonl\n.agent-workflow/runs/\n' > .gitignore
git init -q && git add -A && git commit -qm init
npm install && npx playwright install chromium
```

Set `commands.e2e` to `npx playwright test --reporter=list,json` and `src_globs` to `["server.js"]` in `.agent-workflow/config.json`, then:

| Step | Command | Expect |
| --- | --- | --- |
| 1 | `node .agent-workflow/wf.mjs run greeting` | run starts on branch `wf/greeting-...` |
| 2 | write `specs/spec-<id>/SPEC.md` (one `REQ-1`) and `test-plan.md` with `- PRD-1.1 REQ-1 greeting page (e2e, automated)` | |
| 3 | set stage `tests` (edit `state.json`; this is a shortcut for the real stages), then `wf done tests --result E2E/tests` | accepted: the test is red and cites `PRD-1.1` |
| 4 | `wf approve gate_tests` | stage `implement` |
| 5 | edit `E2E/tests/greeting.spec.ts` (a hook-aware harness denies it) | denied: frozen, `product_test_globs` |
| 6 | `wf done implement` | refused: `e2e failed (exit 1)` |
| 7 | add a `/greeting` route returning `<h1>Hello</h1>` to `server.js`, then `wf done implement` | accepted |
| 8 | set stage `verify`, then `wf done verify` | accepted; `runs/<id>/evidence/e2e-summary.md` lists the test as passed |

This was run once by hand against Playwright 1.49.1 and Chromium. Automated coverage uses a fake Playwright that writes the same JSON shape (`test/phase2.test.mjs`).

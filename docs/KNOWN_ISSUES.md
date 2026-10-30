# Known issues

Found while writing the Phase 0 characterization suite. Not fixed in Phase 0 (rule N-5); each names the phase that owns it. The tests currently pin the existing behaviour.

| # | Issue | Where | Owner |
|---|---|---|---|
| 1 | ~~Next-action text and the `pr` stage still describe Gerrit~~ | | fixed in Phase 1 |
| 2 | ~~`implement` and `review` stages write to a hardcoded `src/**`~~ now `src_globs` in `config.json` | | fixed in Phase 1 |
| 3 | ~~Only two gates; rejection left no record~~ six gates, `wf reject`, `state.rejections` | | fixed in Phase 1 |
| 4 | ~~`freezeHash` covered all `test_globs`, freezing unit tests with product tests~~ now `product_test_globs` only; `unit_test_globs` belong to the implementer | | fixed in Phase 2 |
| 5 | ~~`checkReviewToVerify` passed on "resolved"/"fixed"/"closed" or `open: 0` anywhere in the file~~ now judged per finding line; only `[resolved]` closes one | | fixed in Phase 1B |
| 6 | `status --check` uses `loop_caps.implement \|\| 5` while `guardStop` uses `?? 5`, so a cap of 0 behaves differently in the two | `lib/commands.mjs`, `lib/guards.mjs` | fixed in Phase 1 (both use `?? 5`) |
| 7 | `die()` and `process.exit` are called from deep inside command and check code, so these paths cannot be unit-tested without a subprocess | `lib/commands.mjs`, `lib/io.mjs` | Phase 3 |
| 8 | Events record no duration, user, or error class | `lib/io.mjs` (`appendEvent`) | Phase 3 |
| 11 | ~~When a loop cap or stuck-loop stop escalates, `status --check` fails and no command lets the human retry, reject or abort~~ now `wf escalation list/retry/reject/abort` | | fixed in Phase 1B |
| 12 | ~~The code review runs on the same main thread that coordinated the implementation~~ now the `code-reviewer` agent | | fixed in Phase 1B |

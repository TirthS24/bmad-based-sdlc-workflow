# Baseline

The point of a baseline is to know what a run normally costs, so that a prompt or rule change that quietly weakens a stage shows up as a number moving.

## Two kinds of runs

**Scripted (in the repo, runs in CI).** `server/test/baseline.test.mjs` drives the real `wf` CLI through all fourteen stages five times with stub artifacts: three clean runs (one with a gate rejection), one that hits the implement loop cap and is retried by hand, and one that is aborted after a guard block and an agent failure. It syncs to a real server and asserts that the dashboard's totals equal what the clients recorded locally, and that at least three runs finish with no manual fix. It proves the telemetry path. It says nothing about LLM time or cost, because the agents are stubs.

**Real (needs your sample app and specs).** Not done yet: the plan lists the sample app and the five specs as open items.

## Recording a real baseline

1. Pick the sample app and five specs of different sizes. Install the workflow into a clean copy per run (`node installer/install.mjs --target <dir> --harness <h> --server <url>`), then `wf login`, `wf init`, `/wf-onboard`.
2. Run each spec from `/wf-run` to the PR with a human at each gate. Do not intervene inside implement.
3. `wf sync` after each run, then read the dashboard: **Time per stage**, **Errors**, **Gates**, **Agents and retries**, and the run's drill-down.
4. Record per stage: median time, retries, errors, gate wait; per run: completed or not, manual fixes needed, token cost (from the harness's own usage page; the workflow does not capture cost).
5. Save the table in this file under the date, the harness and the model.

Success for the baseline is five runs recorded and at least three completing with no manual fix.

## Using it

After changing a prompt, rule pack, skill or agent, repeat the same five specs and compare against the saved table. A stage that got slower, retried more or errored more is the signal to look at.

## Recorded runs

None yet.

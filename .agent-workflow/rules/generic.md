# Generic rules

Apply to every stack. A stack pack (`rules/<stack>.md`) adds to these and never relaxes them. Where a pack and this file disagree, the stricter one wins.

## Scope
- Change only what the approved approach names. Anything else you notice goes in `deferred.md`.
- Match the surrounding code: naming, comment density, error handling, file layout.
- Prefer reusing an existing helper over writing a new one. Search before you add.

## Safety
- Never log, print, commit or put into fixtures real PHI, PII or secrets. Use made-up data.
- Validate input at trust boundaries (HTTP, files, queues, CLI). Do not validate between internal functions.
- Handle errors where you can act on them. Do not swallow an error to keep a test green.

## Dependencies
- Ask before adding one. State what it replaces, its size, licence and maintenance state.
- Use the standard library or an already-installed dependency first.

## Data and migrations
- Schema changes are expand then contract, and reversible. Existing rows get a default.
- Never run a destructive statement against shared data from a workflow run.

## Tests
- A unit test names the requirement id it covers (`REQ-n`, `TECH-…`) where one applies.
- Do not edit, skip or delete a frozen product test to make it pass.
- No sleeps to hide a race. Wait on a condition.

## Commits
- Small commits that say why. No unrelated formatting changes.

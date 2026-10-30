# TypeScript and React rules

Adds to `generic.md`. Match the project's ESLint and Prettier configuration first.

## Code
- `strict` types. No `any` without a comment saying why. Prefer `unknown` plus narrowing at boundaries.
- Function components and hooks. Clean up effects (listeners, timers, subscriptions). Complete dependency arrays.
- Keep state as local as it can be. Fetch server data with the project's existing data layer; do not add a second one.
- Lists use stable keys, never the array index for data that can reorder.
- No `dangerouslySetInnerHTML` with unsanitised input. No secrets in client code or `NEXT_PUBLIC_`-style variables.

## Accessibility
- Interactive elements are real buttons and links, reachable by keyboard, with visible focus.
- Inputs have labels. Images have alt text. Do not rely on colour alone.

## Tests
- Testing Library: query by role or label, assert what the user sees. Use `data-testid` only when no role fits.
- Name the requirement id in the test title (`REQ-1`).

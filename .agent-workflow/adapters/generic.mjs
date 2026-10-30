// Fallback for harnesses without usable hooks. Nothing intercepts tool calls, so enforcement
// moves to git hooks and CI (`wf gate-check`, `wf ci-check`), and runs are recorded as
// session_unchecked because the core never sees tool content.
import * as cursor from './cursor.mjs';

export const capabilities = { contentHooks: false };
export const { normalize, render, renderStatus } = cursor;

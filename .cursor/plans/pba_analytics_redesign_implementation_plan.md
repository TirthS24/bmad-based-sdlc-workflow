# PBA Analytics Redesign — Implementation Plan for AI Coding Agent

**Scope:** Frontend-only rebuild of the PBA Analytics PoC, delivered at a new route (`/pba-analytics`) alongside the existing `/`, `/current-backlog`, `/insights-center`, so the current implementation stays live and comparable during review. No backend/API contract changes — reuse existing FastAPI endpoints and response shapes as-is unless a field is genuinely missing (flag, don't invent).

**Agent operating mode:** Work in phases, in order. Do not start a phase until the previous phase's acceptance checklist passes. Commit at the end of each phase with a message matching the phase name. If an existing API response doesn't contain a field this plan assumes exists, stop and report it rather than mocking data.

---

## Phase 0 — Environment & Routing Setup

**Goal:** New surface exists, is isolated, and serves a blank shell without touching existing routes.

1. Add a new FastAPI route group mounted at `/pba-analytics` (and `/pba-analytics/current-backlog`, `/pba-analytics/insights-center` as sub-routes) that serves a **separate static bundle** — do not reuse or modify the existing `main.css` / `tokens.css` / existing JS files in place. Copy them into a new directory (e.g. `/static/pba-analytics/`) as the starting point.
2. Confirm existing routes (`/`, `/current-backlog`, `/insights-center`) are byte-for-byte unaffected — no shared file edits in this phase.
3. Verify the new route resolves and can successfully call the existing data endpoints (reuse existing fetch/query logic; just point the new frontend at the same API).

**Acceptance checklist**
- [ ] `/pba-analytics` loads a blank/placeholder page with no console errors
- [ ] Existing three routes render unchanged (visual diff or manual check)
- [ ] Network tab confirms new page hits the existing data API successfully

---

## Phase 1 — Design Tokens & Chart Primitive Library

**Goal:** Build the shared visual language before any section is built, so every subsequent phase consumes the same primitives instead of writing one-off D3 per chart.

### 1.1 Tokens
Create `pba-analytics/tokens.css` (fork of existing, trimmed):
- Single sequential color scale (magnitude/intensity — used for heatmap, single-series bars)
- Single categorical scale capped at **8 colors** + explicit "Other/muted-gray" fallback (replaces the 50-color practice palette and the per-intent palette)
- Keep the dark clinical background/surface tokens from the existing implementation
- Spacing/typography scale for: headline number (largest), section header, chart label, table cell (smallest)

### 1.2 D3 chart primitive modules
Build these as standalone, reusable modules (one file each, consistent prop interface: `data`, `width`, `height`, `colorScale`, `onHover`, `onClick`):

| Module | Replaces |
|---|---|
| `line-chart.js` | Multi-line Session Volume (kept as-is) |
| `bar-horizontal-ranked.js` | Sessions by Practice donut, Escalation by Practice bars, Top Intents bars |
| `bar-grouped.js` | Escalations vs Sessions, Escalation & Resolution by Channel, Channel Volume |
| `heatmap.js` | Session Initialization Heatmap (kept as-is) |
| `funnel.js` | Overview node-link bubble/tree diagram |
| `big-number-sparkline.js` | Escalation Resolution Rate gauge, all KPI tiles |
| `table-inline-bars.js` | Velocity triple-panel matrix, Repeat Patients dual-panel, backlog aging table |
| `stacked-dual-panel.js` | Correlated Payments dual-axis line (replacement: two stacked panels sharing x-axis, not shared y-axis) |

Each module gets an isolated dev harness (a single `component-gallery.html` page listing all 8 with sample data) so the agent — and reviewers — can sanity-check each primitive before wiring it into real sections.

**Acceptance checklist**
- [ ] `component-gallery.html` renders all 8 primitives with realistic mock data, keyboard/hover states work
- [ ] No primitive references more than 8 categorical colors
- [ ] Tokens file has zero hardcoded hex values outside itself (everything else references CSS vars)

---

## Phase 2 — Page Shell & Section Template

**Goal:** Build the reusable section layout (answer row → headline chart → supporting strip → collapsible drill-down table) and global chrome, with no real data logic yet.

1. Build `SectionTemplate` component: accepts `answerText`, `headlineChart` (slot), `supportingTiles[]` (slot array), `drilldownTable` (slot, collapsed by default).
2. Build global chrome: sticky filter bar (date range, practice, min escalations, Apply), in-page section nav, links to Backlog/Insights Center — can port existing filter logic/markup, just restyle to new tokens.
3. Build the **practice drill-down mechanic** as a shared interaction: selecting a practice from the filter bar puts *every* section into "this practice vs average" mode via a shared state/store, replacing the current per-chart click→modal pattern.
4. Wire up card-level states: loading skeleton, empty state copy, error state — one implementation reused everywhere, not per-card.

**Acceptance checklist**
- [ ] Filter bar functional (date/practice/min-escalations state updates, Apply triggers refetch)
- [ ] Selecting a practice updates a shared state visible to a test consumer section
- [ ] Loading/empty/error states each demonstrable via a manual test toggle

---

## Phase 3 — Main Dashboard Sections (`/pba-analytics`)

Build in this order — each is a vertical slice (data fetch → section template → primitives → acceptance check) before moving to the next.

### 3.1 Overview
- Answer row: auto-generated sentence from KPI deltas (e.g. templated string: "{escalation_pct}% escalation rate, {delta} vs prior period")
- Headline: `funnel.js` — Sessions → AI-handled → Escalated → Resolved, segmented by channel (Web/SMS/SMS→Web) as funnel segment colors
- Supporting strip: KPI tiles using `big-number-sparkline.js` (sessions, AI-handled %, escalation %, resolution %)
- No drill-down table needed for this section

### 3.2 Demand
- Headline: `line-chart.js` — Session Volume (SMS/Web/SMS→Web daily) — kept as-is visually, just retokenized
- Supporting strip: `bar-horizontal-ranked.js` for Sessions by Practice (replaces donut — top 10 + "Others" grouped)
- Second supporting tile: `heatmap.js` — Session Initialization Heatmap, kept as-is
- Drill-down table: raw daily session counts by channel/practice, sortable

### 3.3 Staffing
- Headline: `bar-grouped.js` — Escalations vs Sessions per day, **shaded "normal range" band instead of dashed average line** (compute band as ±1 std-dev or existing avg ± threshold if available from API; confirm field exists before implementing — flag if not)
- Supporting strip: `big-number-sparkline.js` for Escalation Resolution Rate (replaces gauge), `bar-grouped.js` for Channel Volume, `bar-grouped.js` for Escalation & Resolution by Channel
- Drill-down table: `table-inline-bars.js` — one row per practice, columns = escalated count / queue wait hrs / handle time min, each with inline bar, sortable by any column (replaces triple-panel matrix)
- Also fold in "Messages: Before Escalation vs To Resolution" as two more sortable columns in the same table rather than a separate horizontal bar pair, if the data is at the same practice grain — otherwise keep as a small supporting tile using `bar-horizontal-ranked.js`

### 3.4 Quality
- Answer row absorbs the 100% share bar (state the on/off-topic split as text: "{pct}% of chats were billing-related")
- Headline: `bar-grouped.js` — On-topic vs Off-topic daily, with shaded band replacing the avg reference line
- Supporting strip: `bar-horizontal-ranked.js` — Top Summary Classifications by Intent

### 3.5 Practices
- Headline: `bar-horizontal-ranked.js` — Escalation by Practice; clicking a bar sets the shared "selected practice" state (Phase 2) instead of opening a bespoke modal — surface the same intent breakdown + CSV export as a side panel/drawer reusing the drill-down table pattern, not a new modal component
- Supporting strip: `table-inline-bars.js` for Repeat Patients (visit frequency + return-gap buckets as two inline-bar columns per practice, not two separate bar panels)
- `stacked-dual-panel.js` for Correlated Payments (payments/day and web sessions/day as two stacked mini-charts sharing an x-axis, not dual y-axes)

**Acceptance checklist (per section, repeat for 3.1–3.5)**
- [ ] Section renders with live API data, matches existing implementation's numbers (spot-check 3 data points against current `/` page)
- [ ] Practice-select drill-down mode works (chart switches to "this vs average" comparison)
- [ ] Drill-down table sortable, CSV export works where applicable
- [ ] No console errors, loading/empty states verified with a throttled/empty API response

---

## Phase 4 — Current Backlog (`/pba-analytics/current-backlog`)

**Goal:** Rebuild as a status board, not a mini dashboard — different template from Phase 2's `SectionTemplate`.

1. Build a separate `BoardTemplate`: big "open now" number top-left, SLA-breach color coding, no chart-card grid.
2. "Now": KPI strip via `big-number-sparkline.js` (open count, stale %)
3. "Mix": aging as `table-inline-bars.js` (age bucket, count, % — sorted oldest-first, red/amber/green by SLA threshold if such a threshold exists in the API/config; flag if not defined anywhere and needs product input) + practice share as a compact ranked list (plain sorted list with inline bar, not a chart card)
4. "Topics": if backend still returns placeholder/sample data, **do not render the card** — show nothing or a minimal "not yet available" text line, no fabricated sample bars
5. "Velocity": reuse `table-inline-bars.js` from Phase 3.3 Staffing (same component, different data source — don't rebuild)

**Acceptance checklist**
- [ ] Page ignores date-range filter (practice filter only), confirmed by testing filter bar is absent/disabled for date
- [ ] SLA color coding renders correctly against at least one aged and one fresh test record
- [ ] "Topics" section does not render fabricated sample data under any state

---

## Phase 5 — Insights Center (`/pba-analytics/insights-center`)

**Goal:** Rebuild as a narrative deck, structurally different from the dashboard — one chart type per slide, headline-first.

1. Build `SlideTemplate`: large headline text slot (stated conclusion, not a question), single chart slot (one primitive only), 1-2 supporting numbers slot, minimal chrome.
2. Rewrite each slide's headline copy from question-framing to conclusion-framing, driven by the same data used to compute the answer-row text in Phase 3 (reuse that templating logic, don't duplicate it):

   | Slide | New headline pattern | Chart |
   |---|---|---|
   | 1 | "{N} sessions this period, {delta} vs prior" | 4-tile KPI grid (kept) |
   | 2 | "{pct}% of escalations resolved" | Before/after bar pair (replaces dual donuts) |
   | 3 | "{Channel} drives {pct}% of new sessions" | `bar-grouped.js` (kept, simplified to top channel call-out) |
   | 4 | "Escalations {rising/flat} relative to demand" | `bar-grouped.js` with shaded band (same component as dashboard) |
   | 5 | "{practice} has the slowest resolution time" | Single ranked bar (top-3 only, not full matrix) |
   | 6 | "{pct}% of patients return within {N} days" | Single `bar-horizontal-ranked.js` panel (not dual grouped) |
   | 7 | "{practice} carries {pct}% of volume and {pct}% of escalations" | Single combined ranked bar (top 3, not 4 panels) |
   | 8 | "{pct}% of chats were billing-related" | Single before/after bar pair |
   | 9 | "{top intent} was the most common topic" | Single ranked bar, top 5 only |
   | 10 | Kept as-is (text synthesis, no chart) | — |
3. Keep celestial background/transitions as chrome only — confirm no chart ever renders on top of decorative motifs in a way that reduces legibility (contrast check).
4. Rewire PDF/PPTX export to the new simplified single-chart-per-slide DOM (should be equal or less complex than existing export since there's less per-slide markup).

**Acceptance checklist**
- [ ] All 10 slides render with live data, auto-advance timing unchanged from current implementation
- [ ] PDF export produces a legible, correctly-paginated file matching on-screen slide order
- [ ] PPTX export opens cleanly in PowerPoint/Keynote with charts as static images (no broken layout)
- [ ] Manual pause/prev/next controls function

---

## Phase 6 — Cross-Cutting QA & Handoff

1. Full manual pass comparing every metric on `/pba-analytics` (and sub-routes) against the equivalent value on the existing `/`, `/current-backlog`, `/insights-center` — numbers must match; only presentation should differ.
2. Accessibility pass: color contrast on the trimmed 8-color categorical scale, keyboard navigation through filter bar and drill-down table sort controls.
3. Performance check: confirm no primitive re-renders the full chart on every filter keystroke (debounce filter inputs if not already handled).
4. Remove the Phase 1 `component-gallery.html` dev harness from the production build (or gate it behind a `?dev=1` query param) before calling this done.
5. Write a short README in `/static/pba-analytics/` documenting the 8 chart primitives and the section template contract, so future sections/slides can be added without reintroducing one-off chart code.

**Acceptance checklist**
- [ ] Side-by-side number audit complete, discrepancies logged and resolved or explicitly flagged
- [ ] Accessibility pass complete
- [ ] Dev harness removed/gated
- [ ] README committed

---

## Explicit non-goals for this agent

- No changes to backend routes, database queries, or response schemas
- No modification of the existing `/`, `/current-backlog`, `/insights-center` files
- No new chart libraries beyond D3 (already available) — no Chart.js/Plotly/Recharts additions
- No fabricated/sample data rendered in any production state — if a data field doesn't exist, the section renders empty/flagged rather than mocked

## Open questions to flag back to product/design before Phase 3.3 and Phase 4

- Does the API expose a computed "normal range" or std-dev for escalations/day, or does the agent need to compute it client-side from the daily series?
- Is there a defined SLA threshold (hours) for backlog aging color-coding, or does this need a product decision?
- Is the "Topics" backlog data genuinely unavailable, or is there a real endpoint being under-used?
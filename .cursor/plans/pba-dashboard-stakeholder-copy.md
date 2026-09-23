# Dashboard Specification

**Dashboard name:** PatriotPay PBA Analytics PoC
**Owner:** PBA analytics / product
**Date:** 2026-08-05
**Status:** Built (stakeholder-copy revision)

---

## Purpose

**Primary question this dashboard answers:**
How is PBA demand flowing by entry path, and how often do chats stay AI Handled versus need staff?

**Primary audience:** Ops / CX leads (non-technical)
**Secondary audience:** Product + leadership
**Usage frequency:** Weekly / Ad-hoc

---

## Metrics

| Metric | Definition | Source table | Owner | Refresh | Acceptable lag |
|---|---|---|---|---|---|
| All sessions | Non-draft chats in filters | agent_conversation | PBA | On load | Live DB |
| AI Handled rate | Share of chats with no staff handoff | agent_conversation | PBA | On load | Live DB |
| SMS originated | SMS-only + SMS→Web migrated | agent_conversation | PBA | On load | Live DB |
| Web originated | CHAT_WINDOW starts | agent_conversation | PBA | On load | Live DB |
| SMS→Web migrated | SMS_TO_CHAT with sms_to_chat_at | agent_conversation | PBA | On load | Live DB |
| Correlated payments | Paid payments same patient+day as web-path touch | payments + sessions | PBA | On load | Live DB |

---

## Layout specification

### Page 1: PBA Analytics PoC

**Primary question:** Demand, containment (AI Handled), and handoff health

| Position | Chart type | Metric | Notes |
|---|---|---|---|
| Header strip | KPI cards | All / AI Handled / Escalation / Resolution / channel rates | (i) = tooltip |
| Hero | Snapshot | Entry path + status | AI Handled label |
| Supporting | Dual-axis line | Correlated payments | Separate payment vs session scales |

**Sticky filters:** date_from, date_to, practice_id

---

## Interactivity

| Feature | Required | Notes |
|---|---|---|
| Date range filter | Yes | Default last 30 days |
| Practice filter | Yes | Optional |
| Info (i) | Yes | Tooltip only (no modal) |
| Enlarge chart | Yes | Side pane |
| Dual Y-axis (payments) | Yes | Clarity when magnitudes differ |

---

## Acceptance criteria

- [x] Chart cards show stakeholder “what this shows” descriptions
- [x] (i) uses tooltip with brief “how we count it” in layman language
- [x] AI Only → AI Handled
- [x] Channel KPIs: SMS originated / Web originated / SMS→Web migrated
- [x] SMS originated count includes SMS→Web migrated
- [x] Correlated Payments uses separate payment scale

---

*Template: dashboard_spec_template.md*

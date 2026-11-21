# LEDGER — S1-0 System-One config surface (PR #442)

Status: plan authored and T3-reviewed (one Opus rung, 2026-11-21, verdict
REQUEST CHANGES, all findings folded). Implementation NOT started — gated on
Kurt's plan approval.

## What's in flight

Nothing. Awaiting controller review of the converged plan; coding is the next
phase.

## Tasks

- [ ] T0 — Ledger setup (this file)
- [ ] T1 — Config namespace and types (spec §1, §10)
- [ ] T2 — Resolvers and warn-once helper (spec §2, §3)
- [ ] T3 — MaintenanceService wiring: chain, floor, question, sentinel, reserve (spec §2, §3, §5)
- [ ] T4 — Outcome mapping: abstain, routing, escalation, counters (spec §4, §5)
- [ ] T5 — Receipts (spec §6, §7) — PRE-FLIGHT C1 before dispatch
- [ ] T6 — Typing joins runPendingMaintenance (spec §8) — PRE-FLIGHT C3 before dispatch
- [ ] T7 — Docs and release note (spec Files-touched, §8)
- [ ] T8 — Compatibility lock verification (spec §9)

## Pre-flight log

- C1/C3 (PR #441 state): not yet run — run before T5 and T6 dispatch.
- C4 controller confirmation (#441 plan adopts write-path framing): pending.
- C3 controller confirmation (one PR carries scheduler machinery): pending.

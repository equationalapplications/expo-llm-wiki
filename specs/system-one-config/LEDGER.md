# LEDGER — S1-0 System-One config surface (PR #442)

Status: implementation LANDED on PR #442 (T1-T8 through the T8 compatibility
commit; review-adjudication fixes followed). Plan authored and T3-reviewed (one
Opus rung, 2026-11-21, verdict REQUEST CHANGES, all findings folded). Spec
Status stays APPROVED until the cleanup commit (ship-time lifecycle step, plan
Final step) — the flip is scheduled, not missing.

## What's in flight

CodeRabbit review adjudication (round 2, current head): real findings fixed
test-first (safe warning formatter, escalation live-mode check, scheduler
deadline re-checks, spec §4/§5/§9 delta-4 documentation), stale ledger text
corrected here. Full core suite green locally before push. Task boxes below are
ticked only where the landed tree carries the verifying tests, per house rule.

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

- C1/C3 (PR #441 state): resolved by ruling, not by a run — the controller
  decree (plan.md, Controller decree section, decree 1) makes S1-0 own the
  scheduler machinery unconditionally; #441 executes its flip clause.
- C4 controller confirmation (#441 plan adopts write-path framing): ruled —
  reserved-slug enforcement is write-path-only (decree C4), implemented and
  tested (spec §5, sentinel-rejection tests).
- C3 controller confirmation (one PR carries scheduler machinery): ruled as
  above (decree 1).

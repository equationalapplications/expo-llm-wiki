# LEDGER — expire() (spec r5)

One checkbox per plan task. Tick only after that task's verification passes.

- [x] T1 — widen the error type (`WikiSupersedeReason` + verb param, AC8) — `fa155b9d`, controller-verified 2026-11-18
- [x] T2 — `expire()` + facade, happy path (AC1, AC3, AC6) — `d13e793e`, controller-verified 2026-11-18
- [x] T3 — guard stack + guard order (AC2) — `f345e6f0`, controller-verified 2026-11-18
- [x] T4 — interval validation (AC3) — `454a6c15`, controller-verified 2026-11-18
- [x] T5 — supersede-after-expire guard (D3b, AC2b) — `96f405ef`, controller-verified 2026-11-18
- [x] T6 — outbox, events, search, prune (AC4, AC5, AC7) — `8f73690c`, controller-verified 2026-11-18 (3 test-side folds: options under `config`; AC5 pinned behaviorally — FTS retains non-deleted rows by design, liveness is query-time)
- [x] T7 — INTENT sentence, docs, supersede-gap issue (D1 note, D5, D7, AC9) — `7331676d`, controller-verified 2026-11-18 (issue = #414, filed by controller; docs build green)
- [ ] T8 — full gate (typecheck, build, tests, docs build)

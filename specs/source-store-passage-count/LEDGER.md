# LEDGER — source-store-passage-count (PR #490)

In flight: plan review (Tier-3 Opus loop) — no implementation tasks started.
Spec: Reviewed (owner-approved 2026-11-28, msg `1576081158758998158`).

- [ ] T1 hoist `listStoredSourcesSql(prefix)` builder + EQP pin test (RED evidence recorded)
- [ ] T2 correlate on `document_id` (GREEN + full `sourceStoreRead` suite green)
- [ ] T3 file-backed performance guard test (2,000 docs × 3 passages < 500 ms; measured time recorded)
- [ ] T4 gates: `pnpm build`, `pnpm exec tsc --noEmit`, root `pnpm test`
- [ ] T5 final probe numbers into spec Errata; cleanup commit (Status → Implemented, plan/LEDGER deleted) before `gh pr ready`

Reconciliation rule (specs/README.md): a box ticks only after its
verification passes, as a step of the implementation loop.

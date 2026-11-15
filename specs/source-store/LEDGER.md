# LEDGER — source store (single-PR lane, PR #396)

Spec: `specs/source-store/spec.md` (head at plan-write: `11e62583`).
Plan: `specs/source-store/plan.md`. Baseline logs:
`.superpowers/sdd/source-store/` (gitignored scratch, absolute path
`/home/kv-thinkpad-t420-ubuntu/code/github/equationalapplications/expo-llm-wiki/.superpowers/sdd/source-store/`).

**Baseline:** in flight at plan commit (`pnpm install --frozen-lockfile` +
`pnpm test` full suite, first run of this lane). Counts recorded below
when green.

**In flight:** nothing dispatched yet — Task 1 brief next.

## Tasks

- [ ] T1 schema + migration v17 (§3; test items 2–3)
- [ ] T2 `store` OperationType + conflict matrix (§10, §7; item 7)
- [ ] T3 sha256 hasher + diagnostic codes (§3, §9)
- [ ] T4 store write path — SourceStoreService + Maintenance deletes (§5, §7, §9; items 4, 7)
- [ ] T5 store read paths + listSourceRefs three-state (§4; items 4, 6)
- [ ] T6 passage index, both strategies (§6; item 5)
- [ ] T7 `sources` read option + offsets/hard-cut (§7; items 4–5)
- [ ] T8 dump import/export + skippedSources (§8; item 8)
- [ ] T9 WikiMemory wiring + formatContext (§7; items 1, 5–6)
- [ ] T10 INTENT rule 5 reword (§1) — controller-applied (protection hook)
- [ ] T11 full-suite sweep + cleanup commit (Status → Implemented, delete plan/LEDGER, roadmap mark)

## Run record

- 2026-11-15 lane pivoted to SINGLE-PR delivery (owner msgs
  `1571548310672769026` / `1571548355681853451`): spec merges together
  with implementation on this branch; ready-flip and cleanup commit are
  last. PR was briefly ready; converted back to draft.
- Deviations: none yet.

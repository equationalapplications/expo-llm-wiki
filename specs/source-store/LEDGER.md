# LEDGER — source store (single-PR lane, PR #396)

Spec: `specs/source-store/spec.md` (head at plan-write: `11e62583`).
Plan: `specs/source-store/plan.md`. Baseline logs:
`.superpowers/sdd/source-store/` (gitignored scratch, absolute path
`/home/kv-thinkpad-t420-ubuntu/code/github/equationalapplications/expo-llm-wiki/.superpowers/sdd/source-store/`).

**Baseline:** GREEN (2026-11-15, run2 after clearing a stale shared
`node_modules/.vitest-cache` — ENOTEMPTY race, environment not code):
`pnpm test` full suite EXIT=0, 286 test files passed / 286, **3253 tests
passed / 3253**, zero failures. Log:
`.superpowers/sdd/source-store/baseline-test-run2.log`. Install:
`pnpm install --frozen-lockfile` clean.

**In flight:** T1 dispatched (Claude Code sonnet/low, brief
`.superpowers/sdd/source-store/briefs/t1.md`, runner `run-task.sh 1`,
announce ≈$0.60 hard cap $0.90).

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

# Ledger: #318 measurements

In flight: waiting on the owner's F8 ruling.

- [x] Harness rebuilt: `bench/issue280/`, commit `cfd58998`.
- [x] All legs verified on 10k rows: smoke run 2026-11-09.
- [x] 1M legs: `bench/issue280/results/*-1000000.json`.
- [x] 4.2M rows, 14.8 GB: `bench/issue280/results/*-4200000.json`.
- [x] 1.333M rows, 4.7 GB: `bench/issue280/results/*-1333000.json`.
- [x] Reclamation rule applied: bounded (spec §2.1); no gate variant built.
- [x] Results recorded: README, spec, #280 Status revision.
- [ ] F8 ruling (owner).
- [ ] Final cleanup: flip Status, delete `plan.md` and this file, mark ready.

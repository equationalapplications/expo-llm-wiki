# LEDGER — GoatCounter analytics tag

What's in flight: spec rev 7 Reviewed (Kurt-approved 2026-11-06); implementation starting per plan.md.

- [ ] Task 1 — vendor count.js (sha256 + upstream diff evidence)
- [ ] Task 2 — astro.config.mjs head entries (build 0 + presence/ordering greps)
- [ ] Task 3 — test.yml CI guard step (script runs green on dist + fails on stripped copy)
- [ ] Task 4 — pre-merge local probe (get_data().p === host + pathname, no /count request)
- [ ] Task 5 — internal review ladder converged (SoR → Haiku → Opus) + independent reviewer pass
- [ ] Task 6 — cleanup commit (status → Implemented, plan/LEDGER deleted), PR ready, bots + CI green, Kurt merge go
- [ ] Task 7 — post-merge checks (24 h window, blocker-free profile, revert-first on failure)

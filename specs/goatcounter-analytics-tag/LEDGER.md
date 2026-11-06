# LEDGER — GoatCounter analytics tag

What's in flight: spec rev 7 Reviewed (Kurt-approved 2026-11-06); implementation starting per plan.md.

- [x] Task 1 — vendor count.js (sha256 `030ad75a…` OK; diff-empty vs upstream v2.7.0 tag clone; commit `c9f45b8a`)
- [x] Task 2 — astro.config.mjs head entries (build EXIT=0, 51/51 pages presence+ordering, token file clean, `dist/count.js` hash matches; commit `51a2b7b3`)
- [x] Task 3 — test.yml CI guard step (positive: 51/51 + sha OK; negative: stripped dist copy FAILS as expected; commit pending push)
- [x] Task 4 — pre-merge local probe (astro preview :4329 under base: `get_data().p === "localhost:4329/expo-llm-wiki/"` === host+pathname `pMatches:true`; statsRequests=[] — no /count, localhost filter held; vendored src same-origin; inline config present)
- [ ] Task 5 — internal review ladder converged (SoR → Haiku → Opus) + independent reviewer pass
- [ ] Task 6 — cleanup commit (status → Implemented, plan/LEDGER deleted), PR ready, bots + CI green, Kurt merge go
- [ ] Task 7 — post-merge checks (24 h window, blocker-free profile, revert-first on failure)

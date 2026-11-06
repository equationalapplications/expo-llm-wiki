# LEDGER — GoatCounter analytics tag

What's in flight: implementation commits done (Tasks 1-4); branch rebased to reword feat→chore (npm-release BLOCKER fix, Haiku xhigh); Opus rung done (REQUEST CHANGES 2M/5m) → guard hardened (exact-tag src+endpoint check, 6 self-test fixtures, fileURLToPath+crypto, import-safe) and spec rev 8 folds the drift. Next: Opus delta on the incremental diff, independent reviewer pass, Kurt flag on rev 8, then cleanup/ready.

- [x] Task 1 — vendor count.js (sha256 `030ad75a…` OK; diff-empty vs upstream v2.7.0 tag clone; commit `dfa40f19`, reworded feat→chore to avoid an npm release trigger)
- [x] Task 2 — astro.config.mjs head entries (build EXIT=0, 51/51 pages presence+ordering, token file clean, `dist/count.js` hash matches; commit `ff9ee05b`, reworded feat→chore)
- [x] Task 3 — test.yml CI guard step (positive: 51/51 + sha OK; negative: stripped dist copy and hash-tamper probes both FAIL as designed; hardened into `apps/docs/scripts/check-goatcounter.mjs` with self-test fixtures, tagged `vendored-sha256:` pin, dist-asset sha check, fail-closed on zero pages; commit `f98bb1a6` + hardening `16964812`)
- [x] Task 4 — pre-merge local probe (astro preview :4329 under base: `get_data().p === "localhost:4329/expo-llm-wiki/"` === host+pathname `pMatches:true`; statsRequests=[] — no /count, localhost filter held; vendored src same-origin; inline config present)
- [ ] Task 5 — internal review ladder converged (SoR → Haiku → Opus) + independent reviewer pass
- [ ] Task 6 — cleanup commit (status → Implemented, plan/LEDGER deleted), PR ready, bots + CI green, Kurt merge go
- [ ] Task 7 — post-merge checks (24 h window, blocker-free profile, revert-first on failure)

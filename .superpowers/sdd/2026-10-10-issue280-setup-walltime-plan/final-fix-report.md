# Final-review fix wave: PR-B #280

Code commit: `02e9fc2` fix(core): FTS rebuild progress, retired-table reclaim, probe bounds (#280 final review)

## Fixes and covering tests (red shown before each fix)

| Item | Fix | Covering test | Red before fix |
|---|---|---|---|
| I1 | `Fts5IndexStrategy.progressUnchanged` re-reads state + `readRebuildProgress(meta, tx)` inside every window and sweep tx; on mismatch the window returns `'stale'`, the quantum skips the sweep, and the next quantum re-reads. `runWindow` now returns `'more' \| 'done' \| 'stale'`. | fts5Vacuum.test.ts "a VACUUM restart between two window transactions of one quantum is not overwritten (final review I1)": triggers off, 1500 rows at rowid 100001+, then between window tx 1 and 2 it compacts the rowids by -100000 and calls `restartRebuildAfterVacuum`. Asserts live + exactly-once. | `expected [ ...(498) ] to deeply equal [ ...(1498) ]` (flipped live with 500/1500 indexed) |
| I2a | `reclaimRetired`: a corruption-class error (`ftsCorruptionClass`) from `reclaimStep` causes DROP + delist. If the DROP throws a SQLite error, the table is delisted without the drop. | fts5RenameRetire "a corrupt retired table is dropped and delisted..." and "...whose DROP also fails is still delisted" (the second also asserts no re-read on the next drain) | `expected [ 'llm_wiki_entries_fts_retired_1' ] to deeply equal []` (both) |
| I2b | `fullQuantum` catch swallows only `isSqliteError(err)` (new, exported, Proxy-safe: code `SQLITE_*` or an `Error code N:` message). Everything else propagates. | "a non-SQLite error from reclamation propagates..." + "isSqliteError is Proxy-safe..." | `promise resolved "undefined" instead of rejecting` |
| I3 | Test only | fts5StateMachineIntegration "content that only windows can deliver..." covers: all triggers dropped; 600 new rows; a new soft-deleted row; an indexed row updated, another soft-deleted, another hard-deleted (orphan map row); empty ledger; marker deleted; converge. Asserts exactly-once, no map rows for r5/r20/wdel, 601 walnut hits, N-3 cedar hits. | With `windowChunkSql` temporarily emptied (restored, no diff): only this test fails, `expected [ ...(2399) ] to deeply equal [ ...(2998) ]`. The other 3 B7 cases pass, which confirms they were vacuous. |
| M1 | Live-row probe is now `SELECT 1 FROM (SELECT deleted_at FROM entries ORDER BY rowid DESC LIMIT 500) WHERE deleted_at IS NULL LIMIT 1` | fts5StateMachine "live-row probe is bounded..." (2 tests: SQL shape on an all-soft-deleted store that stays live; detection still fires with one live row among the newest) | probe-shape assertion failed |
| B5 | Pinned `ids` to `['fact_1','old_1']`, length 2. The pin exposed a real duplicate (`fact_1` passed twice in replace mode), so `ImportExportService` now dedupes with a Set. | ImportExportService.test.ts replace-mode test | `expected [ 'fact_1', 'fact_1', 'old_1' ] ...` |
| B6 | fts5Vacuum test 2 tightened: asserts a stale pre-renumber wm, clears the ledger (a real VACUUM fires no triggers), then exactly `{rowid:0,id:null}`, `snapshot.entries === 101500`, cursor `'0'` | same | n/a (tightened; the restart comes from B3, so it does not go red without B6. The I1 test is the B6-adjacent guard.) |
| B1 | setupBudget test: `monotonicNow` mocked so that every read advances 1s; asserts `0 < pending < 3000` after one open, then converges | setupBudget.test.ts | n/a (determinism) |
| B3 nits | fts5Sql.test.ts closing brace on its own line; removed the double blank line in fts5Rebuild.test.ts | — | — |

## Notes / concerns
- Spec conflict (M1): spec rev 11e, transition table, names the probe `deleted_at IS NULL LIMIT 1` (unbounded). The bounded probe follows the every-open rule, as instructed. The trade-off: a lost index on a store whose newest 500 rows are all soft-deleted is not detected. This needs an append-only spec revision (a separate commit); I have not made one.
- One existing test was changed: in "a failing reclamation DELETE never fails drain()", the injected error is now `{code:'SQLITE_LOCKED'}` instead of a bare `Error('locked')`. Its assertions are unchanged. A bare Error is now deliberately treated as a bug and propagates (I2b).
- A progress change from an engine hard-delete re-anchor (`reanchorRebuildFingerprint`) also ends the quantum early as `'stale'`. That is harmless: the next quantum resumes.
- Flake: the first full-suite run failed `runPendingMaintenance.test.ts > deadline outranks budget_exhausted` (timing, untouched file). It passed 3/3 in isolation and on stash, and the full rerun was clean.

## Commands and outputs
- `pnpm --filter @equationalapplications/core-llm-wiki test` gave `Test Files 184 passed (184)`, `Tests 1979 passed (1979)`
- `pnpm --filter @equationalapplications/core-llm-wiki typecheck` gave `tsc --noEmit` clean
- `pnpm -r build` succeeded (`packages/expo build: Done`)
- The closing-keyword grep and the `^BREAKING CHANGE` grep over `git log main..HEAD` both printed nothing

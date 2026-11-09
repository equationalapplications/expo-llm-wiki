# FTS retired-table reclamation: measurements and the hand-off rule (#318)

**Status:** Draft (2026-11-09). Measurements done, no engine code changed. F8 waits on the owner.
**Branch:** `feat/issue318-fts-measurements`
**Source baseline:** `65d9318b` (main after PR #338)
**Issue:** #318, the deferred remainder of #280
**Intent check:** INTENT rule 11 ("Benchmarks gate behavior changes") and rule 6 ("Honest reporting"): this cycle replaces extrapolated claims with measurements and states what remains unmeasured. Rule 10: the #280 spec's Status gets an appended revision. No contradiction with INTENT. No retrieval or maintenance behavior changes.

**Delivery:** one PR, draft until the owner rules on F8, per `specs/README.md`. Commit types are `test` and `docs`, so nothing releases.

---

## 1. Problem

The #280 spec shipped rename-retire reclamation inside the writer lease on a promise it never checked. Spec lines 596-605 require a measurement at 1M rows: if the final DROP after reclamation stays near the original 22.3 s, reclamation must hand off to the migration gate instead, because a 22 s DROP inside the lease breaks the 15 s fence. #318 also records that Acceptance 4 and 6 were never measured, that the harness existed only in pruned scratch, and that F8 convergence had no decision.

## 2. Evidence

Harness: `bench/issue280/`. Raw results: `bench/issue280/results/`. The machine and its limits are in that README. Nothing here is comparable to the investigation's NVMe rows or the ARM64 target.

### 2.1 The reclamation rule (B8)

One full-size retired table at 1M rows, on the shipped code path:

| Step | Count | Median | Max |
|---|---|---|---|
| RENAME tx | 1 | 8.6 ms | 8.6 ms |
| Delete, 500 rows | 2,000 | 47 ms | 251 ms |
| Merge, 500 pages | 35 | 49 ms | 64 ms |
| **Final DROP** | 1 | **333 ms** | 333 ms |

Dropping the same full-size table without reclamation took 14,100 ms on this machine, so reclamation cut the DROP about 42-fold. The largest rebuild window in the same run was 273 ms, and 690 ms in the window leg.

**Conclusion: bounded.** The final DROP is far below the floor and the same order as one chunk. Under the rule in spec lines 600-605 and plan B8 Step 3, reclamation stays in-quantum.

**The third `PendingMigrationWork` variant, the gate probe and the out-of-lease DROP are therefore not built.** Spec line 98 says PR-B "adds a third variant". Its own conditional rule at lines 600-605 and plan finding F1 ("nothing ships in the gate until B8") make that contingent on this measurement, and #318 §1 names the same trigger. The test `'until B8 decides hand-off, retired tables are not pending migration work'` already pins the shipped behavior and stays correct.

### 2.2 Acceptance 4: steady-state fence

Opens of a `live` store, warm and after SIGKILL with 5,000 updates in the WAL:

| Store | Warm max of 5 | After crash |
|---|---|---|
| 1M rows, 3.5 GB | 51 ms | 1.7 s |
| 1.333M rows, 4.7 GB | 12 ms | 1.6 s |
| 4.2M rows, 14.8 GB | 61 ms | 1.8 s |

All inside 15 s. The crash figure is the one-quantum drain of the 1,500 ms default budget, so it does not grow with the store. Cold opens are not measured.

### 2.3 Acceptance 6: first-migration open

The store is simulated from a current one: `schema_version` set to 13, stamp removed, the partial index and both `fts_pending` indexes dropped.

| Store | Open | Largest tx |
|---|---|---|
| 1.333M rows, 4.7 GB (the criterion's size) | **101.1 s** | 268 ms |
| 4.2M rows, 14.8 GB (the criterion's row count) | **258.6 s** | 632 ms |

The spec's scaling assumed 1.12 GB per 1M rows, and this generator's rows come to 3.5 GB per 1M. At the 4.7 GB the criterion names, the result is inside 240 s. At 14.8 GB it misses 240 s by 18.6 s; that store is 3.2 times the criterion's size. Nothing was tuned in response. Under `migrations: 'refuse'` this open never runs in the lease: the gate tripped in 1.2-1.7 ms at every size and left the stamp absent. Every chunk commit stayed under 1 s.

A8's rate: normalize at 1M took 79.8 s, 13,788 rows/s, largest tx 320 ms.

### 2.4 F8: convergence after marker loss

Measured at 1M rows with the default 1,500 ms budget: **170 quanta to `live`**, 270 s of wall time, 11.8 windows per quantum, quantum wall median 1,566 ms and max 2,006 ms. That is inside the ≤ 3.5 s claim of Acceptance 2.

#318 predicted 1,000-2,000 quanta from two assumptions. The first, window speed, depends on the machine. Windows here took a median 123 ms, against the issue's 733-1,010 ms. At that slower speed the same arithmetic gives 1-2 windows per quantum and so 1,000-2,000 quanta. That range is an extrapolation, not a measurement.

The second assumption does not hold. Plan finding F8 said the sweep's limit of one 500-row transaction per quantum would gate convergence at about 2,000 quanta. Each window re-inserts its `fts_map` rows with new `fts_rowid` values above the snapshot, so rows the windows have passed leave the sweep's range, and the sweep's cursor jumps across the gaps. It took 171 sweep transactions, none of them over 32 ms. Windows gate convergence, not the sweep.

**Owner decision (not made here):** is this convergence acceptable? **Recommendation: accept, with no chunk or budget change.** Total work is about 2,000 windows whatever the quantum count, each window stays well inside the fence, and a smaller quantum count needs a longer lease hold. What a host should weigh is how often it calls `syncSearchIndex()`, since convergence time is quanta multiplied by that interval.

## 3. Proposed change

No engine change. This cycle commits the harness and results, records the conclusions, and appends a revision to the #280 spec's Status.

## 4. Files touched

- `bench/issue280/`: harness, README, raw results.
- `specs/fts-retired-tables/`: this cycle.
- `docs/superpowers/specs/2026-10-10-issue280-setup-walltime-design.md`: appended Status revision.

## 5. Test plan

No code path changes, so there are no new tests. Each leg was first run on a 10k-row store. The full suite stays as it is on main.

## 6. Not measured

- Cold-cache opens: `sudo purge` isn't available to the run.
- The ARM64 target and the original 52.9 MB store: maintainer-only under plan A8 Step 4. Commands are in the README.
- Acceptance 5's 1M-row crash backlog.
- `window` and `reclaim` above 1M rows, including a retired table bigger than 1M.
- A store genuinely written by an old engine.
- SynapseTree host-contract sign-off: plan B8 Step 5 forbids recording it without the maintainer's confirmation.

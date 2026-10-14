# bench/issue280 — B8 measurement harness (issue #280)

Measures the shipped B-track open path (`Fts5IndexStrategy.init()` /
`drain()`) against generated stores at scale. Built for plan Task B8 per the
A8 harness rules: stores under `ISSUE280_STORE_DIR` (never `/tmp` — tmpfs
undercounts disk cost 2–3×), never commit a `.db`, record the machine.

## Scripts

- **`makeStore.ts`** — engine-shaped store generator (raw better-sqlite3).
  `--rows N --out <name>.db [--bulk] [--wal-checkpoint]`. Explicit rowids;
  FTS triggers are created **after** the data load, exactly like a converged
  engine store (so `init()`'s intact-check passes on the fast path).
- **`profileSetup.ts`** — drives the engine's own path (`setupDatabase` →
  serialized adapter → `Fts5IndexStrategy.init()`/`drain()`).
  `--store <path> [--budget 1500] [--leg all|open|window|reclaim] [--json <out>]`.
  Reset is forced via tokenizer mismatch (the B4 test recipe scaled up):
  `entries_fts` is swapped to plain `unicode61` behind the engine's back;
  `init()` rename-retires it and rebuilds from 0.
- **`run-b8-1m.sh`** — the @1M leg script (two fresh stores; the legs mutate
  the store).

## Results — @1M rows (2026-10-14, run 1)

Machine: ThinkPad T420, i5-2410M (2 cores / 4 threads, 2.3 GHz), 7 GB RAM,
SATA SSD. Node v24.21.0, better-sqlite3 13.0.3, engine v7.13.0 (PR #284
B-track). Budget: `setupBudgetMs` 1500 ms. Store: 1,000,000 rows, 518.8 MB
pre-leg, 775.7 MB post-leg.

| Phase | Result |
|---|---|
| init, converged store (steady state) | **2.8 ms**, state stays `live` |
| init-reset-rearm (rename-retire, one tx) | 2.34 s (window store) / 0.17 s (reclaim store, post-window) |
| window drain to `live` | **31.9 s**, 22 quanta, avg quantum 1.53 s, max 1.66 s |
| reclaim drain to empty retired list | **29.1 s**, 35 quanta, avg 1.51 s |
| convergence | `live`, ledger 0, counts 1M/1M/1M/0; reclaim leg additionally retires `[]` |

Verification at 10k/12k rows preceded the run: every leg converged in a
single quantum.

### Decision inputs

- **Reclamation rule (plan Step 3 / F1):** reclamation stays **in-quantum**.
  The whole reclaim leg (windows + reclamation of a 1M-row retired table)
  finished in 35 budgeted quanta (~29 s); every quantum respected the 1500 ms
  budget. The final DROP happens on an already-emptied table (bounded), and
  no hand-off via `PendingMigrationWork` is warranted — `probePendingWork`
  keeps returning `null` for retired tables.
- **`FTS5_SWEEP_CHUNK = 500`** (F8) did not gate convergence — windows
  dominate. **`FTS5_RECLAIM_MERGE_PAGES = 500`** (F13) performed untuned.

### Deviations from the plan's Step-1 recipes

- The `window` leg used the tokenizer-mismatch reset (the `reclaim` recipe)
  instead of marker loss (deleting the `fts5_index_state` row). The window
  rate — the quantity being measured — is unaffected: windows dominate both
  flavors after re-arm.
- Reclamation is timed in aggregate (whole quanta), not per step type
  (delete-chunk / merge / final DROP). Per-step instrumentation can be added
  if a future leg needs it.

### Scope waivers (maintainer, 2026-10-14)

Kurt ruled this run **satisfies B8's measurement step**: the 4.7 GB NVMe legs
(Acceptance 4/5/6) and the ARM64 leg are waived as follow-ups, not gates.
Raw JSON of this run lived in the (24h-pruned) Hermes scratch; the numbers
above are the durable copy, mirrored in the spec's rev 12 entry and the
equational-wiki session record `records/sessions/2026-10-14-issue280-b8-1m-evaluation.md`.

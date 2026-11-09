# issue280 `setup()` and FTS benchmarks

Local SQLite measurements for the #280 setup wall-time work and its follow-up #318.
No leg calls an LLM or spends tokens: the provider is a stub.

## Run it

```sh
pnpm install --frozen-lockfile
pnpm -r build                       # legs import packages/core/dist
bash bench/issue280/runAll.sh       # every leg; about 1 hour and 40 GB free
```

One store and chosen legs:

```sh
bash bench/issue280/run.sh 1000000 bench/issue280/results warm crash normalize gate window reclaim:15000
```

Stores go under `ISSUE280_STORE_DIR` (default `$HOME/issue280-stores`). Don't point it at
tmpfs: it undercounts disk cost. The harness refuses any path that isn't an `issue280-*.db`
under that directory, and every leg works on a copy. Delete the stores when finished. Never
commit a `.db` file.

| Leg | What it times |
|---|---|
| `warm` | Five opens of a live store. Cold variant needs `sudo purge` and is skipped without it |
| `crash` | Open after SIGKILL with 5,000 updates still in the WAL and the ledger |
| `normalize` | Open after the normalize stamp is removed (the A8 rate) |
| `gate` | `setup({ migrations: 'refuse' })` tripping on pending work |
| `migration` | First open of a simulated v13 store: stamp removed, three indexes dropped |
| `window` | Marker loss, then scheduled `syncSearchIndex()` calls until `live` (B8 and F8) |
| `reclaim` | Tokenizer reset, then RENAME, delete, merge and final DROP steps (B8) |

## Results (2026-11-09)

Raw output is in `results/`. Machine: Intel i7-8559U (8 threads), 16 GB, APFS on PCIe SSD,
Darwin x64, Node 24.22.1, SQLite 3.53.4 from better-sqlite3 13.0.3, WAL. Other workspace jobs
ran during the runs (load average up to about 8). These numbers are not comparable to the
investigation's NVMe ThinkPad rows or to the ARM64 target.

Row size: this generator comes to 3.5 GB per 1M rows, not the investigation's 1.12 GB. So gate
scale is reported two ways: 1.333M rows matches the 4.7 GB file size, and 4.2M rows (14.8 GB)
matches the row count.

| Measurement | Scale | Result | Target |
|---|---|---|---|
| Rename-retire tx | 1M | 8.6 ms | |
| Reclaim delete step (500 rows) | 1M | 2,000 steps, median 47 ms, max 251 ms | |
| Reclaim merge step | 1M | 35 steps, median 49 ms, max 64 ms | |
| **Final DROP after reclamation** | 1M | **333 ms** | Much less than the full DROP, same order as one chunk |
| Full-size DROP, same machine | 1M | 14,100 ms (spec's machine: 22.3 s) | Baseline |
| Keep-map window tx | 1M | median 123 ms, max 690 ms | |
| Quantum wall during rebuild | 1M | median 1,566 ms, max 2,006 ms | ≤ 3.5 s |
| **Quanta to `live` (F8)** | 1M | **170** (270 s wall, 11.8 windows per quantum) | Owner decision |
| Normalize (A8) | 1M | 79.8 s, 13,788 rows/s, max tx 320 ms | Records the rate |
| Gate trip | 1M / 4.7 GB / 14.8 GB | 1.2 / 1.4 / 1.7 ms, stamp untouched | Much less than 1 s |
| Warm open, median | 1M / 4.7 GB / 14.8 GB | 3.3 / 2.3 / 2.8 ms | ≤ 1 s |
| Warm open, max of 5 | 1M / 4.7 GB / 14.8 GB | 51 / 12 / 61 ms | ≤ 15 s fence |
| Open after crash | 1M / 4.7 GB / 14.8 GB | 1.7 / 1.6 / 1.8 s | ≤ 15 s fence |
| **First-migration open** | 4.7 GB | **101.1 s**, max tx 268 ms | ≤ 240 s |
| **First-migration open** | 14.8 GB | **258.6 s**, max tx 632 ms | ≤ 240 s at 4.7 GB; 3.2 times that size |
| Cold open | | Not measured: needs `sudo purge` | ≤ 3 s |

Reclaim used a 15 s budget per quantum to shorten the run. Per-step times don't depend on the
budget, only how many steps fit in a quantum.

## Not measured here

- Cold-cache opens (no sudo).
- The ARM64 target and the original 52.9 MB store. To run it there: `pnpm -r build`, copy that
  store to `$HOME/issue280-stores/issue280-528.db`, then
  `node bench/issue280/profileSetup.ts --store $HOME/issue280-stores/issue280-528.db --leg warm`.
- Acceptance 5's 1M-row crash backlog. The `crash` leg leaves 5,000 rows.
- `window` and `reclaim` above 1M rows.
- A genuine store written by an old engine. The `migration` leg simulates one.

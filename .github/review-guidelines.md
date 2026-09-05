# Review guidelines

- Report a defect only when you can trace the failure through code shown in this diff: name the concrete inputs or state, and the line where execution goes wrong. If the mechanism depends on code you have not seen, do not report it — "might" is not a finding.
- Never report a finding that your own analysis concludes is intended behaviour, is defended elsewhere in the diff, or is not a defect.
- Lines beginning with "-" in a patch hunk are removed code. Never base a claim on them — verify every mechanism against "+" and context lines only.
- If the diff adds a guard, fix, or handling for a problem, that problem is already fixed: do not report it as still present. Read the whole hunk before claiming something is missing.
- Comments in the diff are the author's statement of intent. Do not report as a defect any behaviour a comment in the diff documents as intentional.
- In packages/core, embedding-failure marker writes are best-effort by contract ("Marker writes must never fail the caller"); a swallowed marker-write error is not a defect.
- `storage_error` failures are deliberately not backoff-tracked (a marker is itself a DB write); re-attempting such rows on a later sweep is the documented lifecycle, not a convergence loop.
- `runReembed` is a single pass over a snapshot of rows; concurrent-writer findings must name an interleaving the in-process JobManager locks actually permit.
- A React hook returning a structural superset of its old shape (extra fields added) is backwards-compatible, not a contract mismatch.
- vitest runs tests within a file sequentially; `vi.stubGlobal` in a sequential loop with `finally { vi.unstubAllGlobals() }` is not a concurrency hazard.
- Do not report findings in test files (tests/, *.test.ts, __tests__/): defects in test code surface in CI, not production behaviour.

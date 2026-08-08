# Spec: Dependabot Hygiene, #79 TOCTOU Race Fix, and #76 Two-Phase Release Flow

**Date:** 2026-08-07
**Status:** Approved
**Addresses:** Dependabot (remaining `fast-uri` advisory + missing audit gate), [#79](https://github.com/equationalapplications/expo-llm-wiki/issues/79) (TOCTOU race in `onDuplicateHash: 'skip'`), [#76](https://github.com/equationalapplications/expo-llm-wiki/issues/76) (two-phase PR release flow)
**Packages:** `@eq/wiki-core`, root CI/release configuration

---

## Problem

Three independent issues accumulated against the current `main` and ship as one combined PR.

### A — Dependabot hygiene gap

The maintenance-bounding spec (`2026-08-04-maintenance-bounding-and-dependency-hygiene-design.md`) addressed 36 Dependabot alerts, of which 17 closed via lockfile removal (C1) and the remainder via `pnpm.overrides` in `pnpm-workspace.yaml` (C2). One advisory explicitly listed in C2 is **not** present in the live overrides:

| Package | Severity | Fixed in | Listed in C2? | Present in overrides? |
|---|---|---|---|---|
| `fast-uri` | high | 3.1.4 | yes | **no** |

Either `fast-uri` was never overridden, or a later edit dropped it without re-running `pnpm audit`. Either way the gap exists today.

A second issue is **process**, not state: `.github/workflows/test.yml` was deleted in #77 as a temporary mitigation to unblock the 5.1.1 release. Without that workflow, even if `fast-uri` is fixed today, the next Dependabot advisory has no CI gate to fail it on PR — the same accumulation pattern repeats.

### B — #79 TOCTOU race in `onDuplicateHash: 'skip'`

The `onDuplicateHash` guard introduced in `2026-08-07-source-ref-lifecycle-design.md` (§2) fires *before* the per-`(entityId, sourceRef)` ingest lock. Two concurrent ingest tasks with different `sourceRef`s but identical `sourceHash`es both pass the guard (both see no live row), both acquire their respective locks, both write. The guard is racy.

The host (`aws-cloud-agent`) currently works around this with `documentConcurrency: 1`, which serializes ingestion and neutralizes the race but trades correctness for throughput (default `INGEST_DOCUMENT_CONCURRENCY=3` was chosen to avoid Bedrock TPS throttling).

### C — #76 release flow blocked by ruleset

The `Protect Main` ruleset (id 20511961, created 2026-08-06) requires `Test` status on pushes to `main`. `release.yml` uses `@semantic-release/git` to push the release commit and tag directly to `main`; that push is rejected because no `Test` status exists for the bot's commit yet. The 5.1.1 release was unblocked in #77 by deleting `test.yml` and dropping `required_status_checks`. The desired end state restores gating without breaking the release pipeline.

---

## Solution

Three workstreams bundled in one PR, sequenced so each step's CI gate (when present) protects the next.

| § | Title | Touches |
|---|---|---|
| A | Dependabot hygiene | `pnpm-workspace.yaml`, `.github/workflows/test.yml` |
| B | #79 TOCTOU race fix | `packages/core/src/types.ts`, `packages/core/src/db/sqliteCodes.ts`, `packages/core/src/db/serializedAdapter.ts`, `packages/core/src/services/IngestionService.ts`, `packages/core/src/services/JobManager.ts`, schema migration v9 |
| C | #76 two-phase release flow | `.releaserc.json`, `.github/workflows/release.yml`, `Protect Main` ruleset (id 20511961) |

---

## §A. Dependabot hygiene

### A1 — `fast-uri` override

Add to the `overrides` block in `pnpm-workspace.yaml` (kept single-source-of-truth per the existing comment block — do NOT add `pnpm.overrides` to root `package.json`):

```yaml
  fast-uri@>=3.0.0 <3.1.4: 3.1.4
  fast-uri@>=2.0.0 <3.0.0: ^3.0.0
```

Two ranges because `fast-uri` was renamed across major versions and Dependabot flags both branches. Verification: `pnpm audit --json` shows zero high/critical `fast-uri` advisories post-merge.

### A2 — restore `.github/workflows/test.yml` with audit gate

The workflow lands in two stages (matches the sequencing table below):

**A2a — restore `test.yml` without the audit step** (step 1 in sequencing). This unblocks the combined PR's own `Test` run before §A2b lands. Final form of the workflow:

```yaml
name: Test

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<pinned-sha>
        with: { fetch-depth: 0 }

      - uses: pnpm/action-setup@<pinned-sha>

      - uses: actions/setup-node@<pinned-sha>
        with: { node-version: 24.10.0 }

      - uses: actions/cache@v4
        with:
          path: ${{ env.STORE_PATH }}
          key: ${{ runner.os }}-pnpm-store-${{ hashFiles('**/pnpm-lock.yaml') }}

      - run: pnpm install --frozen-lockfile

      - run: pnpm run build
      - run: pnpm run typecheck
      - run: pnpm test
```

**A2b — extend `test.yml` with the audit step** (step 7 in sequencing). Inserted before the build step so a fresh advisory surfaces before the long test suite:

```yaml
      # Fails on any high or critical advisory introduced by this PR.
      # The `if: success() || failure()` guard runs the audit on every non-
      # cancelled workflow outcome, including after a test failure, but skips
      # on cancellation (where pnpm install would not have completed and the
      # audit signal would only mask the original failure in the UI).
      - run: pnpm audit --audit-level=high
        if: success() || failure()
```

The `--audit-level=high` threshold matches the maintenance spec's policy.

### A3 — verification

- `pnpm audit --json` → zero high/critical.
- `pnpm test` → green.
- `gh api /repos/equationalapplications/expo-llm-wiki/dependabot/alerts` → re-query and record before/after counts.

---

## §B. #79 TOCTOU race fix (hybrid: app-lock + DB constraint)

Defense in depth. Application-level per-hash lock is the **fast path** — most concurrent ingests with the same hash serialize through it and the second caller sees the first's committed write at guard time. The DB-level UNIQUE index is the **safety net** — a true race that beats both the guard and the lock (e.g., timing where the lock is released between guard and write) is caught at INSERT time by the constraint, not by an inconsistent read.

### B1 — partial UNIQUE index (schema migration v9)

A new migration adds:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS ${prefix}idx_entries_live_hash
  ON ${prefix}entries (entity_id, source_hash)
  WHERE deleted_at IS NULL AND source_hash IS NOT NULL;
```

**Why a partial index:** soft-deleted rows can carry the same hash as the live row. Without `WHERE deleted_at IS NULL`, the constraint would prevent `forget({ sourceRef: A })` + `ingestDocument(sourceRef: A)` from working (the soft-deleted row still occupies the `(entity_id, source_hash)` slot).

**Why `source_hash IS NOT NULL`:** some legacy rows carry NULL hashes (per the source-ref-lifecycle spec §1). The constraint must not fire on NULL — three NULLs are not duplicates under SQL semantics, but a NOT NULL filter makes the invariant explicit and avoids surprise behavior if the database driver handles NULLs differently across versions.

**Migration name:** `add_live_hash_unique_index` (matches the existing migration naming convention).

### B2 — migration conflict-resolution policy (abort, not auto-resolve)

If the database already contains live duplicate rows (i.e., a previous ingest beat the new guard), `CREATE UNIQUE INDEX` fails. The migration script **aborts with a clear, actionable error** rather than auto-resolving:

```
Migration v9 (add_live_hash_unique_index) failed: existing live rows
violate the new UNIQUE index. Run the following query to find duplicates,
then resolve each via `forget({ sourceRef: <loser> })` and re-run the
migration:

  SELECT entity_id, source_hash, COUNT(*) AS n
  FROM ${prefix}entries
  WHERE deleted_at IS NULL AND source_hash IS NOT NULL
  GROUP BY entity_id, source_hash
  HAVING COUNT(*) > 1;
```

Auto-resolving would either destroy facts (deleting all but one row) or pick a wrong canonical (silently choosing which row to keep). Both are worse than failing safe. The manual remediation path is documented and uses the existing `forget({ sourceRef })` API introduced in the source-ref-lifecycle spec §1.

### B3 — `JobManager.hashLocks` (per-hash application lock)

`JobManager` gains a new internal primitive:

```ts
class JobManager {
  // Existing
  private locks: Map<string, Promise<unknown>> = new Map();

  // New — keyed by `${entityId}:${sourceHash}`.
  private hashLocks: Map<string, Promise<unknown>> = new Map();

  async acquireHashLock(entityId: string, sourceHash: string): Promise<() => void> { /* ... */ }
}
```

**Lock primitive semantics match `acquireLock` (existing):** same promise-chain tail-advancement, same `releaseLock` shape. Internal-only; not exposed on the `WikiMemory` facade. Hosts do not acquire hash locks directly — `IngestionService.acquireIngestLocks` does.

### B4 — lock acquisition order (codified)

A single helper owns the order, removing the per-caller decision:

```ts
// IngestionService.ts
async function acquireIngestLocks(
  entityId: string,
  sourceRef: string,
  sourceHash: string,
): Promise<() => void> {
  // INVARIANT: hash lock ALWAYS acquired before sourceRef lock.
  // Reversed order is the only way two callers deadlock.
  const releaseHash = await this.jobManager.acquireHashLock(entityId, sourceHash);
  try {
    const releaseSource = await this.jobManager.acquireLock('ingest', `${entityId}:${sourceRef}`);
    return () => {
      releaseSource();
      releaseHash();
    };
  } catch (e) {
    releaseHash();
    throw e;
  }
}
```

The invariant is documented in a comment block at the top of `JobManager`:

```
// Lock acquisition order in this library:
//
//   1. Hash lock       (per (entityId, sourceHash))
//   2. sourceRef lock  (per (entityId, sourceRef), keyed as 'ingest')
//
// Always hash-then-sourceRef. A reversed order is the only deadlock path.
// The single helper `IngestionService.acquireIngestLocks` enforces this for
// all ingest callers — do NOT take the sourceRef lock directly.
```

Code review enforces the invariant at every call site. The `acquireLock('ingest', ...)` callers in the existing codebase that don't go through `acquireIngestLocks` are migrated to the new helper as part of B3.

### B5 — catch-and-translate pattern (in `IngestionService.ingestDocument`)

The exception path inside `ingestDocument` becomes:

```ts
try {
  // ... existing chunk-insert path (runs inside withTransactionAsync, so any
  // SQLite error is wrapped as WikiTransactionError by serializedAdapter).
} catch (err) {
  const code =
    err instanceof WikiTransactionError
      ? err.sqliteErrorCode
      : extractSqliteCode(err);
  if (code === 'SQLITE_CONSTRAINT_UNIQUE') {
    return translateConstraintToDuplicateHash(err, {
      entityId, sourceRef, sourceHash, mode: opts?.onDuplicateHash ?? 'ingest',
    });
  }
  throw err;
}
```

`translateConstraintToDuplicateHash` does the post-violation canonical lookup and dispatches per `onDuplicateHash`:

```ts
async function translateConstraintToDuplicateHash(
  _err: unknown,
  ctx: { entityId: string; sourceRef: string; sourceHash: string; mode: 'ingest' | 'skip' | 'throw' },
): Promise<IngestDocumentResult> {
  // Post-violation lookup: at least one row is now committed (the racing writer
  // beat us). Use the source-ref-lifecycle spec's canonical-selection rule.
  const refs = await this.entryRepo.findSourceRefsByHash(ctx.entityId, ctx.sourceHash);
  const canonical = refs[0] ?? ctx.sourceRef; // refs is empty only in a tight race after a forget — fall back to incoming

  switch (ctx.mode) {
    case 'throw':
      throw new WikiDuplicateHashError({ canonical, sourceHash: ctx.sourceHash, entityId: ctx.entityId });
    case 'skip':
      return { truncated: false, chunks: 0, duplicateOf: canonical };
    case 'ingest':
      // The pre-check passed and the lock was acquired. A UNIQUE violation here
      // means a true race — the OTHER writer committed between our guard and
      // our write. We must NOT silently re-ingest; surface the duplicate.
      throw new WikiDuplicateHashError({ canonical, sourceHash: ctx.sourceHash, entityId: ctx.entityId });
  }
}
```

The `'ingest'` mode throws on a UNIQUE violation because the documented contract for `'ingest'` is "preserve current behavior" (the source-ref-lifecycle spec §2 row in the per-mode table). Under the original single-call semantics, two concurrent calls with the same hash both wrote — that's the bug. Under the new lock + constraint, only one can possibly write; the other must surface the duplicate rather than silently swallowing the violation. This is a **deliberate tightening** of `'ingest'` mode behavior, called out as a behavior change in §"Public API impact" below.

**Why the helper exists:** keeps the catch site readable and cleanly separates "this is a SQL constraint violation" from "this is a duplicate-hash domain event". A reviewer scanning `ingestDocument` sees one try/catch with three branches (constraint / skip / rethrow); they do not have to read `findSourceRefsByHash` to understand the catch.

### B6 — extend `SQLITE_RESULT_CODE_NAMES` for `expo-sqlite`

`packages/core/src/db/sqliteCodes.ts` adds one row:

```ts
const SQLITE_RESULT_CODE_NAMES: Record<number, string> = {
  // ... existing rows ...
  19: 'SQLITE_CONSTRAINT',
  2067: 'SQLITE_CONSTRAINT_UNIQUE', // extended code; better-sqlite3 reports the string directly
  // ...
};
```

Without this row, `expo-sqlite` reports `'Error code 2067: …'`, which `extractSqliteCode` normalizes via `nameForSqliteResultCode(2067)` → `'SQLITE_2067'` (the fallback for unmapped codes), and the catch-and-translate block misses it. The 2067 mapping is the cross-platform guarantee that `onDuplicateHash: 'skip'` works on every adapter.

---

## §C. #76 two-phase release flow

### C1 — `release.yml` rewrite

The release workflow splits into two phases, separated by a `release/vX.Y.Z` PR.

**Phase 1 — push to `main` triggers `release.yml`:**

1. Checkout, pnpm install, build (unchanged).
2. Run `npx semantic-release --no-ci` against the current commit. `--no-ci` skips semantic-release's built-in CI verification; the ruleset's required `Test` check on the Phase-1 PR replaces it.
3. semantic-release mutates the working tree: bumps root + per-package versions in `package.json`, updates `CHANGELOG.md`. `@semantic-release/git` is **dropped** from `.releaserc.json` — semantic-release no longer commits or pushes.
4. Derive `RELEASE_VERSION` from the modified root `package.json` (`node -p "require('./package.json').version"`).
5. Detect dirty working tree (semantic-release's mutations are uncommitted). Branch handling:
   - `BRANCH="release/v${RELEASE_VERSION}"`.
   - `EXISTING_PR=$(gh pr list --base main --head "${BRANCH}" --state open --json number --jq '.[0].number')` — if a PR is already open against `${BRANCH}` from a prior abandoned run, reuse it (`gh pr edit` to update title/body as needed; do NOT open a duplicate).
   - If no PR exists, `git checkout -B "${BRANCH}" main` from the current main, commit as `github-actions[bot]`, push, open a PR via `gh pr create --base main --head "${BRANCH}"`.
   - In all cases, `RELEASE_VERSION` is read from the modified root `package.json` (not hardcoded), so a retried release PR carries the same version as the abandoned one.
6. Auto-merge: `gh pr merge --auto --squash release/v${RELEASE_VERSION}`. Auto-merge waits for the `Test` check on the PR; squash preserves the merge commit's status check semantics.

**Phase 2 — PR is merged into `main`:**

1. The merge commit triggers `release.yml` again.
2. `npx semantic-release --no-ci` re-runs on the merge commit. Version detection is a **no-op** because the merge commit message (`Merge pull request #N from release/vX.Y.Z`) is not a conventional-commit bump trigger. The version-detection step still writes the bumped `package.json` files and `CHANGELOG.md` to the working tree (idempotent on a no-op release).
3. `RELEASE_VERSION` derivation: read the existing tag (`git tag --points-at HEAD --list 'v[0-9]*' | head -1`). The tag was created in Phase 1 by semantic-release's GitHub plugin (the GitHub release entry), so it's already on the merge commit.
4. `Publish all packages` runs unchanged.

### C2 — `.releaserc.json` updates

```diff
   "plugins": [
     "@semantic-release/commit-analyzer",
     "@semantic-release/release-notes-generator",
     ["@semantic-release/changelog", { "changelogFile": "CHANGELOG.md" }],
     ["@semantic-release/npm", { "npmPublish": false }],
     ["@semantic-release/exec", {
       "prepareCmd": "node -e \"...\""
     }],
     "@semantic-release/github"
-    ,
-    ["@semantic-release/git", {
-      "assets": ["CHANGELOG.md", "package.json", "..."],
-      "message": "chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}"
-    }]
   ]
```

`@semantic-release/git` removed entirely. The remaining plugins cover everything except the commit/push step, which is replaced by C1's manual PR creation.

### C3 — `concurrency` and `permissions`

```yaml
concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: false  # don't cancel an in-flight release — let it finish or fail
```

`cancel-in-progress: false` so a back-to-back push doesn't kill a release that's mid-publish. `cancel-in-progress: true` was tempting (faster feedback on stale pushes) but a half-finished publish leaves packages in inconsistent states.

`permissions:` block stays as-is (`contents: write`, `issues: write`, `pull-requests: write`, `id-token: write`).

### C4 — `Protect Main` ruleset reconfiguration

Add `Test` as a required status check on ruleset 20511961. Done via:

```bash
gh api -X PUT \
  -H "Accept: application/vnd.github+json" \
  /repos/equationalapplications/expo-llm-wiki/rulesets/20511961 \
  --input ruleset.json
```

`ruleset.json` adds `"Test"` to the required checks list. The first time this is applied, the ruleset has been accepting pushes without the check (since #77 dropped it); after this PR, all subsequent pushes and PRs require `Test`. The Phase-1 release PR passes `Test` via the restored workflow (§A2) before auto-merge.

---

## Sequencing

Internal to the combined PR. Squashing collapses these into one commit, but the agent writes patches in this order so each step builds on the last:

| Order | Change | Why this position |
|---|---|---|
| 1 | A2a — restore `test.yml` without audit step | Restores CI gating — combined PR passes through it |
| 2 | A1 (`fast-uri` override) | Independently ships; A2b's audit step in step 7 catches the next advisory |
| 3 | B1 (schema migration v9 + partial UNIQUE index) | Lowest-level guarantee first; everything in B3-B5 builds on the new invariant |
| 4 | B6 (`sqliteCodes.ts` extended code mapping) | Needed by B5's catch block; ship with the migration so tests can assert on it |
| 5 | B3, B4 (`JobManager.hashLocks` primitive + `acquireIngestLocks` helper) | App-layer lock needs B1's invariant; the helper codifies hash-then-sourceRef order |
| 6 | B5 (`IngestionService` catch-and-translate + `translateConstraintToDuplicateHash`) | Uses B1's invariant, B3's lock primitive, B4's helper, and B6's code mapping |
| 7 | A2b — add `pnpm audit --audit-level=high` step to `test.yml` | Now that `test.yml` exists from step 1, the audit gate lands |
| 8 | C1, C2 (`release.yml` rewrite + `.releaserc.json`) | Workflow changes; depend on `test.yml` for the Phase-1 PR to gate on |
| 9 | C3 (`concurrency`), C4 (ruleset reconfiguration) | Last; depends on `test.yml` existing and on Phase-1's PR actually getting gated |

Steps 1-7 are independently testable. Step 8 depends on 1 (test.yml) and 7 (audit step). Step 9 depends on 8 being ready (ruleset only useful if Phase-1 PR actually goes through Test).

---

## Cross-cutting

**Public API impact (§B only):**

| Change | Type | Hosts affected |
|---|---|---|
| `JobManager.hashLocks` | new internal field | none (internal) |
| `JobManager.acquireHashLock` | new internal method | none (internal) |
| `IngestionService.acquireIngestLocks` | new internal helper | none (internal) |
| `WikiDuplicateHashError` | unchanged from source-ref-lifecycle spec | none |
| `'ingest'` mode on UNIQUE violation | **behavior change**: now throws `WikiDuplicateHashError` instead of silently writing | hosts relying on the racy behavior will see a new error path |

The behavior change in `'ingest'` mode is a **deliberate tightening** of the contract. Hosts that previously relied on "two concurrent calls with the same hash both write" should switch to `onDuplicateHash: 'skip'` (which now race-free skips) or `onDuplicateHash: 'throw'` (which has always thrown). The `aws-cloud-agent` host's §6.1 mitigation (`documentConcurrency: 1`) becomes redundant after this change — the host can safely restore `INGEST_DOCUMENT_CONCURRENCY=3`.

**Outbox events:** unchanged. The duplicate guard catches before any outbox event is emitted (matches the source-ref-lifecycle spec §2 contract).

**Locking:**

- §B B2 introduces the per-hash lock; B4 codifies hash-then-sourceRef acquisition order.
- §B's catch-and-translate runs inside the existing `withSerializedTransactions` mutex (no new lock primitive for the catch itself).

**Schema:** one migration (v9). Conflict-resolution policy in §B2.

**`--no-ci` trade-off:** semantic-release's built-in CI verification is what would catch "tests failed but I'm going to release anyway." We lose that. Mitigation: the Phase-1 release PR must pass `Test` before auto-merge, enforced by the ruleset. Documented in a comment at the top of `release.yml`.

---

## Tests

### §A tests

- `pnpm audit --json` exits 0 with no high/critical in CI.
- After merging a branch that intentionally reverts the `fast-uri` override, the audit step fails on the resulting PR (smoke test).

### §B tests

- **UNIQUE index migration:** fresh install adds the index; idempotent (`CREATE UNIQUE INDEX IF NOT EXISTS`); on a database with pre-existing live duplicates, fails with the documented error message.
- **Duplicate-detection on UNIQUE violation:** insert a row, then `ingestDocument` for a *different* `sourceRef` with the same `sourceHash` *bypassing the pre-check* (test fixture inserts into the repo layer directly). Assert: `ingestDocument` catches the `SQLITE_CONSTRAINT_UNIQUE`, translates per `onDuplicateHash` mode:
  - `'skip'` returns `{ truncated: false, chunks: 0, duplicateOf: <canonical> }`.
  - `'throw'` raises `WikiDuplicateHashError` with the canonical populated.
  - `'ingest'` raises `WikiDuplicateHashError` (deliberate tightening).
- **`extractSqliteCode` extended-code mapping:** unit test asserting `extractSqliteCode({ message: 'Error code 2067: UNIQUE constraint failed' }) === 'SQLITE_CONSTRAINT_UNIQUE'`.
- **`WikiTransactionError.sqliteErrorCode` on UNIQUE:** test that the wrapped error carries the right code when a UNIQUE violation fires inside `withTransactionAsync`.
- **Per-hash lock ordering:** two concurrent `ingestDocument` calls for different refs sharing a hash serialize through the hash lock; assertion checks no deadlock and exactly one row committed.
- **The race-cloaking test:** N concurrent `ingestDocument` calls with N distinct `sourceRef`s sharing one `sourceHash`. Assert: exactly one row in `${prefix}entries`, the other N-1 receive the per-mode result. **This test fails against current code; passes after B1-B5.**

### §C tests

Cannot meaningfully unit-test workflow YAML. Verification is end-to-end:

- A release PR is opened by Phase 1; it carries the `Test` status; auto-merge waits for green; merge fires Phase 2; `Publish all packages` publishes all 7 workspace packages in the documented dependency order.
- `workflow_dispatch` republish path still resolves `RELEASE_VERSION` from the input.
- A back-to-back push during an in-flight release is held by the concurrency group and runs after the in-flight release completes.

---

## Risks

1. **UNIQUE constraint migration on existing duplicates.** A live database that already contains duplicate `(entity_id, source_hash)` rows fails the migration. §B2's abort-and-document policy is the response. Manual remediation: `forget({ sourceRef: loser })` per duplicate, then re-run migration. This risk is highest for the `aws-cloud-agent` host (which, per #79, has been forcing `documentConcurrency: 1` for some time — but the source-ref-lifecycle dedup query in §2 is best-effort at higher concurrency, so duplicates may exist).
2. **`test.yml` doesn't exist when this PR opens.** The combined PR doesn't need `Test` to merge (no rule requires it yet). After merge, the ruleset change (§C4) takes effect AND `test.yml` is in place — future PRs and the first release PR get `Test`. Verified end-to-end by the first release after this PR lands.
3. **`--no-ci` semantic-release trade-off.** Covered above.
4. **Abandoned release PRs.** If auto-merge abandons (e.g., `Test` flaked then went green but the PR was force-closed), semantic-release still creates a GitHub Release entry. With `npmPublish: false` at the root and per-package publish handled by `Publish all packages` (which only fires in Phase 2), no packages are published until Phase 2. The first end-to-end release verifies this.
5. **`'ingest'` mode behavior change.** Hosts relying on the racy behavior (two concurrent same-hash writes both succeed) will see a new `WikiDuplicateHashError` path. Listed in "Cross-cutting" as a deliberate tightening; called out here for review.
6. **Branch naming collisions.** If two releases are attempted back-to-back, `release/vX.Y.Z` must be derived from `nextRelease.version` deterministically. §C1 reads it from the modified root `package.json` after semantic-release runs (not hardcoded). The Phase-1 step retries on branch-already-exists by checking first and reusing if so.

---

## Out of scope

- Per-`sourceRef` dry-run for `forget` (covered in source-ref-lifecycle spec).
- Anything about ingest performance beyond the lock acquisition cost.
- Dependabot version-PRs from the bot itself — the audit gate in §A2 catches advisories that survive as range issues, but Dependabot's PR flow is unchanged. If the audit gate becomes noisy, the fix is in `.github/dependabot.yml` configuration, not in this spec.
- `aws-cloud-agent` host-side cleanup (`documentConcurrency: 1` mitigation becomes redundant after this lands). The host's own spec/PR is a follow-up.
- Semantic-release's GitHub Release entry now duplicates the Phase-2 publish log; this is acceptable for the spec's scope. A future cleanup could disable `@semantic-release/github` and rely on `gh release create` in Phase 2.

# Embedding Marker Lifecycle & Scopelab Test Hygiene — Design

**Status:** Approved, not yet implemented (2026-09-04)

**Issues addressed:** #121 (markers survive provider/dimension change), #129
(deferred #125/#126 self-review findings), #123 (executor off deprecated
injector helper), #122 (scopelab suite needs built dist), #124 (index on
`embedding_failed_at` — **closed without code**, §3)

**Extends:** `2026-09-04-embedding-failure-and-scope-hygiene-design.md`
(Status: Implemented), whose §3 shipped the marker system this spec now
completes and whose §6 deferred the #123 migration as an explicit non-goal.

---

## 1. Why these five travel together

Four of the five are follow-ups filed out of the same self-review round on
2026-09-04 (PRs #125–#128); the fifth (#124) is a performance question raised
in the same round. They share a deferral trail, not code. Bundling them in one
spec keeps that trail auditable in one place; §7 splits them into independent
PRs because their blast radii differ sharply — one changes host-observable
embedding semantics, two touch only a demo app.

Investigation (2026-09-04) verified every file:line claim below against `main`
@ `2684121`. **Three investigation findings materially changed the shape of the
work versus the issue text** — §3 (#124 has no query to optimize), §4.2 (#129's
`EmbeddingMarkerKind` item is already done), and §4.3 (#129 names a method that
does not exist; the real fix has two sites). Each is recorded where it applies.

---

## 2. #121 — Markers survive a provider or dimension change

### 2.1 Problem

Marker state is cleared in exactly one place: a successful
`EntryRepository.updateEmbeddingBlob` (`packages/core/src/repositories/EntryRepository.ts:885-897`)
sets `embedding_failed_at = NULL`, `embedding_failure_kind = NULL`,
`embedding_attempts = 0`. Nothing else ever clears it.

So a fact that reached `MAX_EMBED_ATTEMPTS` (5) or took a single
`float32_overflow` under provider A stays permanently excluded under provider B.
`classifyReembedRow` (`packages/core/src/services/MaintenanceService.ts:82-102`)
returns `'permanent'` for those rows on every subsequent sweep. Permanently
failed rows have **no embedding at all**, so they are invisible to vector
retrieval — they are exactly the rows a new provider is most likely to fix.
The only escape today is `runReembed({ force: true })`, which a host is
unlikely to discover.

### 2.2 Decision: reset on dimension promotion, plus a callability guard

Approach chosen (issue option 1) over provider-identity tracking (option 2) and
docs-only (option 3). Option 2 would need a host-supplied provider fingerprint
in `WikiOptions` and new metadata bookkeeping, to cover only the
same-dimension-swap case that `force: true` already handles. Not worth the
machinery.

**Investigation finding that makes option 1 viable.** It is not obvious that
dimension promotion is even reachable while permanently-failed rows exist.
It is: `countStaleEmbeddings` (`EntryRepository.ts:658-670`) counts a row stale
only when it has a **wrong-dimension blob** or a legacy `embedding` value —

```sql
(embedding_blob IS NOT NULL AND (CAST(length(embedding_blob) AS INTEGER) / 4) != ?)
OR (embedding_blob IS NULL AND embedding IS NOT NULL)
```

A permanently-failed row has `embedding_blob IS NULL` and `embedding IS NULL`,
so it is **not** counted stale and does not block promotion. Promotion therefore
fires, and the reset hung off it actually runs.

### 2.3 Change

`EmbeddingService.reconcileEmbeddingDimension`
(`packages/core/src/services/EmbeddingService.ts:46-56`) currently promotes and
clears the mismatch key. Add a marker reset to the promotion branch, so the
three writes are one logical event:

```ts
if (residualCount === 0) {
  await this.metadataRepo.setMeta('embedding_dimension', mismatchValue, this.db);
  await this.metadataRepo.clearDimensionMismatch(this.db);
  await this.entryRepo.clearEmbeddingFailureMarkers();
}
```

New DAO method on `EntryRepository`, mirroring `markEmbeddingFailure`'s
discipline (no `updated_at` touch, no outbox event — embedding lifecycle is
local state, not replicated; spec §3.5 of the parent design):

```ts
async clearEmbeddingFailureMarkers(tx?: SQLiteAdapter): Promise<number> {
  const executor = this.getExecutor(tx);
  const result = await executor.runAsync(
    `UPDATE ${this.prefix}entries
        SET embedding_failed_at = NULL,
            embedding_failure_kind = NULL,
            embedding_attempts = 0
      WHERE embedding_failed_at IS NOT NULL`,
  );
  return result.changes;
}
```

**`float32_overflow` is cleared too.** The parent spec calls it terminal because
retrying is "the same deterministic arithmetic on the same vector" — but after a
dimension change it is a *different model producing a different vector*, so the
premise no longer holds. Clearing all kinds is correct here and is the one place
where the terminal classification is deliberately overridden.

Revived rows are not embedded inside `reconcileEmbeddingDimension`; they become
eligible and are re-embedded on the **next** sweep. `runReembed` calls
`reconcileEmbeddingDimension` at the end of its loop
(`MaintenanceService.ts:414-416`), after candidates were already classified, so
same-sweep revival would be a surprise re-entrancy. Next-sweep is the honest
contract and gets documented on `runReembed`.

### 2.4 Config errors must not burn attempts

Raised in the #121 comment thread: `provider_error` is the catch-all for
*anything* thrown in the embed phase (`EmbeddingService.ts:104-108`), so host
misconfiguration counts toward `MAX_EMBED_ATTEMPTS` and can permanently exclude
facts that were never the provider's fault.

**Root cause found in investigation, with a targeted fix.** The guard at
`EmbeddingService.ts:65-66` tests truthiness, not callability:

```ts
const embedFn = this.options.llmProvider.embed;
if (!embedFn) return { ok: false, kind: 'no_provider' };
```

A truthy non-function (`embed: true`, an object, a malformed wrapper) passes
this guard, reaches `await embedFn(text)`, throws `TypeError`, and is marked
`provider_error` — burning an attempt per sweep until the fact is permanently
excluded. Change to:

```ts
if (typeof embedFn !== 'function') return { ok: false, kind: 'no_provider' };
```

`no_provider` never marks (parent spec §3.3), so a misconfigured host now
accumulates no marker state at all. The same guard exists in
`MaintenanceService.runReembed` (`MaintenanceService.ts:345-346`) and gets the
same treatment, so a bad config short-circuits the sweep rather than iterating.

**Explicitly rejected:** a broader "non-`Error` throws don't count toward the
ceiling" rule. It would add `instanceof Error` control flow, which #96's
hostile-runtime audit specifically warns against (a Proxy `getPrototypeOf` trap
can throw), and providers legitimately throw non-`Error` values — a rejected
string from a fetch wrapper is a real provider failure that *should* count.
The callability guard fixes the actual reported cause without either hazard.

### 2.5 Residual, documented

A **same-dimension provider swap** (1536-d model A → 1536-d model B) never sets
`embedding_dimension_mismatch`, so promotion never fires and markers survive.
`runReembed({ force: true })` remains the escape hatch. This is now a documented
decision on `runReembed`'s doc comment, not a discovered limitation — which was
the issue's stated goal.

---

## 3. #124 — Close without code (premise does not hold)

The issue proposes a partial index on `embedding_failed_at` for "the
`runReembed` candidate scan". Investigation: **no SQL anywhere filters on that
column.** `findAllForReembed` (`EntryRepository.ts:944-955`) is:

```sql
SELECT * FROM entries WHERE deleted_at IS NULL          -- (+ AND entity_id = ? )
```

It fetches every live row and classification happens **in JavaScript**, via
`classifyReembedRow` inside the loop (`MaintenanceService.ts:397-407`). SQLite
would never consult the proposed index; it would be dead weight in migration v12
plus write cost on every entry insert.

**Action: close #124 as wontfix**, with a comment recording the actual query
shape and noting that if sweep cost on large corpora ever matters, the fix is
keyset batching of `findAllForReembed` (or pushing the disposition filter into
SQL first, which would *then* justify the index) — not an index against a scan
that does not filter.

---

## 4. #129 — Self-review follow-ups

### 4.1 Stale marker survives an import carrying a valid blob (item 1)

**Two investigation corrections to the issue text.** The issue names
`EntryRepository.upsertFact` — no such method exists. The real sites are
`upsert` (`EntryRepository.ts:154`, ON CONFLICT at `:187-202`) and
`upsertForImport` (`:325`, ON CONFLICT at `:343-367`). **Both** are affected,
not one: `upsert` sets `embedding_blob` via a `CASE WHEN excluded.embedding_blob
IS NULL` guard and `upsertForImport` sets it unconditionally, and neither
touches the marker columns. So a row locally marked failed, then written with a
valid blob, ends up with a valid embedding **and** `embedding_failed_at IS NOT
NULL`.

Behaviorally inert today — a default `runReembed` sweep re-embeds everything and
self-heals the marker, and classification gates on blob validity first
(`MaintenanceService.ts:386-395`) — but contradictory as a diagnostic, and it
silently inflates the `permanentlyFailed` counter a host may be watching.

Fix: extend both SET clauses so a real incoming blob clears the markers.

```sql
embedding_failed_at    = CASE WHEN excluded.embedding_blob IS NOT NULL THEN NULL ELSE embedding_failed_at END,
embedding_failure_kind = CASE WHEN excluded.embedding_blob IS NOT NULL THEN NULL ELSE embedding_failure_kind END,
embedding_attempts     = CASE WHEN excluded.embedding_blob IS NOT NULL THEN 0    ELSE embedding_attempts     END
```

Note the asymmetry this preserves: an import with **no** blob leaves existing
marker state alone, matching `upsert`'s existing "absent means don't touch"
semantics for `embedding_blob` itself. Pinned by tests either way.

### 4.2 Export `EmbeddingMarkerKind` (item 2) — already done, no change

`EmbeddingMarkerKind` is declared at `packages/core/src/types.ts:875` and
`packages/core/src/index.ts:4` is `export * from './types'`. The type is
**already importable from the package root**; the issue's premise (that only
`EmbedFactResult` and `EmbedFailureKind` are exported, via the explicit
re-export on `index.ts:21`) mistook explicit re-export for reachability.

**Action: tick the checkbox with an explanatory comment.** No redundant explicit
export line — it would add a second maintenance point for zero reachability gain.

### 4.3 `storage_error` from the dimension write (item 3)

The taxonomy names both DAO writes in the storage domain, but the test at
`packages/core/__tests__/services/EmbeddingService.test.ts:141-149` only rejects
`updateEmbeddingBlob`. `storeEmbeddingDimension` (`EmbeddingService.ts:113`) is
inside the same `try` and is equally a `storage_error` source. Add one test that
rejects a `metadataRepo` write reached through `storeEmbeddingDimension` and
asserts `{ ok: false, kind: 'storage_error' }` **and**
`markEmbeddingFailure` not called (D3: storage errors never mark).

### 4.4 Widen the `findAllForReembed` return type (item 4)

It is typed `Promise<Array<WikiFact & { embedding_blob?: Uint8Array | null }>>`
while its `SELECT *` also returns the three marker columns at runtime. That
mismatch forces a `row as unknown as {…}` double cast at
`MaintenanceService.ts:397-402` — a cast that would keep compiling if the
columns were dropped. Introduce an exported type and return it:

```ts
export type ReembedCandidateRow = WikiFact & {
  embedding_blob?: Uint8Array | null;
  embedding_failed_at?: number | null;
  embedding_failure_kind?: string | null;
  embedding_attempts?: number | null;
};
```

Both casts in `runReembed` then drop out (the `embedding_blob` cast at
`MaintenanceService.ts:386` too), making the column dependency visible to the
compiler.

### 4.5 Jitter (item 5) — no change

Rows failing in one sweep share `failed_at` and `attempts`, so a whole corpus
becomes retry-eligible on the same tick. Fine for an on-device library with
host-initiated sweeps. Recorded here so the reasoning survives: if retries ever
fan out to a rate-limited API, add ±20% jitter inside `embedRetryDelayMs`
(`MaintenanceService.ts:68-72`). No code now.

---

## 5. #123 — Migrate the scopelab executor off the deprecated helper

### 5.1 Change

`buildAuthorizedSchemaArray` is `@deprecated`
(`packages/core-llm-tools/src/injector.ts:10-28`); its only production consumer
is `apps/scopelab/src/lib/llm/function-caller.ts:33`. Migrate to
`buildAuthorizedToolsArray` (`injector.ts:41-68`), which returns the full Gemini
`tools[]` array, then delete the deprecated helper, its export
(`core-llm-tools/src/index.ts:11`) and its dedicated tests.

**Investigation finding — the call site needs more than a rename.** The two
helpers return different shapes, and `function-caller.ts` uses the return value
twice:

1. **Request body** (`function-caller.ts:52`) currently wraps the schema array:
   `tools: authorizedScopes.length ? [{ functionDeclarations: authorizedScopes }] : undefined`.
   `buildAuthorizedToolsArray` already returns that wrapper, so the body becomes
   `tools: authorizedTools.length ? authorizedTools : undefined`.
2. **`advertisedNames`** (`function-caller.ts:76`) currently maps the flat schema
   array. It must now flatten the `functionDeclarations` group instead:

```ts
const advertisedNames = new Set(
  authorizedTools.flatMap(entry =>
    'functionDeclarations' in entry ? entry.functionDeclarations.map(d => d.name) : []
  )
)
```

This also drops the `(s: any)` cast and the `s.name ?? s.function?.name`
fallback, which was defensive against a shape that `GeminiToolEntry` now types
precisely.

**Behavior is unchanged for scopelab**: the two helpers differ only in their
treatment of `kind: 'built_in'` manifests, and scopelab registers none
(no `built_in` / `builtIn` / `google_search` anywhere under `apps/scopelab/src`).
The fail-closed execution check at `function-caller.ts:77-82` is untouched — it
still requires membership in `advertisedNames` **and** `isAuthorizedScope(t.scope)
|| enabledScopes.includes(t.scope)`.

### 5.2 Ride-alongs (from the #123 comment)

**Loop the scope-sync execution test over every authorized scope.**
`apps/scopelab/src/lib/llm/__tests__/scope-sync.test.ts:59-79` exercises only
`AUTHORIZED_SCOPES[0]`. With a single-member list nothing distinguishes a
re-hardcoded `['core']` from the imported guard; once the list grows, a reverted
literal in `function-caller.ts` would still pass. Wrap the execution test in
`for (const scope of AUTHORIZED_SCOPES)` so growth is covered automatically.
This migration is the natural moment — the file is already being touched.

**Freeze the exported array.** `packages/core-llm-tools/src/scopes.ts:13` is
`as const satisfies readonly AgentScope[]` — compile-time only. A JS consumer
(or TS via `any`) can `push()` at runtime and silently widen always-on
authorization for every downstream `isAuthorizedScope` check in the process.
Freeze so the runtime contract matches the type, in line with #96's posture:

```ts
export const AUTHORIZED_SCOPES = Object.freeze(['core'] as const) satisfies readonly AgentScope[];
```

Pinned by a test asserting a `push` attempt does not widen the array.

---

## 6. #122 — Scopelab tests must not depend on built dist

### 6.1 Problem

`pnpm --filter scopelab test` fails on a fresh clone with "Failed to resolve
entry" until workspace packages are built. Cause: scopelab has **no vitest
config**, so vitest inherits `apps/scopelab/vite.config.ts`, and workspace deps
resolve through each package's `exports` map to `dist/`
(`packages/core-llm-tools/package.json`). Nothing builds them first — the
scopelab suite is not in a `pnpm -r` build-then-test ordering.

### 6.2 Change (issue option 2)

Add `apps/scopelab/vitest.config.ts` aliasing both workspace deps to source:

```ts
import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@equationalapplications/core-llm-tools': resolve(__dirname, '../../packages/core-llm-tools/src/index.ts'),
      '@equationalapplications/core-llm-wiki': resolve(__dirname, '../../packages/core/src/index.ts'),
    },
  },
  test: { environment: 'node' },
})
```

Chosen over a `pretest` build script: it removes the dist dependency entirely
rather than papering over it, eliminates stale-dist false positives (a suite
passing against a `dist/` older than `src/`), keeps the feedback loop fast, and
drops the PWA and wasm-copy plugins from the test path, where they do nothing.

Because a dedicated `vitest.config.ts` takes precedence over `vite.config.ts`,
it must carry any test-relevant settings; the current suites need none beyond
the environment.

**Verification is the point of this PR**: after the change, `rm -rf
packages/*/dist` and run `pnpm --filter scopelab test` green from a clean tree.

---

## 7. PR breakdown

| PR | Branch | Scope | Depends on |
|----|--------|-------|------------|
| **PR-0** | `docs/marker-lifecycle-spec` | This spec | — |
| **PR-A** | `feat/marker-lifecycle` | §2 (#121 in full), §4.1/§4.3/§4.4 (#129 items 1, 3, 4) | PR-0 |
| **PR-B** | `refactor/scopelab-executor` | §5 (#123 + both ride-alongs) | PR-0 |
| **PR-C** | `fix/scopelab-vitest-source` | §6 (#122) | PR-0 |

**Issue closures without code** (§3, §4.2), done independently of any PR:
close #124 wontfix; tick #129 item 2 with the reachability explanation.

**Why this split.** PR-A is the only PR that changes host-observable embedding
semantics and the only one touching `packages/core` — it deserves review
attention that scopelab plumbing would dilute. PR-B and PR-C both touch
`apps/scopelab` but disjoint files (`function-caller.ts` + `scope-sync.test.ts`
vs. a new `vitest.config.ts`), so they can run as parallel worktrees. PR-B is
the only one that changes a published package's API surface (removing the
deprecated export from `core-llm-tools`), which is a semver-minor concern worth
isolating.

#129's five items are deliberately **not** their own PR: items 1, 3 and 4 are
marker-lifecycle correctness that belongs beside #121's reset in one reviewer
context; item 2 is a no-op; item 5 is a decision to record, not code.

**Merge discipline:** merge commits only, never squash — squashing breaks
semantic-release changelogs in this repo. Spec and code land in separate
commits. Within PR-A, the spec Status revision is appended, never replacing the
record.

---

## 8. Testing

TDD throughout: each behavior below gets a failing test first.

**PR-A**
- `clearEmbeddingFailureMarkers` clears all three columns for marked rows and
  leaves unmarked rows untouched; returns the changed count.
- `reconcileEmbeddingDimension` clears markers **only** on the promotion branch
  (residual 0), not when promotion is blocked (residual > 0) and not when no
  mismatch key is set.
- A `float32_overflow` row is revived by promotion, and becomes `'attempt'` on
  the next sweep (regression pin for the §2.3 override).
- A permanently-failed row (no blob) does not block promotion — pins the
  `countStaleEmbeddings` reachability the whole design rests on.
- `embed: <truthy non-function>` yields `{ ok: false, kind: 'no_provider' }`,
  writes **no** marker, and does not increment `embedding_attempts`; the same
  input makes `runReembed` return all-zero counters without iterating.
- `upsert` and `upsertForImport` each: an incoming valid blob clears markers on
  a marked row; an incoming null blob leaves markers intact.
- `storage_error` raised from `storeEmbeddingDimension` (§4.3).
- `ReembedCandidateRow` is a typecheck-level change — `pnpm typecheck` with the
  casts removed is the assertion.

**PR-B**
- Existing `function-caller.test.ts` and `scope-sync.test.ts` stay green through
  the migration (they are the behavior-equivalence proof).
- Scope-sync execution test loops all `AUTHORIZED_SCOPES` members.
- `AUTHORIZED_SCOPES.push(...)` does not widen the array.
- Grep gate: no `buildAuthorizedSchemaArray` reference survives outside git
  history.

**PR-C**
- `rm -rf packages/*/dist && pnpm --filter scopelab test` is green.

Each PR is green on its own package suite before review; a full-repo `pnpm test`
runs before PR-A merges, since it is the only PR changing behavior hosts observe.

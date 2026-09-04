# Embedding Failure Persistence & Scope Hygiene — Design

**Status:** Draft (2026-09-04)

**Issues addressed:** #118 (embedding failure persistence), #106 (AUTHORIZED_SCOPES drift), #107 (legacy-key purge), #86 (`upsertGraph` — verify & close, no code)

**Supersedes/extends:** §6.4 and §9 of `2026-09-02-tier-floors-and-embed-clamp-design.md`, which explicitly deferred #118 to its own spec.

---

## 1. Why these four travel together

They do not share code. They share a *release window* and a single reviewer
context: three are follow-ups deferred out of earlier PRs (#104 review, #105
security remediation) and one is stale bookkeeping. Bundling them into one spec
keeps the deferral trail auditable in one place; they are then split into
independent PRs (§8) because their blast radii differ by orders of magnitude.

Investigation (2026-09-04) verified every file:line claim below against
`main` @ `813fdcd`. Two investigation findings materially changed the shape of
the work versus the issue text; both are recorded in §2 and §7.

---

## 2. Finding that closes #86 without code

`WikiMemory.upsertGraph` **already exists on `main`** (`packages/core/src/WikiMemory.ts:588`),
shipped 2026-08-14 via commit `7041bdd` under
`docs/superpowers/specs/2026-08-14-wikimemory-public-api-extensions-design.md`
(Status: Implemented), with C1–C4 contract coverage in
`packages/core/__tests__/upsertGraphContract.test.ts`. Issue #86 was never closed.

**Action: close #86 with a comment recording the three deltas** between the
issue's proposed contract and what shipped. No code changes.

| Issue proposed | Shipped | Why |
|---|---|---|
| `upsertGraph(entityId, params)` | `upsertGraph(entityId, params, adapter)` | C1 is unsatisfiable with two args. `withSerializedTransactions` (`packages/core/src/db/serializedAdapter.ts:37-47`) makes a nested `withTransactionAsync` throw, so the caller's `tx` must be passed in explicitly. |
| C2: unchanged scope → zeros | Same `sourceRef` → zeros; **different** `sourceRef` holding the hash → throws `WikiSourceRefHashCollision` | `source_ref_index` is keyed `UNIQUE(entity_id, source_hash) WHERE deleted_at IS NULL` (`packages/core/src/db/schema.ts:54-56`). Known limitation: two byte-identical files collide permanently. |
| C3+C4 ⇒ `edgesWritten === edges.length` | `edgesWritten <= edges.length` | A reused edge id with an identical tuple is skipped and not counted (`packages/core/src/services/IngestionService.ts:509-521`); edges whose `sourceId` is outside the call bypass strict validation by design (the cross-file affordance). |

Also note in the closing comment: this path does **no** post-commit work (no
search sync, no embedding, no cache eviction) — facts written via `upsertGraph`
are invisible to vector retrieval until a maintenance sweep embeds them. That is
a C1 consequence and is documented, but easy for a consumer to miss.

Two optional follow-up issues may be filed (not in scope here): absent
validation for empty `nodes` (which still supersedes — wipes the scope and
returns `{0,0,N}`) and for duplicate node ids within one call (last write wins,
`nodesWritten` over-reports).

---

## 3. #118 — Embedding failure persistence

> **Status update (2026-09-04):** §3.1–§3.5 implemented via `feat/embedding-failure-markers`, pending merge.

### 3.1 Problem

`EmbeddingService.embedFact` (`packages/core/src/services/EmbeddingService.ts:53-103`)
returns `false` for every failure mode and persists nothing. `runReembed`
therefore cannot distinguish a transient provider outage from a permanently
un-embeddable fact from "no provider configured" — all present as
`embedding_blob IS NULL`. A fact that fails during an outage stays invisible to
semantic retrieval indefinitely.

### 3.2 Failure taxonomy (verified against source)

| Kind | Source | Persist marker? | Retry? |
|---|---|---|---|
| `no_provider` | `EmbeddingService.ts:55` — `embed` not configured | **No** — never attempted | N/A |
| `invalid_vector` | `:74-77` — empty array or non-finite element | Yes | Yes, bounded |
| `float32_overflow` | `:79-89` — values overflow float32 | Yes | **No — terminal.** Deterministic arithmetic on the same vector. |
| `provider_error` | `:99-102` catch — outage, HTTP 400 over-length, network | Yes | Yes, with backoff |
| `storage_error` | `:99-102` catch, but thrown by `storeEmbeddingDimension` (`:90`) / `updateEmbeddingBlob` (`:92`) | **No** — the DB write is what failed | Yes (next sweep) |

The single catch at `:99-102` currently conflates `provider_error` and
`storage_error`. They must be separated: marking a fact "embed failed" when the
DB is what failed is both wrong and unwritable.

Decision (D3, §7): `storage_error` is swallowed and classified, not rethrown.

### 3.3 Return contract

`embedFact` is **not** exported from `packages/core/src/index.ts` or
`packages/core/src/testing.ts` (verified), so this is a smaller semver event than
the issue assumed. But it must not be widened in place: `ImportExportService.ts:453`
does `if (!embedded)`, and a discriminated result object is always truthy — an
in-place widening silently disables that branch.

Use the two-method pattern the class already uses
(`notifyEmbeddingPersisted` / `notifyEmbeddingPersistedOrThrow`, `EmbeddingService.ts:105,115`):

```ts
export type EmbedFailureKind =
  | 'no_provider' | 'invalid_vector' | 'float32_overflow'
  | 'provider_error' | 'storage_error';

export type EmbedFactResult =
  | { ok: true; dimension: number }
  | { ok: false; kind: EmbedFailureKind };

// New. Persists a marker for invalid_vector | float32_overflow | provider_error only.
async tryEmbedFact(fact): Promise<EmbedFactResult>

// Unchanged signature. Delegates: return (await this.tryEmbedFact(fact)).ok
async embedFact(fact): Promise<boolean>
```

Marker persistence lives in `tryEmbedFact`, so the three result-ignoring callers
(`IngestionService.ts:325`, `MaintenanceService.ts:643`, `:916`) get durable
failure state for free without touching their code.

### 3.4 Schema — columns, not a table

Three columns on `<prefix>entries`, matching the 1:1 cooldown-column precedent of
`ontology_checked_at` (v7) and `heal_checked_at` (v8), `packages/core/src/db/migrations.ts:115-148`:

```sql
embedding_failed_at    INTEGER              -- epoch ms of last failed attempt; NULL = no outstanding failure
embedding_failure_kind TEXT                 -- 'invalid_vector' | 'float32_overflow' | 'provider_error'
embedding_attempts     INTEGER NOT NULL DEFAULT 0
```

A separate failures table was rejected: it buys only history, needs its own
GC story, and forces a join into `runReembed` candidate selection. Columns
inherit the entry row's soft-delete and prune lifecycle for free.

**Migration v11** (current max is v10, `migrations.ts:236`). Follows the v7/v8/v10
pattern exactly: `PRAGMA table_info` existence guard, `ALTER TABLE ... ADD COLUMN`
**outside any explicit transaction** (expo-sqlite forbids DDL inside
`BEGIN...COMMIT` — see the repeated comment at `migrations.ts:31-33,119-121,239-242`),
and the same three columns mirrored into the fresh-install `CREATE TABLE` in
`packages/core/src/db/schema.ts`. `CURRENT_SCHEMA_VERSION` derives from the
`MIGRATIONS` array (`migrations.ts:286-287`); no manual bump.

Only the `entries` table gets these columns. `tasks` are not embedded.

### 3.5 DAO discipline

New `EntryRepository` methods `markEmbeddingFailure(id, kind, now)` and a clear
folded into `updateEmbeddingBlob` (`EntryRepository.ts:885-890`).

**These writes MUST NOT touch `updated_at`** — import merge is last-write-wins on
it, and `packages/core/__tests__/daoDiscipline.test.ts` enforces this. They also
push **no outbox events**, following the `updateEmbeddingBlob` precedent
(embedding lifecycle is local, not replicated).

### 3.6 `runReembed` orchestration

> **Status update (2026-09-04):** implemented via `feat/reembed-retry-orchestration`, pending merge.

At `MaintenanceService.ts:297-358`. Candidate classification per row:

- valid blob → `skipped` (existing logic `:330-340`, unchanged)
- `embedding_blob IS NULL AND embedding_failed_at IS NULL` → attempt
- `embedding_failed_at IS NOT NULL` → gate:
  - `kind === 'float32_overflow'` → **permanently excluded**
  - `attempts >= MAX_EMBED_ATTEMPTS` (5) → **permanently excluded**
  - otherwise retry when `now - embedding_failed_at >= backoff(attempts)`, where
    `backoff = min(60_000 * 2^(attempts-1), 86_400_000)` — the cooldown idiom of
    `HEAL_RECHECK_MS` / `ONTOLOGY_BACKFILL_RECHECK_MS` (`MaintenanceService.ts:32,58`)

`opts.force` is **accepted but never read today** (`MaintenanceService.ts:297`) —
it becomes the override that bypasses both permanent-exclusion rules.

Result shape gains fields (additive, following `HealResult` / `OntologyBackfillResult`):

```ts
{ embedded, skipped, failed, deferred, permanentlyFailed }
```

Decision (D1, §7): rows inside the backoff window count as **`deferred`**, not
`failed`, so host `while (result.failed > 0)` convergence loops terminate.

---

## 4. #106 — Centralize AUTHORIZED_SCOPES

> **Status update (2026-09-04):** implemented via `fix/centralize-authorized-scopes`, pending merge.

Three executable scope-check sites, not two (the issue's "presumably" is confirmed):

| Site | Code |
|---|---|
| `packages/core-llm-tools/src/injector.ts:21` (`buildAuthorizedSchemaArray`, deprecated) | `manifest.scope === 'core' \|\| userGrantedScopes.includes(...)` |
| `packages/core-llm-tools/src/injector.ts:45` (`buildAuthorizedToolsArray`, canonical) | identical |
| `apps/scopelab/src/lib/llm/function-caller.ts:76` | `const AUTHORIZED_SCOPES = ['core']`, used at `:82` |

`apps/scopelab` already declares `"@equationalapplications/core-llm-tools": "workspace:*"`
(`apps/scopelab/package.json:13`) and already imports from it, so no new
dependency, no new shared package, no cycle.

New `packages/core-llm-tools/src/scopes.ts`:

```ts
import type { AgentScope } from './types';

export const AUTHORIZED_SCOPES = ['core'] as const satisfies readonly AgentScope[];
export type AuthorizedScope = (typeof AUTHORIZED_SCOPES)[number];

export function isAuthorizedScope(scope: string): scope is AuthorizedScope {
  return (AUTHORIZED_SCOPES as readonly string[]).includes(scope);
}
```

`satisfies readonly AgentScope[]` makes drift from the `AgentScope` union a
compile error. The `isAuthorizedScope` guard exists because TypeScript rejects
`.includes()` on a `readonly ['core']` tuple with a wider argument — the one
mechanical gotcha in this change.

Data-and-fixture occurrences of `'core'` are **out of scope** and must not be
touched: the `AgentScope` union member (`types.ts:2`), manifest declarations
(`manifests/core.ts:5,16,27`), and all test fixtures.

Sync test lives in **`apps/scopelab`** — dependency flows app → package, so a
package-side test cannot import the app's executor.

Public API addition to a published package → `feat(core-llm-tools):` (minor).

---

## 5. #107 — One-shot legacy-key purge

> **Status update (2026-09-04):** implemented via `fix/purge-legacy-keys-once`, pending merge.

`purgeLegacyPlaintextKeys()` (`apps/wiki-demo/src/lib/sessionConfig.ts:24-31`) is
called from `loadSessionConfig` (`:46`) and `saveSessionConfig` (`:63`); after the
first run every call re-probes localStorage and removes nothing.

Fix: module-init invocation plus an `alreadyPurged` module-level guard; delete
both per-call invocations. Module-init is safe and sufficient because the only
import chain is `main.tsx → App.tsx → sessionConfig.ts` (grep-verified: the only
importers are `App.tsx:44` and the test), so import time *is* boot time, and the
function already guards non-browser evaluation.

**Two investigation findings the issue text does not anticipate:**

1. The acceptance criterion "existing `sessionConfig.test.ts` continues to pass"
   **cannot hold literally.** The test at `sessionConfig.test.ts:37-44` asserts
   that `loadSessionConfig` purges legacy keys — it encodes the very per-call
   contract being removed, and must be rewritten. Reviewers should expect a test
   diff.
2. wiki-demo has **no vitest environment config** (root `vitest.config.ts` includes
   only `packages/*`), so tests run in plain Node where `typeof localStorage === 'undefined'`,
   and localStorage is a hand-rolled Map-backed stub installed in `beforeEach`.
   A module-init purge therefore runs **before** the stub exists and no-ops
   silently. The import-time test must install a recording stub, then
   `vi.resetModules()` and dynamically import — the issue's "fresh JSDOM context"
   phrasing does not literally apply (there is no jsdom here).

---

## 6. Non-goals

- Rethrowing storage errors from `embedFact` (see D3).
- Exporting embedding failure markers in OKF bundles (see D2).
- Migrating scopelab from the deprecated `buildAuthorizedSchemaArray` to
  `buildAuthorizedToolsArray` — worth a follow-up issue, out of scope here.
- Any change to the embed clamp shipped in #104 (`EmbeddingService.ts:67-71`).
- Any `upsertGraph` behavior change (§2).

---

## 7. Decisions (defaults applied; reversible before implementation)

- **D1 — backoff-deferred rows count as `deferred`, not `failed`.**
  Rationale: a host `while (result.failed > 0)` loop would otherwise spin against
  the backoff window forever. Follows the heal `remaining`/`deferred` precedent.
- **D2 — failure markers are NOT exported in OKF bundles.**
  Rationale: a marker records the *exporting host's* provider state and is
  meaningless on the importing host. Import leaves the three columns at their
  defaults; an explicit assertion pins this.
- **D3 — `storage_error` is swallowed and classified, not rethrown.**
  Rationale: rethrowing changes behavior at three post-commit call sites
  (`IngestionService.ts:325`, `MaintenanceService.ts:643,916`) that currently
  cannot throw. Preserves today's contract.

---

## 8. PR breakdown

Five PRs. PR-1 and PR-2 are independent of everything. PR-4 depends on PR-3.

| PR | Branch | Scope | Depends on |
|---|---|---|---|
| **PR-0** | `spec/embedding-failure-and-scope-hygiene` | This spec (docs only). Close #86 with the §2 comment. | — |
| **PR-1** | `fix/centralize-authorized-scopes` | #106 in full | PR-0 (spec only) |
| **PR-2** | `fix/purge-legacy-keys-once` | #107 in full | PR-0 |
| **PR-3** | `feat/embedding-failure-markers` | #118 part 1: migration v11, schema, DAO methods, `EmbedFactResult`, `tryEmbedFact`, marker persistence | PR-0 |
| **PR-4** | `feat/reembed-retry-orchestration` | #118 part 2: `runReembed` classification, backoff, permanent-failure rules, `force`, new counters | **PR-3** |

Splitting #118 at the service/orchestration seam means PR-3 lands durable
failure state that is already useful for diagnostics, and PR-4 changes retry
policy against a schema that is already merged and tested.

**Merge discipline:** merge commits only, never squash — squashing breaks
semantic-release changelogs in this repo. Spec and code land in separate commits.

## 9. Verification

Each PR is green on `pnpm --filter <pkg> test` before review. Full-repo test
run before PR-4 merges, since it is the only PR that changes retry behavior
observable by hosts.

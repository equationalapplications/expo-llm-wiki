# Spec: Agent Memory Features — porter stemmer, synonymMap, LWW merge

**Date:** 2026-04-30
**Status:** Implemented

---

## Problem

expo-llm-wiki's current design is optimised for simple chatbot memory. Two gaps surface when building agent-oriented consumers (e.g. clanker):

1. **Recall is limited by naive tokenisation.** `formatSearchQuery` strips punctuation, lower-cases, filters tokens to `len >= 3`, and joins with `"tok"* OR "tok"*`. This means:
   - `running`, `runs`, `ran` do **not** match a fact about `run` — they are different FTS5 tokens.
   - A query `"how was your jog?"` misses a fact titled `"User's morning run routine"` even though they describe the same activity.
   - There is no caller-supplied domain vocabulary (e.g. relationships terms, health synonyms).

2. **Cloud sync has no safe merge semantics.** `importDump` with `merge: true` currently skips any entity bundle that already has local data, so a cloud-first sync clobbers newer local writes. Consumers need a last-write-wins (LWW) strategy that merges at the row level using `updated_at`.

---

## Goals

- FTS5 porter stemmer: morphological matching for regular inflections (e.g. `run`/`running`/`runs` → same stem).
- Static `synonymMap` config: caller-supplied term expansions applied at query time; no DB writes.
- LWW merge in `importDump`: row-level merge by `updated_at` — newer row wins regardless of origin.
- Backward-compatible schema migration (idempotent FTS5 rebuild, no table drops).
- All existing tests continue passing.

## Non-Goals

- `resolution_note` task field — deferred; the package lacks a task-update API and the field adds complexity without a clear read path. Re-evaluate when a `resolveTask()` method exists.
- Derived/dynamic synonyms computed from co-occurrence — dropped after evaluation (weak signal, cold-start useless, porter covers 80% of the gap).
- `due_context` task field — dropped (never consumed by any logic path; representable in description).
- Cross-entity synonym sharing.
- LLM-assisted synonym generation.

---

## Changes

### 1. FTS5 Porter Stemmer

**Schema change:** the `{prefix}entries_fts` virtual table gains a tokenizer:
```sql
CREATE VIRTUAL TABLE IF NOT EXISTS {prefix}entries_fts USING fts5(
  title,
  body,
  tags,
  content='{prefix}entries',
  content_rowid='rowid',
  tokenize='porter unicode61'   -- NEW
);
```

**Upgrade migration:** existing installs have an FTS5 table without `tokenize='porter unicode61'`. `CREATE VIRTUAL TABLE IF NOT EXISTS` is a no-op if the table already exists — it does not modify the tokenizer.

Detection and rebuild in `setup()`:
1. Query `sqlite_master` for the FTS5 table's `sql` column.
2. If the `sql` does not contain `porter`, rebuild. The **entire sequence — drop triggers, drop table, create table, repopulate, recreate triggers — executes inside a single SQLite transaction** so the DB is never left in a state where the FTS5 table exists without its triggers, or exists but is empty:
   ```sql
   BEGIN;
   DROP TRIGGER IF EXISTS {prefix}entries_ai;
   DROP TRIGGER IF EXISTS {prefix}entries_ad;
   DROP TRIGGER IF EXISTS {prefix}entries_au;
   DROP TABLE IF EXISTS {prefix}entries_fts;
   CREATE VIRTUAL TABLE {prefix}entries_fts USING fts5(
     title, body, tags,
     content='{prefix}entries',
     content_rowid='rowid',
     tokenize='porter unicode61'
   );
   -- Repopulate from live entries (matches trigger behavior: no deleted_at filter)
   INSERT INTO {prefix}entries_fts(rowid, title, body, tags)
     SELECT rowid, title, body, tags FROM {prefix}entries;
   -- [triggers recreated here, still inside transaction]
   COMMIT;
   ```
   Any failure rolls the entire transaction back, leaving the original FTS5 table intact.

**One-time cost:** repopulation scans `entries`. For typical app sizes (<10k rows) this completes in well under 1 second. `setup()` is already called once on app start; consumers already await it.

**`formatSearchQuery` simplification:** porter handles morphology, so the JS-side tokenisation can stay the same — just lowercase → strip punctuation → `len >= 3` → expand synonyms (Section 2) → `"tok"* OR "tok"*`. No compromise.js. No lemmatization code.

---

### 2. `WikiConfig.synonymMap`

**Type:**
```ts
synonymMap?: Record<string, string[]>
```

**Behaviour:** in `formatSearchQuery`, after building the initial token list, for each token `t` check `synonymMap[t]`. Append all matching synonym values to the token list. Deduplicate. Slice to top 12 (raised from 6 to accommodate expansion).

**Case sensitivity:** synonym map lookup is **case-insensitive** — tokens are already lowercased by the pipeline before lookup, and synonym values are lowercased before being added to the token list. Keys in `synonymMap` should therefore be lowercase; uppercase keys are silently unreachable.

**Example:**
```ts
const wiki = createWiki(db, {
  llmProvider,
  config: {
    synonymMap: {
      run:     ['jog', 'sprint', 'run'],
      partner: ['spouse', 'wife', 'husband', 'boyfriend', 'girlfriend'],
      workout: ['exercise', 'training', 'gym'],
    },
  },
});
```
Query `"how was your jog today?"` → tokens `['jog', 'today']` → no synonym for `today`; `jog` has no entry so it stays. Query `"how was your run?"` → tokens `['run']` → synonymMap expands to `['run', 'jog', 'sprint']` → FTS5 matches all three. (Porter additionally matches forms like `running` without synonyms, but irregular forms such as `ran` are not covered.)

**No DB writes.** No migration. Purely in-memory expansion at query time. Caller can pass `undefined` (no expansion; existing behavior).

---

### 3. `importDump` Last-Write-Wins (LWW) Merge

**Current behaviour:** `importDump(dump, { merge: true })` skips any entity bundle that already has at least one local row (coarse skip — entire entity).

**New behaviour:** when `merge: true`, perform row-level LWW merge for all entities:

- **Facts (`entries`):** for each incoming fact, if no local row with the same `id` exists, insert it. If a local row exists and `incoming.updated_at > local.updated_at`, overwrite the local row (full replace). Otherwise, keep the local row.
- **Tasks:** same LWW logic by `id` + `updated_at`.
- **Events:** append-only (no `updated_at`). Insert only if no local row with the same `id` exists.

**Without `merge` (default):** behaviour is unchanged — overwrite all local data for the entity.

**Implementation:** wrap the merge in a single SQLite transaction per entity for atomicity.

**Conflict surfacing:** conflicts (same `id`, incoming row loses because `updated_at` is not newer) are resolved silently — no log entry, no return value, no event is emitted. This is intentional: LWW is a background sync primitive and callers have no actionable response to a skipped row. If observability is needed in the future, a `conflicts` count could be added to the return value of `importDump`; that is out of scope for this PR.

**`importDump` signature:** no change. `merge` option already exists. Only the merge strategy changes.

**Example:**
```ts
// After receiving remoteDump from cloud sync:
await wiki.importDump(remoteDump, { merge: true });
// Facts with newer updated_at on the remote win; newer local facts are preserved.
```

---

## `types.ts` Changes

```ts
// WikiConfig — add field
export interface WikiConfig {
  // ... existing fields ...
  synonymMap?: Record<string, string[]>;  // NEW
}

// WikiSynonym — removed (derived synonyms dropped)
```

---

## `db/schema.ts` Changes

- FTS5 `CREATE VIRTUAL TABLE` gains `tokenize='porter unicode61'`.
- No `resolution_note` column — deferred.
- No new tables.

---

## `WikiMemory.ts` Changes

- `setup()`: FTS5 porter detection + rebuild (no `ALTER TABLE` for `resolution_note`).
- `formatSearchQuery()`: synonym expansion from `this.options.config?.synonymMap`; max tokens raised to 12.
- `importDump()`: replace coarse per-entity skip with row-level LWW merge by `updated_at` for facts and tasks; append-only dedup for events.

---

## `prompts.ts` Changes

No changes — `resolution_note` is deferred.

---

## Tests

Match existing vitest patterns in `src/__tests__/`.

### New test file: `src/__tests__/synonymMap.test.ts`

- `formatSearchQuery` with no synonymMap: no expansion (existing behaviour).
- `formatSearchQuery` with synonymMap: token `run` → `run`, `jog`, `sprint` all appear in query string.
- Multi-token query: each token expanded independently; result deduped.
- No synonymMap key for token: token preserved unchanged.
- Token slice cap at 12.
- Empty synonymMap `{}`: no expansion.

### New test file: `src/__tests__/porterStemmer.test.ts`

- After `setup()`, query `"running"` matches a fact with body `"User runs every morning"`.
- Query `"run"` matches the same fact.
- Upgrade path: if FTS5 table exists without porter, `setup()` rebuilds it and existing facts are searchable via porter.
- Rebuild is idempotent: calling `setup()` twice does not drop facts.

### New test file: `src/__tests__/importDumpMerge.test.ts`

- `importDump` with `merge: true`: incoming fact with newer `updated_at` overwrites local fact with same id.
- `importDump` with `merge: true`: incoming fact with older `updated_at` does not overwrite newer local fact.
- `importDump` with `merge: true`: incoming fact with no matching local id is inserted.
- `importDump` with `merge: true`: events append-only — duplicate `id` is skipped, novel id is inserted.
- `importDump` without `merge`: existing local rows for entity are fully replaced.
- Merge is atomic per entity (partial import does not leave db in inconsistent state).

### Additions to existing tests

- `jobs.test.ts`: no changes needed (mutex logic unchanged).
- `ingest.test.ts`: no changes needed (ingest does not write tasks).
- `importDump.test.ts`: existing tests continue to pass; LWW tests live in `importDumpMerge.test.ts`.

---

## Acceptance Criteria

- [ ] FTS5 table created with `tokenize='porter unicode61'` on new install
- [ ] Existing install without porter tokenizer: `setup()` detects mismatch, rebuilds FTS5, repopulates from `entries` — all existing facts remain searchable
- [ ] `setup()` is idempotent: calling twice on a fully-migrated DB changes nothing
- [ ] Query `"running"` matches fact body `"User runs every morning"` (porter stemming)
- [ ] `synonymMap` expansion: query `"run"` returns facts mentioning `"jog"` when `synonymMap: { run: ['jog'] }`
- [ ] Token slice capped at 12 after expansion
- [ ] `importDump` with `merge: true`: incoming row with newer `updated_at` wins; older incoming row does not clobber newer local row
- [ ] `importDump` with `merge: true`: novel row ids are inserted regardless of direction
- [ ] Events are append-only in merge mode: duplicate ids are skipped
- [ ] Merge transaction is atomic per entity
- [ ] `WikiTask.resolution_note` is **not** added in this PR (deferred)
- [ ] All existing tests pass
- [ ] `npm run typecheck && npx vitest run` green

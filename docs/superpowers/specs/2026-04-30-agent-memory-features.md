# Spec: Agent Memory Features — resolution_note, porter stemmer, synonymMap

**Date:** 2026-04-30
**Status:** Ready
**Branch:** staging

---

## Problem

expo-llm-wiki's current design is optimised for simple chatbot memory. Two gaps surface when building agent-oriented consumers (e.g. clanker):

1. **Task resolution is lossy.** When a task moves to `done` or `abandoned`, there is no way to record *why*. The information is discarded the moment status changes. Downstream systems (heal pass, audit, cloud sync) lose context that would help the LLM understand what actually happened.

2. **Recall is limited by naive tokenisation.** `formatSearchQuery` strips punctuation, lower-cases, filters tokens to `len >= 3`, and joins with `"tok"* OR "tok"*`. This means:
   - `running`, `runs`, `ran` do **not** match a fact about `run` — they are different FTS5 tokens.
   - A query `"how was your jog?"` misses a fact titled `"User's morning run routine"` even though they describe the same activity.
   - There is no caller-supplied domain vocabulary (e.g. relationships terms, health synonyms).

---

## Goals

- Task `resolution_note` field: optional free-text populated when task resolves.
- FTS5 porter stemmer: morphological matching (run/running/runs/ran → same stem).
- Static `synonymMap` config: caller-supplied term expansions applied at query time; no DB writes.
- Backward-compatible schema migration (idempotent `ALTER TABLE`, FTS5 rebuild).
- All existing tests continue passing.

## Non-Goals

- Derived/dynamic synonyms computed from co-occurrence — dropped after evaluation (weak signal, cold-start useless, porter covers 80% of the gap).
- `due_context` task field — dropped (never consumed by any logic path; representable in description).
- Cross-entity synonym sharing.
- LLM-assisted synonym generation.

---

## Changes

### 1. `WikiTask.resolution_note`

**Type:**
```ts
resolution_note: string | null
```

**Schema:** add column to `{prefix}tasks`:
```sql
ALTER TABLE {prefix}tasks ADD COLUMN resolution_note TEXT;
```

**Migration strategy:** in `setup()`, after `CREATE TABLE IF NOT EXISTS {prefix}tasks`, run:
```sql
SELECT COUNT(*) FROM pragma_table_info('{prefix}tasks') WHERE name = 'resolution_note'
```
If count is 0, run the `ALTER TABLE`. Idempotent on re-run.

**`importDump` / `exportDump`:** include `resolution_note` in all task reads/writes. The field is nullable; existing dumps without it import cleanly (treated as `null`).

**Validation:** in `validateTask`, clip `resolution_note` to 400 chars (same `clip()` helper), accept `null`.

**Librarian prompt:** update `LIBRARIAN_SYSTEM_PROMPT` to include `resolution_note` in the task schema comment:
```
"tasks": [{ "description": "string", "priority": number (0-10), "resolution_note": "string|null" }]
```
The LLM may now populate it when closing a task.

**`ExtractedTask`:** add `resolution_note?: string | null`.

---

### 2. FTS5 Porter Stemmer

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
2. If the `sql` does not contain `porter`, rebuild:
   ```sql
   -- inside a transaction:
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
   -- Repopulate from live entries
   INSERT INTO {prefix}entries_fts(rowid, title, body, tags)
     SELECT rowid, title, body, tags FROM {prefix}entries WHERE deleted_at IS NULL;
   ```
   Triggers are recreated in the same transaction.

**One-time cost:** repopulation scans `entries`. For typical app sizes (<10k rows) this completes in well under 1 second. `setup()` is already called once on app start; consumers already await it.

**`formatSearchQuery` simplification:** porter handles morphology, so the JS-side tokenisation can stay the same — just lowercase → strip punctuation → `len >= 3` → expand synonyms (Section 3) → `"tok"* OR "tok"*`. No compromise.js. No lemmatization code.

---

### 3. `WikiConfig.synonymMap`

**Type:**
```ts
synonymMap?: Record<string, string[]>
```

**Behaviour:** in `formatSearchQuery`, after building the initial token list, for each token `t` check `synonymMap[t]`. Append all matching synonym values to the token list. Deduplicate. Slice to top 12 (raised from 6 to accommodate expansion).

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
Query `"how was your jog today?"` → tokens `['jog', 'today']` → no synonym for `today`; `jog` has no entry so it stays. Query `"how was your run?"` → tokens `['run']` → synonymMap expands to `['run', 'jog', 'sprint']` → FTS5 matches all three. (Porter additionally matches `running`, `ran`, etc. without synonyms.)

**No DB writes.** No migration. Purely in-memory expansion at query time. Caller can pass `undefined` (no expansion; existing behavior).

---

## `types.ts` Changes

```ts
// WikiTask — add field
export interface WikiTask {
  // ... existing fields ...
  resolution_note: string | null;   // NEW
}

// ExtractedTask — add optional field
export interface ExtractedTask {
  description: string;
  priority: number;
  resolution_note?: string | null;  // NEW
}

// WikiConfig — add field
export interface WikiConfig {
  // ... existing fields ...
  synonymMap?: Record<string, string[]>;  // NEW
}

// WikiSynonym — removed (derived synonyms dropped)
```

---

## `db/schema.ts` Changes

- Add `resolution_note TEXT` column to `{prefix}tasks` `CREATE TABLE` statement (for new installs).
- FTS5 `CREATE VIRTUAL TABLE` gains `tokenize='porter unicode61'`.
- No new tables.

---

## `WikiMemory.ts` Changes

- `setup()`: idempotent `ALTER TABLE` for `resolution_note`; FTS5 porter detection + rebuild.
- `formatSearchQuery()`: synonym expansion from `this.options.config?.synonymMap`; max tokens raised to 12.
- `_doRunLibrarian()`: INSERT for tasks includes `resolution_note` column.
- `importDump()` task path: read/write `resolution_note`.
- `exportDump()` / `_getFullBundle()`: `resolution_note` included in task rows (already present in `SELECT *`).
- `validateTask()`: clip and accept `resolution_note`.

---

## `prompts.ts` Changes

`LIBRARIAN_SYSTEM_PROMPT` task schema updated to include `resolution_note`:
```
"tasks": [{ "description": "string", "priority": number (0-10), "resolution_note": "string|null — reason task was resolved or abandoned, null if still open" }]
```

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

### New test file: `src/__tests__/resolutionNote.test.ts`

- `validateTask` with `resolution_note: "user confirmed done"` → clipped to 400 chars, preserved.
- `validateTask` with `resolution_note: null` → null preserved.
- `validateTask` with `resolution_note` absent → treated as null (no crash).
- `resolution_note` round-trips through `exportDump` / `importDump`.
- Librarian pass: `resolution_note` from LLM response is stored on the task row.

### New test file: `src/__tests__/porterStemmer.test.ts`

- After `setup()`, query `"running"` matches a fact with body `"User runs every morning"`.
- Query `"ran"` matches the same fact.
- Upgrade path: if FTS5 table exists without porter, `setup()` rebuilds it and existing facts are searchable via porter.
- Rebuild is idempotent: calling `setup()` twice does not drop facts.

### Additions to existing tests

- `jobs.test.ts`: no changes needed (mutex logic unchanged).
- `ingest.test.ts`: `resolution_note` absent from ingest flow (ingest only writes facts, not tasks from `ingestDocument`). No change needed.
- `importDump.test.ts`: add round-trip case for `resolution_note` on tasks.

---

## Acceptance Criteria

- [ ] `WikiTask.resolution_note` field exists; `null` by default; `importDump`/`exportDump` round-trips cleanly
- [ ] `validateTask` clips `resolution_note` to 400 chars; accepts `null`; accepts missing (treats as `null`)
- [ ] `ALTER TABLE` migration is idempotent: calling `setup()` on a DB that already has the column is a no-op
- [ ] `LIBRARIAN_SYSTEM_PROMPT` schema comment includes `resolution_note`
- [ ] FTS5 table created with `tokenize='porter unicode61'` on new install
- [ ] Existing install without porter tokenizer: `setup()` detects mismatch, rebuilds FTS5, repopulates from `entries` — all existing facts remain searchable
- [ ] `setup()` is idempotent: calling twice on a fully-migrated DB changes nothing
- [ ] Query `"running"` matches fact body `"User runs every morning"` (porter stemming)
- [ ] `synonymMap` expansion: query `"run"` returns facts mentioning `"jog"` when `synonymMap: { run: ['jog'] }`
- [ ] Token slice capped at 12 after expansion
- [ ] All existing tests pass
- [ ] `npm run typecheck && npm run lint && npx vitest run` green

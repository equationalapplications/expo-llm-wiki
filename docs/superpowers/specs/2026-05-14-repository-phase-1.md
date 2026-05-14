# Spec: Repository Infrastructure & Fact Migration

**Date:** 2026-05-14
**Status:** Draft
**Scope:** Establish the repository layer for `WikiFact` to centralize hydration and routine writes while preserving high-fidelity raw SQL paths for complex imports.

---

## 1. Repository Infrastructure

### Base Repository (`BaseRepository.ts`)

Provides the foundation for table prefixing and transactional awareness.

**Convention note:** `WikiMemory` passes `this.prefix` directly (e.g. `'llm_wiki_'`).
The existing `setupDatabase` interpolates `${prefix}entries`, producing `llm_wiki_entries`.
Repository queries must follow the same convention and **not** inject an extra underscore.

```typescript
import type { SQLiteAdapter } from '../../types';

export abstract class BaseRepository {
  constructor(
    protected db: SQLiteAdapter,
    protected prefix: string
  ) {}

  /**
   * Returns the provided transaction adapter or the default db adapter.
   * Ensures repositories participate in WikiMemory's existing transactions.
   */
  protected getExecutor(tx?: SQLiteAdapter): SQLiteAdapter {
    return tx || this.db;
  }
}

```

### Entry Repository (`EntryRepository.ts`)

Centralizes the hydration and atomic access for the `entries` table.

```typescript
import { BaseRepository } from './BaseRepository';
import type { WikiFact, SQLiteAdapter } from '../../types';

export class EntryRepository extends BaseRepository {
  /**
   * Centralized hydration. Strips vector blobs and safely parses tags.
   * Ensures strict type compliance with the WikiFact interface.
   */
  private mapRowToFact(row: any): WikiFact {
    if (!row) return row;

    // Destructure to handle the 'embedding' vs 'embedding_blob' logic.
    // Core WikiFact type uses 'embedding_blob' for the raw bytes.
    const { embedding: _textEmbed, ...rest } = row;

    let tags: string[] = [];
    try {
      tags = typeof rest.tags === 'string' ? JSON.parse(rest.tags) : (rest.tags || []);
    } catch {
      tags = [];
    }

    return {
      ...rest,
      tags,
      // Ensure numeric types are actually numbers (SQLite can return 1/0 for booleans)
      confidence: rest.confidence as WikiFact['confidence'],
      source_type: rest.source_type as WikiFact['source_type'],
      access_count: Number(rest.access_count || 0),
      created_at: Number(rest.created_at),
      updated_at: Number(rest.updated_at),
      last_accessed_at: rest.last_accessed_at != null ? Number(rest.last_accessed_at) : null,
    };
  }

  async findByIds(ids: string[], scopedEntityIds?: string[], tx?: SQLiteAdapter): Promise<WikiFact[]> {
    if (ids.length === 0) return [];
    const executor = this.getExecutor(tx);
    const chunkSize = 500;
    const entityClause = scopedEntityIds && scopedEntityIds.length > 0
      ? ` AND entity_id IN (${scopedEntityIds.map(() => '?').join(',')})`
      : '';
    const entityParams = scopedEntityIds && scopedEntityIds.length > 0 ? [...scopedEntityIds] : [];
    const rows: any[] = [];

    for (let i = 0; i < ids.length; i += chunkSize) {
      const idChunk = ids.slice(i, i + chunkSize);
      const placeholders = idChunk.map(() => '?').join(',');
      const chunkRows = await executor.getAllAsync<any>(
        `SELECT * FROM ${this.prefix}entries WHERE id IN (${placeholders})${entityClause} AND deleted_at IS NULL`,
        [...idChunk, ...entityParams]
      );
      rows.push(...chunkRows);
    }

    const byId = new Map(rows.map(row => [row.id, row]));
    return ids
      .map(id => byId.get(id))
      .filter((row): row is any => row !== undefined)
      .map(row => this.mapRowToFact(row));
  }

  /**
   * Transaction Handling Safety Note:
   * The `getExecutor(tx)` pattern ensures that when WikiMemory calls
   * `withTransactionAsync`, the repository correctly uses the transaction handle.
   * In `findByIds`, `executor.getAllAsync` is executed inside a loop. Since this
   * is usually called within a transaction in WikiMemory, this is performant.
   * If it were outside a transaction, SQLite would wrap each chunk in its own
   * implicit transaction, which is slower. Phase 1 preserves existing
   * transaction boundaries, so this remains safe.
   */

  /**
   * Targeted metadata fetch for runPrune().
   */
  async getPrunableMetadata(
    entityId: string,
    cutoff: number,
    tx?: SQLiteAdapter
  ): Promise<Array<{ id: string; entity_id: string }>> {
    const executor = this.getExecutor(tx);
    return await executor.getAllAsync<any>(
      `SELECT id, entity_id FROM ${this.prefix}entries
       WHERE entity_id = ? AND deleted_at IS NOT NULL AND deleted_at <= ?`,
      [entityId, cutoff]
    );
  }

  /**
   * Standard upsert for routine operations (e.g., ingestDocument).
   * NOTE: In SQLite, INSERT OR REPLACE is a DELETE + INSERT. This is safe
   * in Phase 1 as there are no FKs with ON DELETE CASCADE on this table.
   */
  async upsert(fact: WikiFact, tx?: SQLiteAdapter): Promise<void> {
    const executor = this.getExecutor(tx);
    const now = Date.now();

    await executor.runAsync(
      `INSERT OR REPLACE INTO ${this.prefix}entries (
        id, entity_id, title, body, tags, confidence, 
        source_type, source_hash, source_ref, 
        created_at, updated_at, last_accessed_at, access_count, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        fact.id, fact.entity_id, fact.title, fact.body, 
        JSON.stringify(fact.tags), fact.confidence,
        fact.source_type, fact.source_hash, fact.source_ref,
        fact.created_at || now, now, fact.last_accessed_at || null,
        fact.access_count || 0, fact.deleted_at || null
      ]
    );
  }

  async softDelete(id: string, tx?: SQLiteAdapter): Promise<void> {
    const executor = this.getExecutor(tx);
    const now = Date.now();
    await executor.runAsync(
      `UPDATE ${this.prefix}entries SET deleted_at = ?, updated_at = ? WHERE id = ?`,
      [now, now, id]
    );
  }
}

```

---

## 2. PR 1 Execution Strategy

### Initialization

In `WikiMemory.ts`, initialize the repository in the constructor to ensure availability for all downstream methods.

```typescript
private entryRepo: EntryRepository;

constructor(options: WikiOptions) {
  // ... existing setup ...
  this.entryRepo = new EntryRepository(this.db, this.prefix);
}

```

### Implementation Checklist

* **Hydration:** Replace manual SQL/parsing in `_hydrateFactsByIds` with `this.entryRepo.findByIds()`.
* **Targeted `forget()`:** Swap manual `UPDATE` for `this.entryRepo.softDelete(id)` **only** inside the `entryId` path. Bulk deletes remain raw SQL.
* **Pruning:** Replace raw `SELECT id, entity_id` in `runPrune()` with `this.entryRepo.getPrunableMetadata()`.
* **Scope Boundary:** `read()`, `_doRunLibrarian()`, and `_doRunHeal()` remain as inline SQL for Phase 1 hydration to prevent scope creep.
* **Import Integrity:** `_doImportEntity()` remains raw SQL to preserve its complex LWW merge and blob-handling logic.
* **Internal Access:** Repositories are internal and **not exported** from the public `index.ts`.

---

## 3. Future Alignment: The Outbox Pattern

Phase 1 establishes the **standardized write path** (`EntryRepository.upsert`). By centralizing routine state changes here, Phase 3 can simply inject an `OutboxRepository` call into the `upsert` method. This ensures that every fact change is staged for external synchronization automatically within the same local database transaction.

---

## 4. Review Notes & Spec Amendments

### 4.1 Table Prefixing — Verified ✅

`WikiMemory` sets `this.prefix = options.config?.tablePrefix || 'llm_wiki_'` (trailing underscore included).
`setupDatabase` interpolates `${prefix}entries`, producing `llm_wiki_entries`.
The spec's repository queries (`${this.prefix}entries`) match this convention exactly.
No spec change required.

### 4.2 `mapRowToFact` & `embedding_blob` — Minor Amendment ✅

The spec's `mapRowToFact` correctly strips `embedding` and passes `embedding_blob` through `...rest`.
However, `last_accessed_at` was missing numeric coercion. Added:

```typescript
last_accessed_at: rest.last_accessed_at != null ? Number(rest.last_accessed_at) : null,
```

This aligns with `WikiFact.last_accessed_at: number | null`.

**Future note:** `findByIds` currently uses `SELECT *`. If memory profiling in React Native shows spikes during large hydration cycles, a future optimization can explicitly exclude `embedding_blob` from the `SELECT` unless the caller requests it.

### 4.3 Error Handling in `upsert` — Verified ✅

`INSERT OR REPLACE` delegates constraint resolution to SQLite. Non-PK constraint violations will throw from `executor.runAsync` and propagate up.

`WikiMemory` methods (`ingestDocument`, `forget`, `runPrune`, etc.) already wrap their logic in `try/catch` or let errors bubble to the caller. `WikiBusyError` is thrown **before** any repository call, so it always takes precedence. No spec change required.

### 4.4 Testing Strategy — Verified ✅

The project already uses `better-sqlite3` via `packages/core/__tests__/helpers/sqliteAdapter.ts` for fast, in-memory unit tests.

Recommended isolated tests for `EntryRepository`:

1. **Tag parsing edge cases:**
   - Empty string `''` → `[]`
   - Malformed JSON `'{'` → `[]`
   - Already-parsed array `['a', 'b']` → `['a', 'b']`

2. **`findByIds` chunking:**
   - Pass 501 IDs → verify the loop executes twice (500 + 1).

3. **Soft delete timestamp verification:**
   - Call `softDelete(id)` → verify `deleted_at` and `updated_at` are set to the same timestamp.

4. **`getPrunableMetadata` boundary:**
   - Insert rows with `deleted_at` exactly at `cutoff`, one ms before, one ms after → verify only the "after" row is returned.

5. **`upsert` idempotency:**
   - Insert a fact, then upsert the same fact with modified `body` → verify the row is replaced and `updated_at` changes.

### 4.5 Table Name Escaping — Acknowledged ✅

For standard prefixes (`llm_wiki_`), direct string interpolation is standard practice across the codebase. If dynamic or user-provided prefixes are introduced in the future, add a shared `escapeIdentifier` utility. Not required for Phase 1.

---

### One Minor implementation "Gotcha"

When you implement the **`findByIds`** logic, keep an eye on the `entityClause`. Currently, it looks like this:

TypeScript

```
const entityClause = scopedEntityIds && scopedEntityIds.length > 0
  ? ` AND entity_id IN (${scopedEntityIds.map(() => '?').join(',')})`
  : '';
```

In your loop, you are appending `entityParams` to every chunk:

TypeScript

```
const chunkRows = await executor.getAllAsync<any>(
  `...`,
  [...idChunk, ...entityParams]
);
```

**Important:** If `scopedEntityIds` is very large (e.g., hundreds of entities), the combined count of `idChunk.length + entityParams.length` could theoretically hit the SQLite variable limit (usually 999).

- **Mitigation:** Since `WikiMemory` usually scopes to one or two entities at a time, this is likely a non-issue. If you ever expect `scopedEntityIds` to be large, you may need to reduce the `chunkSize` from 500 to something lower (like 250).
    

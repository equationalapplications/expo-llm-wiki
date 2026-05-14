# Spec: Repository Infrastructure & Fact Migration

**Date:** 2026-05-14
**Status:** Draft

**Phase 1 Spec** focuses on establishing the repository infrastructure and migrating the primary data entity (`WikiFact`) while maintaining strict compatibility with your existing transaction logic.

---

## Phase 1: Repository Infrastructure & Fact Migration

### 1. Base Repository (`BaseRepository.ts`)

This class provides the foundation for table prefixing and ensures that any repository can participate in a transaction (`tx`) or default to the main database instance.

```typescript
import type { SQLiteAdapter } from '../../types';

export abstract class BaseRepository {
  constructor(
    protected db: SQLiteAdapter,
    protected prefix: string
  ) {}

  /**
   * Returns the provided transaction adapter or the default db adapter.
   * This is critical for maintaining WikiMemory's transactional integrity.
   */
  protected getExecutor(tx?: SQLiteAdapter): SQLiteAdapter {
    return tx || this.db;
  }
}

```

### 2. Entry Repository (`EntryRepository.ts`)

This repository centralizes the hydration logic for `WikiFact` and provides atomic access to the `entries` table.

```typescript
import { BaseRepository } from './BaseRepository';
import type { WikiFact, SQLiteAdapter } from '../../types';

export class EntryRepository extends BaseRepository {
  /**
   * Centralized hydration logic. Ensures tags are parsed and platform-specific
   * vector columns are stripped from returned facts.
   */
  private mapRowToFact(row: any): WikiFact {
    if (!row) return row;
    const { embedding: _embedding, embedding_blob: _blob, ...rest } = row;
    return {
      ...rest,
      tags: typeof rest.tags === 'string' ? JSON.parse(rest.tags) : (rest.tags || []),
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
   * Returns metadata for entries that are soft-deleted and eligible for pruning.
   * Specific to the pruning use-case in runPrune().
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
   * Standard upsert for core wiki operations (ingestion, librarian updates,
   * manual edits). NOT for high-fidelity imports — _doImportEntity retains its
   * raw SQL path in Phase 1 to preserve LWW merge and blob-handling logic.
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
    // FUTURE HOOK: Outbox record will go here in Phase 3.
    // NOTE: In Phase 1, _doImportEntity may still need to retain its
    // raw SQL path for blob-preserving imports and LWW merge behavior.
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

## PR 1 Execution Strategy

### 1. Initialization

In `WikiMemory.ts`, initialize the repository in the constructor. This ensures all methods have access to it immediately.

```typescript
// Inside WikiMemory.ts
private entryRepo: EntryRepository;

constructor(options: WikiOptions) {
  // ... existing setup ...
  this.entryRepo = new EntryRepository(this.db, this.prefix);
}

```

### 2. Implementation Checklist

**Future Alignment:** Document that _doImportEntity should be migrated to the Repository in Phase 2 or 3 once the repository supports the specific conflict-resolution and blob-handling logic required for high-fidelity imports.
* **Replace Private Hydration:** Replace the manual SQL and JSON parsing in methods like `_hydrateFactsByIds` with `this.entryRepo.findByIds()`.
* **Refactor `forget()` (Partial):** Swap out the manual `UPDATE` query for `this.entryRepo.softDelete(id)` only within the `entryId` conditional path. Bulk deletes (entity/source) remain raw SQL for Phase 1.
* **Preserve Import Path Semantics:** Keep `_doImportEntity()` on the raw SQL path in Phase 1, because import needs blob preservation and merge/LWW/collision guard logic not yet captured by a simple repository upsert.
* **Maintenance Migration:** Replace the pruning query in `runPrune()` with `this.entryRepo.getPrunableMetadata(entityId, cutoff)`.
* **Scope Boundary:** `read()`, `_doRunLibrarian()`, and `_doRunHeal()` will continue to use inline SQL for hydration in Phase 1 to minimize regression risk.
* **Internal Access:** Repositories are internal to `@equationalapplications/expo-llm-wiki/core` and will not be exported from `index.ts`.

---

## Why this works for the Outbox Pattern

By the end of Phase 1, you have established the standardized write path (EntryRepository.upsert) for all core wiki operations (ingestion, librarian updates, and manual edits).

While _doImportEntity remains on a specialized raw path for this phase to preserve complex LWW (Last Write Wins) and blob semantics, the vast majority of state changes are now centralized. In Phase 3, adding an OutboxRepository call to this repository ensures that all routine data changes are automatically staged for external sync within the same local transaction.
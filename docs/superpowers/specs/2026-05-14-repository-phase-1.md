# Spec: FinanceBench Retrieval Benchmark

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
   * Centralized hydration logic. Ensures tags are parsed and 
   * platform-specific blobs are handled correctly.
   */
  private mapRowToFact(row: any): WikiFact {
    if (!row) return row;
    return {
      ...row,
      tags: typeof row.tags === 'string' ? JSON.parse(row.tags) : (row.tags || []),
      embedding_blob: row.embedding_blob || undefined,
    };
  }

  async findByIds(ids: string[], tx?: SQLiteAdapter): Promise<WikiFact[]> {
    if (ids.length === 0) return [];
    const executor = this.getExecutor(tx);
    const placeholders = ids.map(() => '?').join(',');
    
    const rows = await executor.getAllAsync<any>(
      `SELECT * FROM ${this.prefix}entries 
       WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
      ids
    );
    
    return rows.map(row => this.mapRowToFact(row));
  }

  /**
   * Optimized metadata fetch for background jobs (Librarian/Heal).
   */
  async getAllActiveMetadata(tx?: SQLiteAdapter): Promise<Array<{ id: string; entity_id: string }>> {
    const executor = this.getExecutor(tx);
    return await executor.getAllAsync<any>(
      `SELECT id, entity_id FROM ${this.prefix}entries WHERE deleted_at IS NULL`
    );
  }

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

* **Replace Private Hydration:** Replace the manual SQL and JSON parsing in methods like `_hydrateFactsByIds` with `this.entryRepo.findByIds()`.
* **Refactor `forget()`:** Swap out the manual `UPDATE` query for `this.entryRepo.softDelete(id)`.
* **Refactor `_doImportEntity()`:** Instead of raw `INSERT` strings, map the import data to `WikiFact` objects and call `this.entryRepo.upsert()`.
* **Standardize Metadata Queries:** Replace `SELECT id, entity_id` calls in maintenance routines with `this.entryRepo.getAllActiveMetadata()`.

---

## Why this works for the Outbox Pattern

By the end of Phase 1, you have a **single bottleneck** (`EntryRepository.upsert`) for all data changes. When you are ready to sync to an external database in Phase 3, you only need to add a single call to an `OutboxRepository` inside that `upsert` method. This guarantees that your local SQLite and external sync record are updated in the same transaction.
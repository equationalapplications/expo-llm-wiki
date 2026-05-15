# Spec: Phase 2 — Repository Completion & The Atomic Outbox

**Date:** 2026-05-14

**Status:** Implemented


**Scope:** Complete the Repository layer, implement the `OutboxRepository`, and integrate "Dual-Write" logic into the `EntryRepository`.

---

## 1. Outbox Schema (Background)

_Note: This assumes the `outbox` table is added via a migration in the core package._

- **Table:** `${prefix}outbox`
    
- **Columns:** `id (UUID/Text)`, `entity_id (Text)`, `table_name (Text)`, `record_id (Text)`, `operation (INSERT|UPDATE|DELETE)`, `payload (JSON)`, `created_at (Integer)`.
    

---

## 2. Part A: Completing the Repository Layer

We will extract the remaining SQL logic into three new repositories. This completely removes raw SQL strings from the high-level coordination logic in `WikiMemory`.

### 2.1 `TaskRepository.ts`

Handles all logic for the `tasks` table, including priority-based fetching used in `read()` and `runHeal()`.

- **Methods:** `findById(id)`, `findAllPending(entityId)`, `upsert(task, tx)`, `softDelete(id, tx)`.
- **Note:** `upsert` must use `ON CONFLICT(id) DO UPDATE` (not `INSERT OR REPLACE`) and accept `tx` as a **required** parameter to prevent transaction leaks.

### 2.2 `EventRepository.ts`

Handles the chronological event log.

- **Methods:** `add(event)`, `getRecent(entityId, limit)`, `prune(entityId, cutoff)`, `count(entityId)`.
    

### 2.3 `MetadataRepository.ts`

Manages the `meta` and `checkpoints` tables. This is critical for managing the "Librarian" and "Heal" state. Merging these into a single repository prevents constructor bloat and acknowledges they serve the same domain: **Internal Orchestration State**.

- **Methods:** `getCheckpoint(entityId)`, `updateCheckpoint(entityId, updates, tx)`, `getMeta(key)`, `setMeta(key, value, tx)`.
    

---

## 3. Part B: The Outbox Implementation

### 3.1 `OutboxRepository.ts`

This repository is "write-only" for the business logic. It provides a standard way to stage a change for external synchronization.

TypeScript

```
export class OutboxRepository extends BaseRepository {
  async push(params: {
    entityId: string,
    tableName: string,
    recordId: string,
    operation: 'INSERT' | 'UPDATE' | 'DELETE',
    payload: any
  }, tx: SQLiteAdapter): Promise<void> {
    const executor = this.getExecutor(tx);
    await executor.runAsync(
      `INSERT INTO ${this.prefix}outbox (id, entity_id, table_name, record_id, operation, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        generateId('out_'),
        params.entityId,
        params.tableName,
        params.recordId,
        params.operation,
        JSON.stringify(params.payload),
        Date.now()
      ]
    );
  }
}
```

---

## 4. Part C: The "Dual-Write" Integration

This is the core of Phase 2. We modify `EntryRepository` so that **every** state change automatically triggers an outbox entry. Because `WikiMemory` calls these inside a `withTransactionAsync` block, the fact update and the outbox entry are **guaranteed** to succeed or fail together.

### Updated `EntryRepository.upsert` (Logic):

TypeScript

```
async upsert(fact: WikiFact, tx: SQLiteAdapter): Promise<void> {
  const executor = this.getExecutor(tx);
  // 1. Perform the local SQLite update using ON CONFLICT (not INSERT OR REPLACE)
  await executor.runAsync(
    `INSERT INTO ${this.prefix}entries (...) VALUES (...)
     ON CONFLICT(id) DO UPDATE SET ...`,
    [...]
  );

  // 2. Stage the Outbox entry
  // This ensures your Postgres/Mongo/VectorDB gets the update!
  await this.outboxRepo.push({
    entityId: fact.entity_id,
    tableName: 'entries',
    recordId: fact.id,
    operation: 'UPDATE',
    payload: fact
  }, tx);
}
```

---

## 5. Part D: Decoupling Side Effects (SearchService) — Phase 2.5

Currently, `WikiMemory` manually calls `this.miniSearch.addAll()` and `this.vectorCache.delete()`. This is brittle, but extracting a **SearchService** in Phase 2 would risk making the PR unreviewable.

- **Phase 2 approach:** Leave `miniSearch` indexing and `vectorCache` eviction in `WikiMemory`. Group all search-sync calls at the **end** of each transaction so they happen after all repository writes are committed.
- **Phase 2.5 approach (immediate follow-up):** Introduce a dedicated `SearchService` that coordinates these in-memory side effects. This ensures `MiniSearch` and the `vectorCache` stay in sync with the database.
- **Benefit:** In Phase 3, we can move this to a subscriber model, but for Phase 2, the search logic remains embedded but cleanly grouped.
    

---

## 6. PR 2 Execution Strategy

### Implementation Checklist

1. **Repo Proliferation:** Create `TaskRepository`, `EventRepository`, `MetadataRepository`, and `OutboxRepository`.
    
2. **Dependency Injection:** Inject `OutboxRepository` into `EntryRepository` and `TaskRepository`.
    
3. **WikiMemory Cleanup:**
    
    - Replace `this.db.runAsync` in `write()` with `this.eventRepo.add()`.
        
    - Replace `this.db.getAllAsync` in `read()` (for tasks/events) with `this.taskRepo.findAllPending()` and `this.eventRepo.getRecent()`.
        
    - Replace checkpoint logic in `runLibrarian` with `this.metadataRepo.updateCheckpoint()`.
        
4. **The Dual-Write:** Enable outbox pushing in `EntryRepository` and `TaskRepository`.
    
5. **SearchService:** Leave `miniSearch` and `vectorCache` in `WikiMemory` for Phase 2. Group search-sync calls at the end of each transaction. Extract to `SearchService` in Phase 2.5.
    

### Verification Strategy

- **Outbox Totality:** Verify that calling `ingestDocument` results in $N$ entries in the `entries` table and exactly $N$ entries in the `outbox` table.
    
- **Transaction Integrity:** Force an error during the `outboxRepo.push` call (e.g., mock a constraint violation) and verify that the `entries` update is **rolled back** in the local SQLite DB.
    
- **Performance:** Measure the overhead of the extra `INSERT` into the outbox. (Estimated: $< 2\text{ms}$ per record).
    

---

## Summary of the Architecture at v4.7.0

1. **`WikiMemory.ts`**: Higher-level "Orchestrator." It handles the LLM logic and tells the Repositories what to do. Search-sync calls (`miniSearch`, `vectorCache`) remain here in Phase2, grouped at the end of transactions.
    
2. **`EntryRepository` / `TaskRepository`**: The "Authoritative Data Layer." They handle the SQLite work **and** the Outbox staging. All mutating methods require `tx: SQLiteAdapter`.
    
3. **`OutboxRepository`**: The "Sync Staging Area."
    
4. **`MetadataRepository`**: Manages `meta` and `checkpoints` tables for internal orchestration state.
    
5. **`SearchService`** (Phase2.5): The future "In-Memory Index Manager" to be extracted in the next PR.

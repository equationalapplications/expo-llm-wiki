import { describe, it, expect, vi } from 'vitest';
import type { MemoryDump } from '../src/types';
import { WikiMemory, WikiBusyError } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';

class MockSQLiteDatabase {
    private entries: Array<Record<string, any>> = [];
    private tasks: Array<Record<string, any>> = [];
    private events: Array<Record<string, any>> = [];

    async execAsync(_sql: string): Promise<void> {}

    async withTransactionAsync<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      return fn(this);
    }

    async runAsync(sql: string, args: any[] = []): Promise<{ changes: number; lastInsertRowId: number }> {
      const normalized = sql.replace(/\s+/g, ' ').trim();

      if (normalized.startsWith('UPDATE') && normalized.includes('entries SET deleted_at = ?, updated_at = ? WHERE entity_id = ? AND deleted_at IS NULL')) {
        const [deletedAt, updatedAt, entityId] = args;
        let changes = 0;
        for (const entry of this.entries) {
          if (entry.entity_id === entityId && entry.deleted_at == null) {
            entry.deleted_at = deletedAt;
            entry.updated_at = updatedAt;
            changes++;
          }
        }
        return { changes, lastInsertRowId: 0 };
      }

      if (normalized.startsWith('UPDATE') && normalized.includes('tasks SET deleted_at = ?, updated_at = ? WHERE entity_id = ? AND deleted_at IS NULL')) {
        const [deletedAt, updatedAt, entityId] = args;
        let changes = 0;
        for (const task of this.tasks) {
          if (task.entity_id === entityId && task.deleted_at == null) {
            task.deleted_at = deletedAt;
            task.updated_at = updatedAt;
            changes++;
          }
        }
        return { changes, lastInsertRowId: 0 };
      }

      if (normalized.startsWith('UPDATE') && normalized.includes('entries SET entity_id = ?') && normalized.includes('embedding_blob = ?, embedding = NULL WHERE id = ?')) {
        // UPDATE with preserved BLOB
        const [entity_id, title, body, tags, confidence, source_type, source_hash, source_ref, created_at, updated_at, last_accessed_at, access_count, deleted_at, embedding_blob, id] = args;
        const idx = this.entries.findIndex((e) => e.id === id);
        if (idx >= 0) {
          this.entries[idx] = { id, entity_id, title, body, tags, confidence, source_type, source_hash, source_ref, created_at, updated_at, last_accessed_at, access_count, deleted_at, embedding_blob, embedding: null };
          return { changes: 1, lastInsertRowId: 0 };
        }
        return { changes: 0, lastInsertRowId: 0 };
      }

      if (normalized.startsWith('UPDATE') && normalized.includes('entries SET entity_id = ?') && normalized.includes('embedding_blob = NULL, embedding = NULL WHERE id = ?')) {
        const [entity_id, title, body, tags, confidence, source_type, source_hash, source_ref, created_at, updated_at, last_accessed_at, access_count, deleted_at, id] = args;
        const idx = this.entries.findIndex((e) => e.id === id);
        if (idx >= 0) {
          this.entries[idx] = { id, entity_id, title, body, tags, confidence, source_type, source_hash, source_ref, created_at, updated_at, last_accessed_at, access_count, deleted_at, embedding_blob: null, embedding: null };
          return { changes: 1, lastInsertRowId: 0 };
        }
        return { changes: 0, lastInsertRowId: 0 };
      }

      if (normalized.startsWith('UPDATE') && normalized.includes('tasks SET entity_id = ?, description = ?, status = ?, priority = ?, created_at = ?, updated_at = ?, resolved_at = ?, deleted_at = ? WHERE id = ?')) {
        const [entity_id, description, status, priority, created_at, updated_at, resolved_at, deleted_at, id] = args;
        const idx = this.tasks.findIndex((t) => t.id === id);
        if (idx >= 0) {
          this.tasks[idx] = { id, entity_id, description, status, priority, created_at, updated_at, resolved_at, deleted_at };
          return { changes: 1, lastInsertRowId: 0 };
        }
        return { changes: 0, lastInsertRowId: 0 };
      }

      if (normalized.startsWith('INSERT INTO') && normalized.includes('entries (id, entity_id, title, body, tags, confidence, source_type, source_hash, source_ref, created_at, updated_at, last_accessed_at, access_count, deleted_at, embedding_blob, embedding)')) {
        const [id, entity_id, title, body, tags, confidence, source_type, source_hash, source_ref, created_at, updated_at, last_accessed_at, access_count, deleted_at, embedding_blob] = args;
        const idx = this.entries.findIndex((e) => e.id === id);
        const entry = { id, entity_id, title, body, tags, confidence, source_type, source_hash, source_ref, created_at, updated_at, last_accessed_at, access_count, deleted_at, embedding_blob, embedding: null };
        if (idx >= 0) { this.entries[idx] = entry; } else { this.entries.push(entry); }
        return { changes: 1, lastInsertRowId: 0 };
      }

      if (normalized.startsWith('INSERT INTO') && normalized.includes('entries (id, entity_id, title, body, tags, confidence, source_type, source_hash, source_ref, created_at, updated_at, last_accessed_at, access_count, deleted_at, embedding_blob)')) {
        const [id, entity_id, title, body, tags, confidence, source_type, source_hash, source_ref, created_at, updated_at, last_accessed_at, access_count, deleted_at, embedding_blob] = args;
        this.entries.push({ id, entity_id, title, body, tags, confidence, source_type, source_hash, source_ref, created_at, updated_at, last_accessed_at, access_count, deleted_at, embedding_blob });
        return { changes: 1, lastInsertRowId: 0 };
      }

      if (normalized.startsWith('INSERT INTO') && normalized.includes('entries (id, entity_id, title, body, tags, confidence, source_type, source_hash, source_ref, created_at, updated_at, last_accessed_at, access_count, deleted_at)')) {
        const [id, entity_id, title, body, tags, confidence, source_type, source_hash, source_ref, created_at, updated_at, last_accessed_at, access_count, deleted_at] = args;
        this.entries.push({ id, entity_id, title, body, tags, confidence, source_type, source_hash, source_ref, created_at, updated_at, last_accessed_at, access_count, deleted_at });
        return { changes: 1, lastInsertRowId: 0 };
      }

      if (normalized.startsWith('INSERT INTO') && normalized.includes('tasks (id, entity_id, description, status, priority, created_at, updated_at, resolved_at, deleted_at)')) {
        const [id, entity_id, description, status, priority, created_at, updated_at, resolved_at, deleted_at] = args;
        this.tasks.push({ id, entity_id, description, status, priority, created_at, updated_at, resolved_at, deleted_at });
        return { changes: 1, lastInsertRowId: 0 };
      }

      if (normalized.startsWith('INSERT OR IGNORE INTO') && normalized.includes('events (id, entity_id, event_type, summary, related_entry_id, created_at)')) {
        const [id, entity_id, event_type, summary, related_entry_id, created_at] = args;
        const exists = this.events.some((e) => e.id === id);
        if (!exists) {
          this.events.push({ id, entity_id, event_type, summary, related_entry_id, created_at });
          return { changes: 1, lastInsertRowId: 0 };
        }
        return { changes: 0, lastInsertRowId: 0 };
      }

      return { changes: 0, lastInsertRowId: 0 };
    }

    async getAllAsync<T>(sql: string, args: any[] = []): Promise<T[]> {
      const normalized = sql.replace(/\s+/g, ' ').trim();

      if (normalized.startsWith('SELECT rowid, source_ref FROM') && normalized.includes('entries')) {
        return [] as T[];
      }

      if (normalized.startsWith('SELECT id, entity_id') && normalized.includes('entries WHERE id IN')) {
        return this.entries
          .filter((e) => args.includes(e.id))
          .map((e) => ({ id: e.id, entity_id: e.entity_id, updated_at: e.updated_at })) as T[];
      }

      if (normalized.startsWith('SELECT id, entity_id') && normalized.includes('tasks WHERE id IN')) {
        return this.tasks
          .filter((t) => args.includes(t.id))
          .map((t) => ({ id: t.id, entity_id: t.entity_id, updated_at: t.updated_at })) as T[];
      }

      if (normalized.startsWith('SELECT DISTINCT entity_id FROM (')) {
        const entityIds = new Set<string>();
        for (const row of this.entries) {
          if (row.deleted_at == null) entityIds.add(row.entity_id);
        }
        for (const row of this.tasks) {
          if (row.deleted_at == null) entityIds.add(row.entity_id);
        }
        for (const row of this.events) {
          entityIds.add(row.entity_id);
        }
        return Array.from(entityIds).map((entity_id) => ({ entity_id })) as T[];
      }

      if (normalized.startsWith('SELECT * FROM') && normalized.includes('entries WHERE entity_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC')) {
        const [entityId] = args;
        return this.entries
          .filter((e) => e.entity_id === entityId && e.deleted_at == null)
          .sort((a, b) => b.updated_at - a.updated_at) as T[];
      }

      if (normalized.startsWith('SELECT * FROM') && normalized.includes('tasks WHERE entity_id = ? AND deleted_at IS NULL ORDER BY priority DESC, created_at ASC')) {
        const [entityId] = args;
        return this.tasks
          .filter((t) => t.entity_id === entityId && t.deleted_at == null)
          .sort((a, b) => b.priority - a.priority || a.created_at - b.created_at) as T[];
      }

      if (normalized.startsWith('SELECT * FROM') && normalized.includes('events WHERE entity_id = ? ORDER BY created_at DESC LIMIT 10')) {
        const [entityId] = args;
        return this.events
          .filter((e) => e.entity_id === entityId)
          .sort((a, b) => b.created_at - a.created_at)
          .slice(0, 10) as T[];
      }

      if (normalized.startsWith('SELECT * FROM') && normalized.includes('events WHERE entity_id = ? ORDER BY created_at ASC')) {
        const [entityId] = args;
        return this.events
          .filter((e) => e.entity_id === entityId)
          .sort((a, b) => a.created_at - b.created_at) as T[];
      }

      return [] as T[];
    }

    async getFirstAsync<T>(sql: string, args: any[] = []): Promise<T | null> {
      const normalized = sql.replace(/\s+/g, ' ').trim();

      if (normalized.startsWith('SELECT id, entity_id FROM') && normalized.includes('entries WHERE id = ?')) {
        const [id] = args;
        const found = this.entries.find((e) => e.id === id);
        return found ? ({ id: found.id, entity_id: found.entity_id } as T) : null;
      }

      if (normalized.startsWith('SELECT id, entity_id FROM') && normalized.includes('tasks WHERE id = ?')) {
        const [id] = args;
        const found = this.tasks.find((t) => t.id === id);
        return found ? ({ id: found.id, entity_id: found.entity_id } as T) : null;
      }

      if (normalized.startsWith('SELECT * FROM') && normalized.includes('checkpoints WHERE entity_id = ?')) {
        return null;
      }

      return null;
    }
  }

const noopProvider = { generateText: async (_: any) => '{"facts":[],"tasks":[]}' };

async function freshWiki(prefix: string) {
  const db = openTestDatabase();
  const wiki = new WikiMemory(db, { llmProvider: noopProvider, config: { tablePrefix: prefix } });
  await wiki.setup();
  return wiki;
}

function makeDump(entityId: string, factId = 'f1'): MemoryDump {
  return {
    generatedAt: Date.now(),
    entities: {
      [entityId]: {
        facts: [{
          id: factId,
          entity_id: entityId,
          title: 'Test Fact',
          body: 'Test body content here',
          tags: ['tag1'],
          confidence: 'certain',
          source_type: 'immutable_document',
          source_hash: null,
          source_ref: 'test.pdf',
          created_at: 1000,
          updated_at: 1000,
          last_accessed_at: null,
          access_count: 0,
          deleted_at: null,
        }],
        tasks: [{
          id: 'task1',
          entity_id: entityId,
          description: 'Test task',
          status: 'pending',
          priority: 5,
          created_at: 1000,
          updated_at: 1000,
          resolved_at: null,
          deleted_at: null,
        }],
        events: [{
          id: `ev_${factId}`,
          entity_id: entityId,
          event_type: 'observation',
          summary: 'test event',
          created_at: 1000,
        }],
      },
    },
  };
}

describe('importDump', () => {
  it('default merge:false clears then inserts', async () => {
    const wiki = await freshWiki('imp1_');
    // First import
    await wiki.importDump(makeDump('e', 'f1'));
    // Second import with merge:false (default) - should clear then re-insert
    await wiki.importDump(makeDump('e', 'f2'));
    const out = await wiki.exportDump(['e']);
    // Should have facts from second import only (f2), not f1
    expect(out.entities.e.facts.length).toBe(1);
    expect(out.entities.e.facts[0].id).toBe('f2');
    // Events are always appended - both imports' events present
    expect(out.entities.e.events.length).toBe(2);
  });

  it('merge:true skips existing fact ids', async () => {
    const wiki = await freshWiki('imp2_');
    await wiki.importDump(makeDump('e', 'f1'));
    // Second import with same id and merge:true - should skip
    await wiki.importDump(makeDump('e', 'f1'), { merge: true });
    const out = await wiki.exportDump(['e']);
    expect(out.entities.e.facts.length).toBe(1);
  });

  it('merge:true inserts new fact ids', async () => {
    const wiki = await freshWiki('imp3_');
    await wiki.importDump(makeDump('e', 'f1'));
    // Second import with different id and merge:true - should insert
    await wiki.importDump(makeDump('e', 'f2'), { merge: true });
    const out = await wiki.exportDump(['e']);
    expect(out.entities.e.facts.length).toBe(2);
  });
});

describe('importDump — legacy source_type guard', () => {
  it('fails before any import writes when the DB already has legacy source_type rows', async () => {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, { llmProvider: { generateText: async () => '{}' } });
    await wiki.setup();
    await db.runAsync(
      `INSERT INTO llm_wiki_entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['legacy-row', 'e-legacy', 't', 'b', '[]', 'certain', 'user_document', 1, 1],
    );

    const entityIdNew = 'e-fresh';
    await expect(wiki.importDump(makeDump(entityIdNew, 'f-target'))).rejects.toThrow(/legacy source_type/);

    const row = await db.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) as n FROM llm_wiki_entries WHERE entity_id = ?`,
      [entityIdNew],
    );
    expect(row?.n ?? 0).toBe(0);
  });
});

describe('importDump — busy-key protection', () => {
  function makeRealWiki() {
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, { llmProvider: { generateText: async () => '{}' } });
    return { wiki, db };
  }

  function simpleDump(entityId: string): MemoryDump {
    return {
      generatedAt: Date.now(),
      entities: {
        [entityId]: { facts: [], tasks: [], events: [] },
      },
    };
  }

  it('throws WikiBusyError(import) when called concurrently for the same entity', async () => {
    const { wiki } = makeRealWiki();
    await wiki.setup();

    // Start an import that won't finish until we release it.
    let resolveImport: () => void = () => {};
    const blocker = new Promise<void>((r) => { resolveImport = r; });

    const slowDump: MemoryDump = {
      generatedAt: Date.now(),
      entities: {
        'user-1': {
          facts: [{
            id: 'f-slow',
            entity_id: 'user-1',
            title: 'slow',
            body: 'body',
            tags: [],
            confidence: 'certain',
            source_type: 'user_stated',
            source_hash: null,
            source_ref: null,
            created_at: 1000,
            updated_at: 1000,
            last_accessed_at: null,
            access_count: 0,
            deleted_at: null,
          }],
          tasks: [],
          events: [],
        },
      },
    };

    // Patch importDump to hang after the import key is acquired.
    const originalDo = (wiki as any)._doImportEntity.bind(wiki);
    (wiki as any)._doImportEntity = async (entityId: string, bundle: any, merge: boolean) => {
      await blocker;
      return originalDo(entityId, bundle, merge);
    };

    const firstImport = wiki.importDump(slowDump);

    // Give the first import a tick to acquire the lock.
    await new Promise((r) => setTimeout(r, 0));

    // Second import on same entity must throw immediately.
    await expect(wiki.importDump(simpleDump('user-1'))).rejects.toBeInstanceOf(WikiBusyError);
    const err = await wiki.importDump(simpleDump('user-1')).catch((e) => e);
    expect(err.operation).toBe('import');
    expect(err.entityId).toBe('user-1');

    resolveImport();
    await firstImport;
  });

  it('throws WikiBusyError(import, *) when called concurrently for different entities', async () => {
    const { wiki } = makeRealWiki();
    await wiki.setup();

    let releaseLegacyProbe: () => void = () => {};
    const legacyProbeBlocker = new Promise<void>((r) => { releaseLegacyProbe = r; });
    const originalAssert = (wiki as any).assertNoLegacySourceTypes.bind(wiki);
    let assertCalls = 0;

    // Hold the first import inside the legacy probe to ensure the second call
    // races exactly at the lock-check/acquire boundary.
    (wiki as any).assertNoLegacySourceTypes = async () => {
      assertCalls += 1;
      if (assertCalls === 1) {
        await legacyProbeBlocker;
      }
      return originalAssert();
    };

    const firstImport = wiki.importDump(simpleDump('user-1'));
    await new Promise((r) => setTimeout(r, 0));

    let secondErr: unknown;
    let secondSettled = false;
    const secondImport = wiki
      .importDump(simpleDump('user-2'))
      .catch((e) => {
        secondErr = e;
      })
      .finally(() => {
        secondSettled = true;
      });

    await new Promise((r) => setTimeout(r, 10));
    expect(secondSettled).toBe(true);
    expect(secondErr).toBeInstanceOf(WikiBusyError);
    expect((secondErr as WikiBusyError).operation).toBe('import');
    expect((secondErr as WikiBusyError).entityId).toBe('*');

    releaseLegacyProbe();
    await firstImport;
    await secondImport;
  });

  it('runLibrarian() throws WikiBusyError(import) while importDump is in-flight', async () => {
    const { wiki } = makeRealWiki();
    await wiki.setup();

    let resolveImport: () => void = () => {};
    const blocker = new Promise<void>((r) => { resolveImport = r; });
    const originalDo = (wiki as any)._doImportEntity.bind(wiki);
    (wiki as any)._doImportEntity = async (entityId: string, bundle: any, merge: boolean) => {
      await blocker;
      return originalDo(entityId, bundle, merge);
    };

    const imp = wiki.importDump(simpleDump('user-1'));
    await new Promise((r) => setTimeout(r, 0));

    const err = await wiki.runLibrarian('user-1').catch((e) => e);
    expect(err).toBeInstanceOf(WikiBusyError);
    expect(err.operation).toBe('import');

    resolveImport();
    await imp;
  });

  it('importDump() throws WikiBusyError(librarian) while runLibrarian is in-flight', async () => {
    const { wiki } = makeRealWiki();
    await wiki.setup();

    let resolveLibrarian: () => void = () => {};
    const blocker = new Promise<void>((r) => { resolveLibrarian = r; });
    const originalDo = (wiki as any)._doRunLibrarian.bind(wiki);
    (wiki as any)._doRunLibrarian = async (entityId: string) => {
      await blocker;
      return originalDo(entityId);
    };

    const lib = wiki.runLibrarian('user-1');
    await new Promise((r) => setTimeout(r, 0));

    const err = await wiki.importDump(simpleDump('user-1')).catch((e) => e);
    expect(err).toBeInstanceOf(WikiBusyError);
    expect(err.operation).toBe('librarian');

    resolveLibrarian();
    await lib;
  });

  it('forget() throws WikiBusyError(import) while importDump is in-flight', async () => {
    const { wiki } = makeRealWiki();
    await wiki.setup();

    let resolveImport: () => void = () => {};
    const blocker = new Promise<void>((r) => { resolveImport = r; });
    const originalDo = (wiki as any)._doImportEntity.bind(wiki);
    (wiki as any)._doImportEntity = async (entityId: string, bundle: any, merge: boolean) => {
      await blocker;
      return originalDo(entityId, bundle, merge);
    };

    const imp = wiki.importDump(simpleDump('user-1'));
    await new Promise((r) => setTimeout(r, 0));

    const err = await wiki.forget('user-1', { clearAll: true }).catch((e) => e);
    expect(err).toBeInstanceOf(WikiBusyError);
    expect(err.operation).toBe('import');

    resolveImport();
    await imp;
  });

  it('importDump() throws WikiBusyError(forget) while forget is in-flight', async () => {
    const { wiki } = makeRealWiki();
    await wiki.setup();

    // Patch forget to stall mid-execution so the import race is detectable
    let resolveForget: () => void = () => {};
    const blocker = new Promise<void>((r) => { resolveForget = r; });
    const originalRebuild = (wiki as any).rebuildMiniSearchIndex.bind(wiki);
    (wiki as any).rebuildMiniSearchIndex = async (entityId: string) => {
      await blocker;
      return originalRebuild(entityId);
    };

    const forget = wiki.forget('user-1', { clearAll: true });
    await new Promise((r) => setTimeout(r, 0));

    const err = await wiki.importDump(simpleDump('user-1')).catch((e) => e);
    expect(err).toBeInstanceOf(WikiBusyError);
    expect(err.operation).toBe('forget');

    resolveForget();
    await forget;
  });

  it('write() does not start background librarian while importDump is in-flight for same entity', async () => {
    const { wiki } = makeRealWiki();
    await wiki.setup();

    // Reduce threshold so write() would normally trigger background librarian
    (wiki as any).options.config = { autoLibrarianThreshold: 1 };

    let resolveImport: () => void = () => {};
    const blocker = new Promise<void>((r) => { resolveImport = r; });
    const originalDo = (wiki as any)._doImportEntity.bind(wiki);
    (wiki as any)._doImportEntity = async (entityId: string, bundle: any, merge: boolean) => {
      await blocker;
      return originalDo(entityId, bundle, merge);
    };

    const imp = wiki.importDump(simpleDump('user-1'));
    await new Promise((r) => setTimeout(r, 0));

    const librarianSpy = vi.spyOn(wiki as any, '_doRunLibrarian');

    // write() should not start background librarian because import is active
    await wiki.write('user-1', { event_type: 'observation', summary: 'test' });
    await new Promise((r) => setTimeout(r, 10));

    expect(librarianSpy).not.toHaveBeenCalled();

    resolveImport();
    await imp;
    librarianSpy.mockRestore();
  });
});

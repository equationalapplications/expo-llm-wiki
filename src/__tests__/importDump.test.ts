import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WikiMemory } from '../WikiMemory';
import type { MemoryDump } from '../types';

class MockSQLiteDatabase {
  private entries: Array<Record<string, any>> = [];
  private tasks: Array<Record<string, any>> = [];
  private events: Array<Record<string, any>> = [];

  async execAsync(_sql: string): Promise<void> {}

  async withTransactionAsync<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
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

    if (normalized.startsWith('UPDATE') && normalized.includes('entries SET entity_id = ?, title = ?, body = ?, tags = ?, confidence = ?, source_type = ?, source_hash = ?, source_ref = ?, created_at = ?, updated_at = ?, last_accessed_at = ?, access_count = ?, deleted_at = ? WHERE id = ?')) {
      const [entity_id, title, body, tags, confidence, source_type, source_hash, source_ref, created_at, updated_at, last_accessed_at, access_count, deleted_at, id] = args;
      const idx = this.entries.findIndex((e) => e.id === id);
      if (idx >= 0) {
        this.entries[idx] = { id, entity_id, title, body, tags, confidence, source_type, source_hash, source_ref, created_at, updated_at, last_accessed_at, access_count, deleted_at };
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

    if (normalized.startsWith('SELECT id, entity_id FROM') && normalized.includes('entries WHERE id IN')) {
      return this.entries
        .filter((e) => args.includes(e.id))
        .map((e) => ({ id: e.id, entity_id: e.entity_id })) as T[];
    }

    if (normalized.startsWith('SELECT id, entity_id FROM') && normalized.includes('tasks WHERE id IN')) {
      return this.tasks
        .filter((t) => args.includes(t.id))
        .map((t) => ({ id: t.id, entity_id: t.entity_id })) as T[];
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

vi.mock('expo-sqlite', () => {
  return {
    openDatabaseAsync: async (_name: string) => new MockSQLiteDatabase(),
  };
});

const SQLite = await import('expo-sqlite');

const noopProvider = { generateText: async (_: any) => '{"facts":[],"tasks":[]}' };

beforeEach(() => {
  vi.clearAllMocks();
});

async function freshWiki(prefix: string) {
  const db = await SQLite.openDatabaseAsync(':memory:');
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
          source_type: 'user_document',
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

import { describe, it, expect, vi } from 'vitest';

vi.mock('expo-sqlite', () => {
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

      if (normalized.startsWith('INSERT INTO') && normalized.includes('events (id, entity_id, event_type, summary, related_entry_id, created_at)')) {
        const [id, entity_id, event_type, summary, related_entry_id, created_at] = args;
        this.events.push({ id, entity_id, event_type, summary, related_entry_id, created_at });
        return { changes: 1, lastInsertRowId: 0 };
      }

      return { changes: 0, lastInsertRowId: 0 };
    }

    async getAllAsync<T>(sql: string, args: any[] = []): Promise<T[]> {
      const normalized = sql.replace(/\s+/g, ' ').trim();

      if (normalized.startsWith('SELECT rowid, source_ref FROM') && normalized.includes('entries')) {
        return [] as T[];
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

      if (normalized.startsWith('SELECT COUNT(*) as count FROM') && normalized.includes('events WHERE entity_id = ?')) {
        const [entityId] = args;
        const count = this.events.filter((e) => e.entity_id === entityId).length;
        return { count } as T;
      }

      if (normalized.startsWith('SELECT * FROM') && normalized.includes('checkpoints WHERE entity_id = ?')) {
        return null;
      }

      return null;
    }
  }

  return {
    openDatabaseAsync: async (_name: string) => new MockSQLiteDatabase(),
  };
});

const SQLite = await import('expo-sqlite');
const { WikiMemory } = await import('../src/WikiMemory');

const noopProvider = { generateText: async (_: any) => '{"facts":[],"tasks":[]}' };

async function freshWiki() {
  const db = await SQLite.openDatabaseAsync(':memory:');
  const wiki = new WikiMemory(db, { llmProvider: noopProvider, config: { tablePrefix: 'exp_' } });
  await wiki.setup();
  return wiki;
}

describe('exportDump', () => {
  it('returns empty entities when nothing exists', async () => {
    const wiki = await freshWiki();
    const dump = await wiki.exportDump();
    expect(Object.keys(dump.entities)).toHaveLength(0);
    expect(typeof dump.generatedAt).toBe('number');
  });

  it('exports all entities when entityIds omitted', async () => {
    const wiki = await freshWiki();
    // Write events to create entity records
    await wiki.write('a', { event_type: 'observation', summary: 'test event a' });
    await wiki.write('b', { event_type: 'observation', summary: 'test event b' });
    const dump = await wiki.exportDump();
    expect(Object.keys(dump.entities).sort()).toEqual(['a', 'b']);
  });

  it('exports only requested entities', async () => {
    const wiki = await freshWiki();
    await wiki.write('a', { event_type: 'observation', summary: 'test a' });
    await wiki.write('b', { event_type: 'observation', summary: 'test b' });
    const dump = await wiki.exportDump(['a']);
    expect(Object.keys(dump.entities)).toEqual(['a']);
  });

  it('generatedAt is a recent timestamp', async () => {
    const wiki = await freshWiki();
    const before = Date.now();
    const dump = await wiki.exportDump();
    const after = Date.now();
    expect(dump.generatedAt).toBeGreaterThanOrEqual(before);
    expect(dump.generatedAt).toBeLessThanOrEqual(after);
  });
});

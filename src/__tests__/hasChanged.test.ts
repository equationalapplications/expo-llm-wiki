import { describe, it, expect, vi } from 'vitest';

// ── Mock factory ─────────────────────────────────────────────────────────────

type EntryRow = {
  entity_id: string;
  source_ref: string | null;
  source_hash: string | null;
  deleted_at: number | null;
  updated_at: number;
};

function makeMockDb(entries: EntryRow[] = []) {
  return {
    async execAsync(_sql: string): Promise<void> {},
    async runAsync(_sql: string, _args: any[] = []): Promise<void> {},
    async getFirstAsync<T>(sql: string, args: any[] = []): Promise<T | null> {
      // Meta version check (for setup)
      if (sql.includes('schema_version')) return { value: '1' } as any;
      // Entries table existence check (for setup)
      if (sql.includes('sqlite_master') && !sql.includes('fts')) return { name: 'llm_wiki_entries' } as any;
      // FTS check (for setup)
      if (sql.includes('sqlite_master') && sql.includes('fts')) return { sql: `tokenize='porter unicode61'` } as any;
      // hasChanged query
      if (sql.includes('source_ref') && sql.includes('deleted_at IS NULL')) {
        const entityId = args[0];
        const sourceRef = args[1];
        const matches = entries
          .filter(e => e.entity_id === entityId && e.source_ref === sourceRef && e.deleted_at === null)
          .sort((a, b) => b.updated_at - a.updated_at);
        if (matches.length === 0) return null;
        return matches[0] as any;
      }
      return null;
    },
    async getAllAsync<T>(sql: string, args: any[] = []): Promise<T[]> {
      return [];
    },
    async withTransactionAsync(fn: () => Promise<void>): Promise<void> {
      await fn();
    },
  };
}

vi.mock('expo-sqlite', () => ({ default: {} }));

import { WikiMemory } from '../WikiMemory';
import type { WikiOptions } from '../types';

const stubOptions: WikiOptions = {
  llmProvider: { generateText: async () => '{}' },
};

const VALID_HASH = 'a'.repeat(64);
const VALID_HASH_2 = 'b'.repeat(64);

// ── Tests ────────────────────────────────────────────────────────────────────

describe('WikiMemory.hasChanged', () => {
  it('returns true when no prior ingests exist', async () => {
    const db = makeMockDb([]);
    const wiki = new WikiMemory(db as any, stubOptions);
    const result = await wiki.hasChanged('entity-1', 'doc.md', VALID_HASH);
    expect(result).toBe(true);
  });

  it('returns false when stored hash matches supplied hash', async () => {
    const db = makeMockDb([
      {
        entity_id: 'entity-1',
        source_ref: 'doc.md',
        source_hash: VALID_HASH,
        deleted_at: null,
        updated_at: 1000,
      },
    ]);
    const wiki = new WikiMemory(db as any, stubOptions);
    const result = await wiki.hasChanged('entity-1', 'doc.md', VALID_HASH);
    expect(result).toBe(false);
  });

  it('returns true when stored hash differs from supplied hash', async () => {
    const db = makeMockDb([
      {
        entity_id: 'entity-1',
        source_ref: 'doc.md',
        source_hash: VALID_HASH,
        deleted_at: null,
        updated_at: 1000,
      },
    ]);
    const wiki = new WikiMemory(db as any, stubOptions);
    const result = await wiki.hasChanged('entity-1', 'doc.md', VALID_HASH_2);
    expect(result).toBe(true);
  });

  it('returns true when all prior rows are soft-deleted', async () => {
    const db = makeMockDb([
      {
        entity_id: 'entity-1',
        source_ref: 'doc.md',
        source_hash: VALID_HASH,
        deleted_at: 999,
        updated_at: 1000,
      },
    ]);
    const wiki = new WikiMemory(db as any, stubOptions);
    const result = await wiki.hasChanged('entity-1', 'doc.md', VALID_HASH);
    expect(result).toBe(true);
  });

  it('uses the most-recently-updated non-deleted row for comparison', async () => {
    const db = makeMockDb([
      {
        entity_id: 'entity-1',
        source_ref: 'doc.md',
        source_hash: VALID_HASH,
        deleted_at: null,
        updated_at: 500,
      },
      {
        entity_id: 'entity-1',
        source_ref: 'doc.md',
        source_hash: VALID_HASH_2,
        deleted_at: null,
        updated_at: 1000,
      },
    ]);
    const wiki = new WikiMemory(db as any, stubOptions);
    // Most recent row has VALID_HASH_2; supplying VALID_HASH should return true
    expect(await wiki.hasChanged('entity-1', 'doc.md', VALID_HASH)).toBe(true);
  });

  it('throws for invalid sourceRef', async () => {
    const db = makeMockDb([]);
    const wiki = new WikiMemory(db as any, stubOptions);
    await expect(wiki.hasChanged('entity-1', '!!!', VALID_HASH)).rejects.toThrow();
  });

  it('throws for invalid sourceHash', async () => {
    const db = makeMockDb([]);
    const wiki = new WikiMemory(db as any, stubOptions);
    await expect(wiki.hasChanged('entity-1', 'doc.md', 'not-a-hash')).rejects.toThrow();
  });
});

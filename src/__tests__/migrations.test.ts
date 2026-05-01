import { describe, it, expect, vi } from 'vitest';

// ── Shared mock state ────────────────────────────────────────────────────────

function makeMockDb(opts: {
  hasEntries?: boolean;
  hasPorter?: boolean;
  metaVersion?: string | null;
}) {
  const {
    hasEntries = false,
    hasPorter = true,
    metaVersion = null,
  } = opts;

  const execCalls: string[] = [];
  const runCalls: Array<{ sql: string; args: any[] }> = [];
  let currentMetaVersion = metaVersion;

  const db = {
    execCalls,
    runCalls,
    async execAsync(sql: string): Promise<void> {
      execCalls.push(sql);
    },
    async runAsync(sql: string, args: any[] = []): Promise<void> {
      runCalls.push({ sql, args });
      // Track meta version updates
      if (sql.includes('schema_version')) {
        currentMetaVersion = args[0];
      }
    },
    async getFirstAsync<T>(sql: string, args: any[] = []): Promise<T | null> {
      // Entries table existence check
      if (sql.includes('sqlite_master') && args[0]?.includes('entries') && !args[0]?.includes('fts')) {
        if (!hasEntries) return null;
        return { name: args[0] } as any;
      }
      // FTS meta check (for legacy install detection)
      if (sql.includes('sqlite_master') && args[0]?.includes('entries_fts')) {
        if (!hasEntries) return null;
        if (hasPorter) {
          return { sql: `CREATE VIRTUAL TABLE x USING fts5(title, tokenize='porter unicode61')` } as any;
        }
        return { sql: `CREATE VIRTUAL TABLE x USING fts5(title, tokenize='unicode61')` } as any;
      }
      // Meta version check
      if (sql.includes('schema_version')) {
        if (currentMetaVersion !== null) {
          return { value: currentMetaVersion } as any;
        }
        return null;
      }
      return null;
    },
    async getAllAsync<T>(sql: string, args: any[] = []): Promise<T[]> {
      return [];
    },
    async withTransactionAsync(fn: () => Promise<void>): Promise<void> {
      await fn();
    },
    getMetaVersion() {
      return currentMetaVersion;
    },
  };

  return db;
}

vi.mock('expo-sqlite', () => ({ default: {} }));

// ── Tests ────────────────────────────────────────────────────────────────────

import { WikiMemory } from '../WikiMemory';
import type { WikiOptions } from '../types';

const stubOptions: WikiOptions = {
  llmProvider: { generateText: async () => '{}' },
};

function createWiki(db: any) {
  return new WikiMemory(db as any, stubOptions);
}

describe('schema migrations', () => {
  it('fresh install: no entries table → writes current schema version, no migration SQL runs', async () => {
    const db = makeMockDb({ hasEntries: false, metaVersion: null });
    const wiki = createWiki(db);
    await wiki.setup();

    // Should have written schema_version
    const versionWrite = db.runCalls.find(
      c => c.sql.includes('schema_version') && c.args[0] === '1'
    );
    expect(versionWrite).toBeDefined();

    // Migration 1 (porter rebuild with DROP TABLE) should NOT have run
    const hasRebuild = db.execCalls.some(s => s.includes('DROP TABLE') || s.includes('DROP TRIGGER'));
    expect(hasRebuild).toBe(false);
  });

  it('legacy install without porter → migration 0→1 runs (porter rebuild)', async () => {
    const db = makeMockDb({ hasEntries: true, hasPorter: false, metaVersion: null });
    const wiki = createWiki(db);
    await wiki.setup();

    // Migration 1 SQL (drop + recreate FTS) should have run
    const hasRebuild = db.execCalls.some(s => s.includes('DROP TABLE') || s.includes('DROP TRIGGER'));
    expect(hasRebuild).toBe(true);

    // Version should have been written
    const versionWrite = db.runCalls.find(
      c => c.sql.includes('schema_version') && c.args[0] === '1'
    );
    expect(versionWrite).toBeDefined();
  });

  it('legacy install with porter → no migration runs, version written', async () => {
    const db = makeMockDb({ hasEntries: true, hasPorter: true, metaVersion: null });
    const wiki = createWiki(db);
    await wiki.setup();

    // Migration 1 (porter rebuild) should NOT run since porter is already there
    const hasRebuild = db.execCalls.some(s => s.includes('DROP TABLE') || s.includes('DROP TRIGGER'));
    expect(hasRebuild).toBe(false);

    // Version should still have been written
    const versionWrite = db.runCalls.find(c => c.sql.includes('schema_version'));
    expect(versionWrite).toBeDefined();
  });

  it('already at current version → no migration runs', async () => {
    const db = makeMockDb({ hasEntries: true, hasPorter: true, metaVersion: '1' });
    const wiki = createWiki(db);
    await wiki.setup();

    const hasRebuild = db.execCalls.some(s => s.includes('DROP TABLE') || s.includes('DROP TRIGGER'));
    expect(hasRebuild).toBe(false);
  });
});

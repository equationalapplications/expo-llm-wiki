import { describe, it, expect } from 'vitest';
import type { Migration } from '../src/db/migrations';

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

// ── Tests ────────────────────────────────────────────────────────────────────

import { WikiMemory } from '../src/WikiMemory';
import type { WikiOptions } from '../src/types';

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
      c => c.sql.includes('schema_version') && c.args[0] === '2'
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
      c => c.sql.includes('schema_version') && c.args[0] === '2'
    );
    expect(versionWrite).toBeDefined();
  });

  it('legacy install with porter → migration 1 skipped; migration 2 runs to drop FTS5', async () => {
    const db = makeMockDb({ hasEntries: true, hasPorter: true, metaVersion: null });
    const wiki = createWiki(db);
    await wiki.setup();

    // Migration 1 (porter FTS5 rebuild) should NOT run since porter is already present
    // and migration 1 is a no-op. The FTS5 virtual table should never be recreated.
    const hasPorterRebuild = db.execCalls.some(s => s.includes('CREATE VIRTUAL TABLE'));
    expect(hasPorterRebuild).toBe(false);

    // Version should still have been written
    const versionWrite = db.runCalls.find(c => c.sql.includes('schema_version'));
    expect(versionWrite).toBeDefined();
  });

  it('already at current version → no migration runs', async () => {
    const db = makeMockDb({ hasEntries: true, hasPorter: true, metaVersion: '2' });
    const wiki = createWiki(db);
    await wiki.setup();

    const hasRebuild = db.execCalls.some(s => s.includes('DROP TABLE') || s.includes('DROP TRIGGER'));
    expect(hasRebuild).toBe(false);
  });
});

// Helper that mirrors the module-level assertion in migrations.ts so we can test
// the out-of-order guard without dynamic imports.
function checkMigrationsOrder(migrations: Migration[]): void {
  for (let i = 1; i < migrations.length; i++) {
    if (migrations[i].version <= migrations[i - 1].version) {
      throw new Error(
        `migrations.ts: MIGRATIONS must be in strictly ascending version order. ` +
        `Found version ${migrations[i].version} after ${migrations[i - 1].version} at index ${i}.`
      );
    }
  }
}

describe('MIGRATIONS ordering and CURRENT_SCHEMA_VERSION derivation', () => {
  it('CURRENT_SCHEMA_VERSION equals the last migration version', async () => {
    const { MIGRATIONS, CURRENT_SCHEMA_VERSION } = await import('../src/db/migrations');
    expect(CURRENT_SCHEMA_VERSION).toBe(MIGRATIONS[MIGRATIONS.length - 1].version);
  });

  it('MIGRATIONS array itself is in strictly ascending order', async () => {
    const { MIGRATIONS } = await import('../src/db/migrations');
    expect(() => checkMigrationsOrder(MIGRATIONS)).not.toThrow();
  });

  it('checkMigrationsOrder throws for out-of-order versions', () => {
    const outOfOrder: Migration[] = [
      { version: 1, description: 'a', run: async () => {} },
      { version: 3, description: 'b', run: async () => {} },
      { version: 2, description: 'c', run: async () => {} },
    ];
    expect(() => checkMigrationsOrder(outOfOrder)).toThrow('strictly ascending version order');
  });

  it('checkMigrationsOrder throws for duplicate versions', () => {
    const duplicates: Migration[] = [
      { version: 1, description: 'a', run: async () => {} },
      { version: 1, description: 'b', run: async () => {} },
    ];
    expect(() => checkMigrationsOrder(duplicates)).toThrow('strictly ascending version order');
  });
});

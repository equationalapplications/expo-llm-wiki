import { describe, it, expect } from 'vitest';
import type { Migration } from '../src/db/migrations';
import { CURRENT_SCHEMA_VERSION } from '../src/db/migrations';

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
      // Track meta version updates — handles both literal SQL and parameterized queries
      const isSchemaVersionWrite = sql.includes('schema_version') || args[0] === 'schema_version';
      if (isSchemaVersionWrite) {
        // Parameterized setMeta: args = ['schema_version', version] → version at index 1
        // Legacy literal SQL: args = [version] → version at index 0
        currentMetaVersion = args[0] === 'schema_version' ? args[1] : args[0];
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
      // Edges table existence check (created in migration v5)
      if (sql.includes('sqlite_master') && args[0]?.endsWith('edges')) {
        const version = currentMetaVersion !== null ? parseInt(currentMetaVersion, 10) : 0;
        if (hasEntries && version >= 5) {
          return { name: args[0] } as any;
        }
        return null;
      }
      // Meta version check — matches both literal SQL and parameterized queries
      if (sql.includes('schema_version') || args.includes('schema_version')) {
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
    async withTransactionAsync(fn: (tx: any) => Promise<void>): Promise<void> {
      await fn(db);
    },
    getMetaVersion() {
      return currentMetaVersion;
    },
  };

  return db;
}

// Locate the schema_version write in the mock's runCalls. The only writer is
// MetadataRepository.setMeta, which is parameterized:
// runAsync('INSERT INTO ...meta (key, value) VALUES (?, ?)...', [key, value]).
// Keeping that shape in one place so the upgrade tests below can't drift apart.
function findVersionWrite(
  db: ReturnType<typeof makeMockDb>,
  version: number = CURRENT_SCHEMA_VERSION,
) {
  return db.runCalls.find(
    c => c.args[0] === 'schema_version' && c.args[1] === String(version),
  );
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
    const versionWrite = findVersionWrite(db);
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
    const versionWrite = findVersionWrite(db);
    expect(versionWrite).toBeDefined();
  });

  it('legacy install with porter → migration 2 drops FTS5 and the chain reaches the current version', async () => {
    const db = makeMockDb({ hasEntries: true, hasPorter: true, metaVersion: null });
    const wiki = createWiki(db);
    await wiki.setup();

    // Migration 2 drops the FTS5 triggers and table. (Migration 1 is a no-op
    // superseded by 2, so there is nothing of its own to assert here.)
    const hasFtsDrop = db.execCalls.some(
      s => s.includes('DROP TABLE') && s.includes('entries_fts'),
    );
    expect(hasFtsDrop).toBe(true);

    // Version should still have been written
    const versionWrite = findVersionWrite(db);
    expect(versionWrite).toBeDefined();
  });

  it('already at current version → no migration runs and no version write', async () => {
    const db = makeMockDb({
      hasEntries: true,
      hasPorter: true,
      metaVersion: String(CURRENT_SCHEMA_VERSION),
    });
    const wiki = createWiki(db);
    await wiki.setup();

    const hasRebuild = db.execCalls.some(s => s.includes('DROP TABLE') || s.includes('DROP TRIGGER'));
    expect(hasRebuild).toBe(false);

    // Nothing to advance, so setMeta should not be called for schema_version at all.
    const anyVersionWrite = db.runCalls.some(c => c.args[0] === 'schema_version');
    expect(anyVersionWrite).toBe(false);
  });

  it('existing install at version 4 → migration 5 adds okf_type columns and creates edges table', async () => {
    const db = makeMockDb({ hasEntries: true, hasPorter: true, metaVersion: '4' });
    const wiki = createWiki(db);
    await wiki.setup();

    const hasOkfTypeAlter = db.execCalls.some(
      s => s.includes('ALTER TABLE') && s.includes('okf_type'),
    );
    expect(hasOkfTypeAlter).toBe(true);

    const hasEdgesTable = db.execCalls.some(
      s => s.includes('CREATE TABLE') && s.includes('edges'),
    );
    expect(hasEdgesTable).toBe(true);

    const versionWrite = findVersionWrite(db);
    expect(versionWrite).toBeDefined();
  });

  it('existing install at version 5 → migration 6 creates entity_manifests table', async () => {
    const db = makeMockDb({ hasEntries: true, hasPorter: true, metaVersion: '5' });
    const wiki = createWiki(db);
    await wiki.setup();

    const hasManifestsTable = db.execCalls.some(
      s => s.includes('CREATE TABLE') && s.includes('entity_manifests'),
    );
    expect(hasManifestsTable).toBe(true);

    const versionWrite = findVersionWrite(db);
    expect(versionWrite).toBeDefined();
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

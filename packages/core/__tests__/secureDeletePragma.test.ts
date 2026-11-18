import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { WikiMemory } from '../src/WikiMemory';
import type { SQLiteAdapter } from '../src/types';

const P = 'llm_wiki_';
const CANARY = 'zq7canarytoken9x';
const provider = { generateText: async () => JSON.stringify({ facts: [] }) };

afterEach(() => vi.restoreAllMocks());

const secureDelete = async (db: SQLiteAdapter) =>
  (await db.getFirstAsync<{ secure_delete: number }>('PRAGMA secure_delete'))!.secure_delete;

function filesContain(dir: string, needle: string): boolean {
  return readdirSync(dir).some((f) => readFileSync(join(dir, f)).includes(Buffer.from(needle)));
}

describe('secure_delete=FULL foundation (spec §1)', () => {
  it('AC1 (H-mirror): setup sets FULL; with the pragma flipped OFF, delete + rebuild alone leaves the canary recoverable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sd-'));
    try {
      const db = openTestDatabase(join(dir, 'w.db'));
      const wiki = new WikiMemory(db, { llmProvider: provider });
      await wiki.setup();
      expect(await secureDelete(db)).toBe(1); // spec "FULL" = SQLite ON (full zeroing; FULL is not a SQLite value, FAST=2 is partial)

      await db.execAsync('PRAGMA secure_delete=OFF');
      expect(await secureDelete(db)).toBe(0);

      const ins = `INSERT INTO ${P}entries (id, entity_id, title, body, tags, created_at, updated_at) VALUES (?, 'e1', ?, 'b', '[]', 1, 1)`;
      await db.runAsync(ins, ['c1', CANARY]);
      await db.withTransactionAsync(async (tx) => {
        for (let i = 0; i < 300; i++) await tx.runAsync(ins, [`f${i}`, `filler${i}`]);
      });
      await db.runAsync(`DELETE FROM ${P}entries WHERE id = 'c1'`);
      await db.execAsync(`INSERT INTO ${P}entries_fts(${P}entries_fts) VALUES('rebuild')`);
      await db.execAsync('PRAGMA wal_checkpoint(TRUNCATE)');
      await db.closeAsync();

      expect(filesContain(dir, CANARY)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('AC2: a refused FULL (read-back != 1) warns and does not fail setup', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const real = openTestDatabase();
    const refusing: SQLiteAdapter = {
      ...real,
      getFirstAsync: (async (sql: string, args?: unknown[]) =>
        /^\s*PRAGMA\s+secure_delete\s*$/i.test(sql)
          ? { secure_delete: 0 }
          : real.getFirstAsync(sql, args)) as SQLiteAdapter['getFirstAsync'],
    };
    await new WikiMemory(refusing, { llmProvider: provider }).setup();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('secure_delete'))).toBe(true);
  });

  it('no warning when FULL is honored', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await new WikiMemory(openTestDatabase(), { llmProvider: provider }).setup();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('secure_delete'))).toBe(false);
  });
});

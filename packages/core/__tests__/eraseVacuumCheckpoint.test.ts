/**
 * Spec forget-erasure §2 (T5): wrapped VACUUM (step 5), syncedIds tail
 * (step 6), verified wal_checkpoint(TRUNCATE) (steps 5/8).
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { WikiMemory } from '../src/index';
import { FTS5_REBUILD_WM_KEY, FTS5_STATE_KEY } from '../src/services/search/fts5Sql';

const P = 'llm_wiki_';
const llm = { generateText: async () => '{}' };

async function ins(raw: any, id: string, deletedAt: number | null) {
  await raw.runAsync(
    `INSERT INTO ${P}entries (id, entity_id, title, body, created_at, updated_at, deleted_at) VALUES (?, 'e1', 't', 'b', 1, 1, ?)`,
    [id, deletedAt],
  );
}

describe('erase() wrapped VACUUM + checkpoints (spec §2 steps 5/6/8)', () => {
  it('AC1: a second connection holding a read blocks the checkpoint -> erase_checkpoint_incomplete, unverified', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'erase-ckpt-'));
    const path = join(dir, 'w.db');
    const raw = openTestDatabase(path);
    await raw.execAsync('PRAGMA journal_mode=WAL');
    await raw.execAsync('PRAGMA busy_timeout=0'); // better-sqlite3 defaults to 5s; fail fast on the held reader
    const wiki = new WikiMemory(raw, { llmProvider: llm } as any);
    await wiki.setup();
    await ins(raw, 'a', 1);
    await ins(raw, 'b', null);
    const reader = new Database(path);
    try {
      reader.exec('BEGIN');
      reader.prepare(`SELECT COUNT(*) FROM ${P}entries`).get();
      let err: any;
      try { await (wiki as any).maintenanceService.erase(); } catch (e) { err = e; }
      expect(err).toBeDefined();
      expect(err.code).toBe('erase_checkpoint_incomplete');
      expect(err.report.verified).toBe(false);
    } finally {
      reader.exec('ROLLBACK');
      reader.close();
      await raw.closeAsync();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('F5: an incomplete checkpoint still restarts the FTS rebuild (no stale rowid snapshot)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'erase-ckpt-'));
    const path = join(dir, 'w.db');
    const raw = openTestDatabase(path);
    await raw.execAsync('PRAGMA journal_mode=WAL');
    await raw.execAsync('PRAGMA busy_timeout=0');
    const wiki = new WikiMemory(raw, { llmProvider: llm } as any);
    await wiki.setup();
    await ins(raw, 'a', 1);
    await ins(raw, 'b', null);
    await raw.runAsync(`INSERT OR REPLACE INTO ${P}meta (key, value) VALUES (?, 'rebuilding')`, [FTS5_STATE_KEY]);
    await raw.runAsync(`INSERT OR REPLACE INTO ${P}meta (key, value) VALUES (?, ?)`, [
      FTS5_REBUILD_WM_KEY, JSON.stringify({ rowid: 999, id: 'zzz' }),
    ]);
    const reader = new Database(path);
    try {
      reader.exec('BEGIN');
      reader.prepare(`SELECT COUNT(*) FROM ${P}entries`).get();
      let err: any;
      try { await (wiki as any).maintenanceService.erase(); } catch (e) { err = e; }
      expect(err.code).toBe('erase_checkpoint_incomplete');
      expect(err.report.verified).toBe(false);
      const wm = await raw.getFirstAsync<{ value: string }>(`SELECT value FROM ${P}meta WHERE key = ?`, [FTS5_REBUILD_WM_KEY]);
      expect(JSON.parse(wm!.value).rowid).not.toBe(999);
    } finally {
      reader.exec('ROLLBACK');
      reader.close();
      await raw.closeAsync();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('succeeds on a non-WAL connection ((0,-1,-1) is complete) and reports the synced superset', async () => {
    const raw = openTestDatabase();
    const wiki = new WikiMemory(raw, { llmProvider: llm } as any);
    await wiki.setup();
    await ins(raw, 'a', 1);
    const report = await (wiki as any).maintenanceService.erase();
    expect(report.verified).toBe(true);
    expect(report.syncedIds).toContain('a');
  });

  it('AC2: erase while the FTS rebuild is `rebuilding` resets the watermark and restarts the rebuild', async () => {
    const raw = openTestDatabase();
    const wiki = new WikiMemory(raw, { llmProvider: llm } as any);
    await wiki.setup();
    await ins(raw, 'a', 1);
    await ins(raw, 'b', null);
    await raw.runAsync(`INSERT OR REPLACE INTO ${P}meta (key, value) VALUES (?, 'rebuilding')`, [FTS5_STATE_KEY]);
    await raw.runAsync(`INSERT OR REPLACE INTO ${P}meta (key, value) VALUES (?, ?)`, [
      FTS5_REBUILD_WM_KEY, JSON.stringify({ rowid: 999, id: 'zzz' }),
    ]);
    const report = await (wiki as any).maintenanceService.erase();
    expect(report.verified).toBe(true);
    const state = await raw.getFirstAsync<{ value: string }>(`SELECT value FROM ${P}meta WHERE key = ?`, [FTS5_STATE_KEY]);
    expect(state?.value).toBe('rebuilding');
    const wm = await raw.getFirstAsync<{ value: string }>(`SELECT value FROM ${P}meta WHERE key = ?`, [FTS5_REBUILD_WM_KEY]);
    expect(JSON.parse(wm!.value).rowid).not.toBe(999);
  });
});

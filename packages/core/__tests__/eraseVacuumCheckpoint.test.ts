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
import { WikiMemory, CheckpointIncompleteError } from '../src/index';
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

  it('N4: a POST-VACUUM checkpoint failure (pre-VACUUM succeeded) still restarts the rebuild and reports unverified', async () => {
    const raw = openTestDatabase();
    const wiki = new WikiMemory(raw, { llmProvider: llm } as any);
    await wiki.setup();
    await ins(raw, 'a', 1);
    await ins(raw, 'b', null);
    await raw.runAsync(`INSERT OR REPLACE INTO ${P}meta (key, value) VALUES (?, 'rebuilding')`, [FTS5_STATE_KEY]);
    await raw.runAsync(`INSERT OR REPLACE INTO ${P}meta (key, value) VALUES (?, ?)`, [
      FTS5_REBUILD_WM_KEY, JSON.stringify({ rowid: 999, id: 'zzz' }),
    ]);
    const repo = (wiki as any).maintenanceService.metadataRepo;
    const realCp = repo.checkpointTruncateVerified.bind(repo);
    let calls = 0;
    let vacuumRan = false;
    const realVacuum = raw.execAsync.bind(raw);
    raw.execAsync = async (sql: string, ...rest: any[]) => { if (/^\s*VACUUM/i.test(sql)) vacuumRan = true; return realVacuum(sql, ...rest); };
    repo.checkpointTruncateVerified = async () => {
      calls += 1;
      if (vacuumRan) throw new CheckpointIncompleteError('post-VACUUM checkpoint incomplete');
      return realCp();
    };
    let err: any;
    try { await (wiki as any).maintenanceService.erase(); } catch (e) { err = e; }
    expect(vacuumRan).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(err.code).toBe('erase_checkpoint_incomplete');
    expect(err.report.verified).toBe(false);
    const wm = await raw.getFirstAsync<{ value: string }>(`SELECT value FROM ${P}meta WHERE key = ?`, [FTS5_REBUILD_WM_KEY]);
    expect(JSON.parse(wm!.value).rowid).not.toBe(999);
  });

  it('N2: a strategy without strict drains fails erase when an FTS ledger holds rows, proceeds when empty', async () => {
    const raw = openTestDatabase();
    const wiki = new WikiMemory(raw, { llmProvider: llm } as any);
    await wiki.setup();
    await ins(raw, 'b', null);
    const ss = (wiki as any).searchService;
    const strategy = ss.indexStrategy;
    ss.indexStrategy = { name: 'unavailable' }; // no drain/reclaim/optimize methods
    await raw.runAsync(`DELETE FROM ${P}fts_pending`);
    await raw.runAsync(`INSERT INTO ${P}fts_pending (entity_id, id) VALUES ('e1', 'b')`);
    let err: any;
    try { await (wiki as any).maintenanceService.erase(); } catch (e) { err = e; }
    expect(err.report.verified).toBe(false);
    expect(err.report.failedStep).toBe('index_sync');
    await raw.runAsync(`DELETE FROM ${P}fts_pending`);
    await raw.runAsync(`DELETE FROM ${P}source_passages_fts_pending`);
    // Live FTS5 shadow tables would read as orphaned content (F-MAJOR-1); a
    // strategy without FTS5 has none.
    await raw.runAsync(`DROP TABLE IF EXISTS ${P}entries_fts`);
    await raw.runAsync(`DROP TABLE IF EXISTS ${P}source_passages_fts`);
    const report = await (wiki as any).maintenanceService.erase();
    expect(report.verified).toBe(true);
    ss.indexStrategy = strategy;
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

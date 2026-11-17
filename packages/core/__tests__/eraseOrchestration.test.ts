/** Spec forget-erasure §2 composition + §8 report (T6). */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { WikiMemory } from '../src/index';
import { FTS5_STATE_KEY } from '../src/services/search/fts5Sql';

const P = 'llm_wiki_';
const llm = { generateText: async () => '{}' };

async function ins(raw: any, id: string, deletedAt: number | null) {
  await raw.runAsync(
    `INSERT INTO ${P}entries (id, entity_id, title, body, created_at, updated_at, deleted_at) VALUES (?, 'e1', 't', 'b', 1, 1, ?)`,
    [id, deletedAt],
  );
}

async function walWiki() {
  const dir = mkdtempSync(join(tmpdir(), 'erase-orch-'));
  const path = join(dir, 'w.db');
  const raw = openTestDatabase(path);
  await raw.execAsync('PRAGMA journal_mode=WAL');
  await raw.execAsync('PRAGMA busy_timeout=0');
  const wiki = new WikiMemory(raw, { llmProvider: llm } as any);
  await wiki.setup();
  await ins(raw, 'a', 1);
  await ins(raw, 'b', null);
  return { dir, path, raw, wiki };
}

describe('erase() orchestration + report (spec §2/§8)', () => {
  it('AC1: an unfenced write holding the db during step 5 surfaces a step-5 failure, not success', async () => {
    const { dir, path, raw, wiki } = await walWiki();
    const other = new Database(path);
    try {
      // Deterministic race: the unfenced writer takes the db exactly as step 5 starts.
      const repo = (wiki as any).maintenanceService.metadataRepo;
      const realVacuum = repo.vacuum.bind(repo);
      repo.vacuum = async () => {
        other.exec('BEGIN IMMEDIATE');
        other.prepare(`UPDATE ${P}entries SET title = 'x' WHERE id = 'b'`).run();
        return realVacuum();
      };
      let err: any;
      try { await wiki.erase(); } catch (e) { err = e; }
      expect(err).toBeDefined();
      expect(['vacuum', 'checkpoint']).toContain(err.report.failedStep);
      expect(err.report.verified).toBe(false);
    } finally {
      other.exec('ROLLBACK');
      other.close();
      await raw.closeAsync();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('AC2: report carries runtime, sqlite_version(), pragma state and every step outcome', async () => {
    const raw = openTestDatabase();
    const wiki = new WikiMemory(raw, { llmProvider: llm } as any);
    await wiki.setup();
    await ins(raw, 'a', 1);
    const report = await wiki.erase();
    expect(report.verified).toBe(true);
    expect(report.failedStep).toBeNull();
    expect(report.sqliteVersion).toMatch(/^\d+\.\d+/);
    expect(report.secureDelete).toBe(1);
    expect(typeof report.runtime).toBe('string');
    expect(report.runtime.length).toBeGreaterThan(0);
    const names = report.steps.map((s) => s.step);
    expect(names).toEqual([
      'secure_delete', 'prune', 'registry_sweep', 'passage_drain', 'retired_reclaim',
      'vacuum', 'index_sync', 'retired_reclaim_rerun', 'optimize', 'checkpoint',
    ]);
    expect(report.steps.every((s) => s.outcome === 'ok')).toBe(true);
    expect(report.retiredUndroppable).toEqual([]);
  });

  it('AC3: erase({ rebuild: true }) drives the rebuild path', async () => {
    const raw = openTestDatabase();
    const wiki = new WikiMemory(raw, { llmProvider: llm } as any);
    await wiki.setup();
    await ins(raw, 'a', 1);
    await ins(raw, 'b', null);
    const strategy = (wiki as any).searchService.indexStrategy;
    const optimized: string[] = [];
    const realOptimize = strategy.optimizeFts.bind(strategy);
    strategy.optimizeFts = async () => { optimized.push('both'); return realOptimize(); };
    const report = await wiki.erase({ rebuild: true });
    expect(report.verified).toBe(true);
    expect(report.steps.find((s) => s.step === 'rebuild')?.outcome).toBe('ok');
    const state = await raw.getFirstAsync<{ value: string }>(`SELECT value FROM ${P}meta WHERE key = ?`, [FTS5_STATE_KEY]);
    expect(state?.value).toBe('rebuilding');
    // N1: optimize always runs after the rebuild (source_passages_fts is untouched by it).
    expect(report.steps.find((s) => s.step === 'optimize')?.outcome).toBe('ok');
    expect(optimized.length).toBeGreaterThan(0);
    const retired = await raw.getAllAsync(`SELECT name FROM sqlite_master WHERE name LIKE '${P}entries_fts_retired_%'`);
    expect(retired).toEqual([]);
  });

  it('AC4: a forced checkpoint failure reports where it stopped, verified false', async () => {
    const { dir, path, raw, wiki } = await walWiki();
    const reader = new Database(path);
    try {
      reader.exec('BEGIN');
      reader.prepare(`SELECT COUNT(*) FROM ${P}entries`).get();
      let err: any;
      try { await wiki.erase(); } catch (e) { err = e; }
      expect(err.code).toBe('erase_checkpoint_incomplete');
      expect(err.report.failedStep).toBe('checkpoint');
      expect(err.report.verified).toBe(false);
      const outcomes = err.report.steps.map((s: any) => `${s.step}:${s.outcome}`);
      expect(outcomes).toContain('prune:ok');
      expect(outcomes).toContain('passage_drain:ok');
      expect(outcomes[outcomes.length - 1]).not.toBe('checkpoint:ok');
    } finally {
      reader.exec('ROLLBACK');
      reader.close();
      await raw.closeAsync();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

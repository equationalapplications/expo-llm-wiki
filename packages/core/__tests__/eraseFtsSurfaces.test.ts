/**
 * Spec forget-erasure §2 (T4): erase() FTS surfaces — step 3 (chained,
 * surfaced passage drain), step 4 (retired-table reclaim to completion +
 * module-less fallback), step 7 (FTS optimize), and the step-6 `syncEntries`
 * false-is-failure rule. T6 composes these into the full pipeline; here each
 * step is driven directly against the services.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { WikiMemory } from '../src/index';
import { MetadataRepository } from '../src/repositories/MetadataRepository';
import { Fts5IndexStrategy } from '../src/services/search/Fts5IndexStrategy';
import { FTS5_RETIRED_TABLES_KEY, FTS5_STATE_KEY } from '../src/services/search/fts5Sql';
import { EraseStepError } from '../src/services/MaintenanceService';
import type { WikiDiagnostic, WikiOptions } from '../src/types';

const P = 'llm_wiki_';
const llm = { generateText: async () => '{}' };

async function make() {
  const raw = openTestDatabase();
  const diagnostics: WikiDiagnostic[] = [];
  const wiki = new WikiMemory(raw, {
    llmProvider: llm,
    onDiagnostic: (d: WikiDiagnostic) => { diagnostics.push(d); },
  } as WikiOptions);
  await wiki.setup();
  const meta = new MetadataRepository(raw, P);
  return { raw, wiki, diagnostics, meta };
}
const maint = (wiki: WikiMemory): any => (wiki as any).maintenanceService;
const search = (wiki: WikiMemory): any => (wiki as any).searchService;
const newReport = () => ({
  verified: false, secureDelete: 1, sqliteVersion: '', entities: [], holds: [], skipped: [],
  syncedIds: [], registrySweep: { skipped: false, deleted: 0 }, failedStep: null, steps: [], retiredUndroppable: [], ftsOrphansCleared: [],
}) as any;

/** Force a retired table the way a tokenizer-mismatch / corruption reset does. */
async function forceRetired(t: Awaited<ReturnType<typeof make>>) {
  await t.raw.withTransactionAsync(async (tx) => {
    for (let i = 0; i < 5; i++) {
      await tx.runAsync(`INSERT INTO ${P}entries (id, entity_id, title, body, tags, created_at, updated_at) VALUES (?, 'e1', ?, 'secret', '[]', 1, 1)`, [`r${i}`, `cedar ${i}`]);
    }
  });
  await search(t.wiki).indexStrategy.drain();
  await t.raw.execAsync(`DROP TABLE ${P}entries_fts; DELETE FROM ${P}fts_map;
    CREATE VIRTUAL TABLE ${P}entries_fts USING fts5(id UNINDEXED, entity_id UNINDEXED, title, body, tags, tokenize = 'unicode61');
    INSERT INTO ${P}entries_fts (rowid, id, entity_id, title, body, tags) SELECT rowid, id, entity_id, title, body, '' FROM ${P}entries;`);
  await new Fts5IndexStrategy(t.raw, P, t.meta).init();
}
/** Retired-shadow fixture with real fts5 shapes: _data (id, block) rows 1, 10 + canary; _config (key, value). */
const retiredFixture = (name: string, sfx: string, canary: string) =>
  sfx === '_data' ? `CREATE TABLE ${name}${sfx} (id INTEGER, block TEXT); INSERT INTO ${name}${sfx} VALUES (1, 'avg'), (10, 'struct'), (99, '${canary}');`
  : sfx === '_config' ? `CREATE TABLE ${name}${sfx} (key TEXT, value TEXT); INSERT INTO ${name}${sfx} VALUES ('version', '4');`
  : `CREATE TABLE ${name}${sfx} (k INTEGER, v TEXT); INSERT INTO ${name}${sfx} VALUES (1, '${canary}');`;
const retiredNames = async (t: Awaited<ReturnType<typeof make>>) =>
  (await t.raw.getAllAsync<{ name: string }>(`SELECT name FROM sqlite_master WHERE name LIKE '${P}entries_fts_retired_%'`)).map((r) => r.name);
const listed = async (t: Awaited<ReturnType<typeof make>>) =>
  JSON.parse((await t.meta.getMeta(FTS5_RETIRED_TABLES_KEY)) ?? '[]') as string[];

describe('erase() FTS surfaces (spec §2 steps 3/4/7)', () => {
  it('AC1: a retired table is reclaimed to completion (drop + delist), no sqlite_master residue', async () => {
    const t = await make();
    await forceRetired(t);
    expect(await listed(t)).toEqual([`${P}entries_fts_retired_1`]);
    expect((await retiredNames(t)).length).toBeGreaterThan(0);
    await maint(t.wiki)._eraseReclaimRetired(newReport());
    expect(await listed(t)).toEqual([]);
    expect(await retiredNames(t)).toEqual([]);
  });

  it('AC2: module-less runtime empties the shadow tables, keeps the name listed, surfaces the diagnostic', async () => {
    const t = await make();
    const name = `${P}entries_fts_retired_1`;
    // With the module loaded SQLite protects shadow tables; a module-less open sees them as plain
    // tables. Fixture: drop the vtab, leave plain shadow tables holding rows, keep the name listed.
    for (const sfx of ['_content', '_data', '_idx', '_docsize', '_config']) {
      await t.raw.execAsync(retiredFixture(name, sfx, 'secret'));
    }
    await t.meta.setMeta(FTS5_RETIRED_TABLES_KEY, JSON.stringify([name]));
    vi.spyOn(search(t.wiki), 'reclaimRetiredSurfaced').mockRejectedValue(new Error('no such module: fts5'));
    const report = newReport();
    await maint(t.wiki)._eraseReclaimRetired(report);
    for (const sfx of ['_content', '_data', '_idx', '_docsize', '_config']) {
      const row = await t.raw.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${name}${sfx}`);
      expect(row!.n).toBe(sfx === '_data' ? 2 : sfx === '_config' ? 1 : 0);
    }
    expect(await listed(t)).toEqual([name]);
    expect(report.retiredUndroppable).toEqual([name]);
    expect(t.diagnostics.some((d) => d.code === 'erase_retired_vtab_undroppable')).toBe(true);
  });

  it('F1: a minisearch-strategy store still empties listed retired shadow tables and flags them', async () => {
    const raw = openTestDatabase();
    const diagnostics: WikiDiagnostic[] = [];
    const wiki = new WikiMemory(raw, {
      llmProvider: llm, config: { indexStrategy: 'minisearch' },
      onDiagnostic: (d: WikiDiagnostic) => { diagnostics.push(d); },
    } as WikiOptions);
    await wiki.setup();
    const meta = new MetadataRepository(raw, P);
    const name = `${P}entries_fts_retired_1`;
    for (const sfx of ['_content', '_data', '_idx', '_docsize', '_config']) {
      await raw.execAsync(retiredFixture(name, sfx, 'canary'));
    }
    await meta.setMeta(FTS5_RETIRED_TABLES_KEY, JSON.stringify([name]));
    const report = await maint(wiki).erase();
    for (const sfx of ['_content', '_data', '_idx', '_docsize', '_config']) {
      expect((await raw.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${name}${sfx}`))!.n, sfx + JSON.stringify(report)).toBe(sfx === '_data' ? 2 : sfx === '_config' ? 1 : 0);
    }
    expect(JSON.parse((await meta.getMeta(FTS5_RETIRED_TABLES_KEY)) ?? '[]')).toEqual([name]);
    expect(report.retiredUndroppable).toEqual([name]);
    expect(diagnostics.some((d) => d.code === 'erase_retired_vtab_undroppable')).toBe(true);
  });

  it('a non-module reclaim failure is a failed step, not a fallback', async () => {
    const t = await make();
    vi.spyOn(search(t.wiki), 'reclaimRetiredSurfaced').mockRejectedValue(new Error('disk I/O error'));
    const report = newReport();
    await expect(maint(t.wiki)._eraseReclaimRetired(report)).rejects.toBeInstanceOf(EraseStepError);
    expect(report.failedStep).toBe('retired_reclaim');
  });

  it('AC3: syncEntries resolving false (ledger drain failed) is a failed step', async () => {
    const t = await make();
    vi.spyOn(search(t.wiki), 'syncEntries').mockResolvedValue(false);
    const report = newReport();
    await expect(maint(t.wiki)._eraseSyncEntries('e1', ['a'], report)).rejects.toMatchObject({ code: 'erase_index_sync_failed' });
    expect(report.failedStep).toBe('index_sync');
  });

  it('step 3: passage drain is syncChain-chained and surfaces errors', async () => {
    const t = await make();
    const order: string[] = [];
    const strat = search(t.wiki).indexStrategy;
    vi.spyOn(strat, 'drainPassagesStrict').mockImplementation(async () => { order.push('drain'); throw new Error('boom'); });
    const svc = search(t.wiki) as any;
    // Isolate the STRICT drain's chaining: the ledger drain step is itself
    // chain-fed, so stub it out — otherwise a chain-order assertion here would
    // pass even if drainPassagesStrict were called unchained.
    vi.spyOn(svc, 'drainEntriesLedgerSurfaced').mockResolvedValue(undefined);
    // Queue an explicitly blocked predecessor so the chain is genuinely held:
    // the drain must wait for prior sync work, not merely follow the chain tail.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    svc.syncChain = svc.syncChain.then(() => gate);
    const pending = svc.syncChain.then(() => order.push('chain'));
    const report = newReport();
    const attempt = maint(t.wiki)._eraseDrainPassages(report);
    await new Promise<void>((r) => setImmediate(r));
    expect(order).toEqual([]); // blocked predecessor holds the chain: no drain yet
    release();
    await expect(attempt).rejects.toMatchObject({ code: 'erase_passage_drain_failed' });
    await pending;
    expect(order).toEqual(['chain', 'drain']);
    expect(report.failedStep).toBe('passage_drain');
  });

  it('step 3: passagesDisabled with pending rows fails; without pending rows warns and continues', async () => {
    const t = await make();
    const strat = search(t.wiki).indexStrategy;
    strat.passagesDisabled = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await maint(t.wiki)._eraseDrainPassages(newReport());
    expect(warn).toHaveBeenCalled();
    await t.raw.runAsync(`INSERT INTO ${P}source_passages_fts_pending (entity_id, doc_id) VALUES ('e1', 'd1')`);
    await expect(maint(t.wiki)._eraseDrainPassages(newReport())).rejects.toBeInstanceOf(EraseStepError);
    warn.mockRestore();
  });

  it('step 3: strategy without strict drain CLEARS orphaned FTS content tables (F-MAJOR-1 flipped, Path C)', async () => {
    const t = await make();
    vi.spyOn(search(t.wiki), 'hasStrictDrain').mockReturnValue(false);
    await t.raw.runAsync(`DROP TABLE IF EXISTS ${P}entries_fts`);
    await t.raw.runAsync(`DROP TABLE IF EXISTS ${P}source_passages_fts`);
    for (const sfx of ['_content', '_data', '_idx', '_docsize', '_config']) {
      // _data gets the real shape (id PK) — the preserve rule keeps ids 1 and 10.
      // _config is preserved entirely: realistic option rows, no text.
      sfx === '_data'
        ? await t.raw.execAsync(`CREATE TABLE ${P}entries_fts_data (id INTEGER, block TEXT); INSERT INTO ${P}entries_fts_data VALUES (1, 'averages'), (10, 'structure'), (11, 'CANARY-forgotten-text');`)
        : sfx === '_config'
          ? await t.raw.execAsync(`CREATE TABLE ${P}entries_fts_config (key TEXT, value TEXT); INSERT INTO ${P}entries_fts_config VALUES ('version', '4');`)
          : await t.raw.execAsync(`CREATE TABLE ${P}entries_fts${sfx} (k INTEGER, v TEXT); INSERT INTO ${P}entries_fts${sfx} VALUES (1, 'CANARY-forgotten-text');`);
    }
    const report = newReport();
    await maint(t.wiki)._eraseDrainPassages(report);
    for (const sfx of ['_content', '_data', '_idx', '_docsize', '_config']) {
      const expect_n = sfx === '_data' ? 2 : sfx === '_config' ? 1 : 0;
      expect((await t.raw.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${P}entries_fts${sfx}`))!.n, sfx + JSON.stringify(report)).toBe(expect_n);
    }
    const blobs = (await t.raw.getFirstAsync<{ b: string }>(`SELECT group_concat(COALESCE(block, '')) AS b FROM ${P}entries_fts_data`))!.b;
    expect(blobs.includes('CANARY-forgotten-text')).toBe(false);
    expect(report.ftsOrphansCleared).toEqual([
      `${P}entries_fts_content`, `${P}entries_fts_data`, `${P}entries_fts_idx`, `${P}entries_fts_docsize`,
      // empty companions delete 0 rows, so they are not reported (F3)
    ]);
    expect(report.failedStep).toBeNull();
    expect(t.diagnostics.some((d) => d.code === 'erase_fts_orphan_cleared')).toBe(true);
  });

  it('Path C / never-FTS: a module-less DB that never had FTS tables proceeds with no probe and no entry (AC9)', async () => {
    const t = await make();
    vi.spyOn(search(t.wiki), 'hasStrictDrain').mockReturnValue(false);
    await t.raw.runAsync(`DROP TABLE IF EXISTS ${P}entries_fts`);
    await t.raw.runAsync(`DROP TABLE IF EXISTS ${P}source_passages_fts`);
    const report = newReport();
    await maint(t.wiki)._eraseDrainPassages(report);
    expect(report.ftsOrphansCleared).toEqual([]);
    expect(report.failedStep).toBeNull();
  });

  it('full erase(): Path C completes verified (AC9 via pipeline)', async () => {
    const t = await make();
    vi.spyOn(search(t.wiki), 'hasStrictDrain').mockReturnValue(false);
    await t.raw.runAsync(`DROP TABLE IF EXISTS ${P}entries_fts`);
    await t.raw.runAsync(`DROP TABLE IF EXISTS ${P}source_passages_fts`);
    await t.raw.execAsync(`CREATE TABLE ${P}entries_fts_content (k INTEGER, v TEXT); INSERT INTO ${P}entries_fts_content VALUES (1, 'CANARY-forgotten-text');`);
    const report = await maint(t.wiki).erase();
    expect(report.verified).toBe(true);
    expect(report.ftsOrphansCleared).toContain(`${P}entries_fts_content`);
    expect((await t.raw.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${P}entries_fts_content`))!.n).toBe(0);
  });

  it('Path A: module-less probe empties shadows + companions and forces detached state (AC1/AC2 stand-in)', async () => {
    const t = await make();
    vi.spyOn(search(t.wiki), 'hasStrictDrain').mockReturnValue(false);
    // With the module loaded SQLite write-protects real shadow tables, so stand in for a
    // module-less open: plain tables carry the vtab name and the shadow names (canary rows).
    await t.raw.execAsync(`DROP TABLE ${P}entries_fts; DROP TABLE ${P}source_passages_fts;
      CREATE TABLE ${P}entries_fts (k INTEGER, v TEXT); INSERT INTO ${P}entries_fts VALUES (1, 'CANARY-vtab');`);
    for (const sfx of ['_content', '_data', '_idx', '_docsize', '_config']) {
      sfx === '_data'
        ? await t.raw.execAsync(`CREATE TABLE ${P}entries_fts_data (id INTEGER, block TEXT); INSERT INTO ${P}entries_fts_data VALUES (1, 'averages'), (10, 'structure'), (11, 'CANARY-secret');`)
        : sfx === '_config'
          ? await t.raw.execAsync(`CREATE TABLE ${P}entries_fts_config (key TEXT, value TEXT); INSERT INTO ${P}entries_fts_config VALUES ('tokenize', 'porter unicode61');`)
          : await t.raw.execAsync(`CREATE TABLE ${P}entries_fts${sfx} (k INTEGER, v TEXT); INSERT INTO ${P}entries_fts${sfx} VALUES (1, 'CANARY-secret');`);
    }
    await t.raw.execAsync(`CREATE TABLE ${P}source_passages_fts_content (k INTEGER, v TEXT); INSERT INTO ${P}source_passages_fts_content VALUES (1, 'CANARY-passage');`);
    await t.raw.runAsync(`INSERT INTO ${P}fts_pending (entity_id, id) VALUES ('e1', 'r0')`);
    // The vtab probe rejects as module-less; sourceTableExists (sqlite_master) is untouched.
    const probeError = new Error('no such module: fts5');
    const realGet = t.raw.getFirstAsync.bind(t.raw);
    vi.spyOn(t.raw, 'getFirstAsync').mockImplementation(async (sql: string, params?: unknown[]) => {
      if (new RegExp(`FROM ${P}(entries_fts|source_passages_fts) LIMIT`).test(sql)) throw probeError;
      return realGet(sql as never, params as never);
    });
    const report = newReport();
    await maint(t.wiki)._eraseDrainPassages(report);
    for (const sfx of ['_content', '_data', '_idx', '_docsize', '_config']) {
      const expect_n = sfx === '_data' ? 2 : sfx === '_config' ? 1 : 0;
      expect((await t.raw.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${P}entries_fts${sfx}`))!.n, sfx).toBe(expect_n);
    }
    expect((await t.raw.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${P}source_passages_fts_content`))!.n).toBe(0);
    expect(report.ftsOrphansCleared).toContain(`${P}source_passages_fts_content`);
    expect((await t.raw.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${P}fts_pending`))!.n).toBe(0);
    const meta = new MetadataRepository(t.raw, P);
    expect(await meta.getMeta(FTS5_STATE_KEY)).toBe('detached');
    expect(report.failedStep).toBeNull();
    expect(t.diagnostics.some((d) => d.code === 'erase_fts_orphan_cleared')).toBe(true);
  });

  it('probe failure honesty: a non-module probe error fails as erase_fts_orphan_probe_failed (AC5)', async () => {
    const t = await make();
    vi.spyOn(search(t.wiki), 'hasStrictDrain').mockReturnValue(false);
    const realGet = t.raw.getFirstAsync.bind(t.raw);
    vi.spyOn(t.raw, 'getFirstAsync').mockImplementation(async (sql: string, params?: unknown[]) => {
      if (new RegExp(`FROM ${P}(entries_fts|source_passages_fts) LIMIT`).test(sql)) throw new Error('disk I/O error');
      return realGet(sql as never, params as never);
    });
    const report = newReport();
    await expect(maint(t.wiki)._eraseDrainPassages(report)).rejects.toMatchObject({ code: 'erase_fts_orphan_probe_failed' });
    expect(report.failedStep).toBe('index_sync');
    expect(report.verified).toBe(false);
  });

  it('clear failure honesty: a failing DELETE fails as erase_fts_orphan_clear and the surface is not reported cleared (AC6)', async () => {
    const t = await make();
    vi.spyOn(search(t.wiki), 'hasStrictDrain').mockReturnValue(false);
    await t.raw.runAsync(`DROP TABLE IF EXISTS ${P}entries_fts`);
    await t.raw.runAsync(`DROP TABLE IF EXISTS ${P}source_passages_fts`);
    await t.raw.execAsync(`CREATE TABLE ${P}entries_fts_content (k INTEGER, v TEXT); INSERT INTO ${P}entries_fts_content VALUES (1, 'CANARY');`);
    const realRun = t.raw.runAsync.bind(t.raw);
    vi.spyOn(t.raw, 'runAsync').mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.startsWith(`DELETE FROM ${P}entries_fts_content`)) throw new Error('database is locked');
      return realRun(sql as never, params as never);
    });
    const report = newReport();
    await expect(maint(t.wiki)._eraseDrainPassages(report)).rejects.toMatchObject({ code: 'erase_fts_orphan_clear' });
    expect(report.failedStep).toBe('fts_orphan_clear');
    expect(report.ftsOrphansCleared).not.toContain(`${P}entries_fts_content`);
  });

  it('Path B: minisearch store with queryable orphan vtabs drops them and forces detached (AC3)', async () => {
    const raw = openTestDatabase();
    const diagnostics: WikiDiagnostic[] = [];
    const wiki = new WikiMemory(raw, {
      llmProvider: llm, config: { indexStrategy: 'minisearch' },
      onDiagnostic: (d: WikiDiagnostic) => { diagnostics.push(d); },
    } as WikiOptions);
    await wiki.setup();
    vi.spyOn(search(wiki), 'hasStrictDrain').mockReturnValue(false);
    // Orphaned-but-queryable vtabs from an earlier FTS5 life:
    await raw.execAsync(`CREATE VIRTUAL TABLE ${P}entries_fts USING fts5(id UNINDEXED, entity_id UNINDEXED, title, body, tags, tokenize = 'porter unicode61'); INSERT INTO ${P}entries_fts (id, entity_id, title, body, tags) VALUES ('x', 'e1', 'CANARY', 'CANARY-body', '[]');`);
    await raw.execAsync(`CREATE VIRTUAL TABLE ${P}source_passages_fts USING fts5(id UNINDEXED, entity_id UNINDEXED, title, body, tokenize = 'porter unicode61');`);
    const report = await maint(wiki).erase();
    expect(report.verified).toBe(true);
    const names =(await raw.getAllAsync<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('${P}entries_fts', '${P}source_passages_fts')`)).map((r) => r.name);
    expect(names).toEqual([]);
    const meta = new MetadataRepository(raw, P);
    expect(await meta.getMeta(FTS5_STATE_KEY)).toBe('detached');
    expect(report.ftsOrphansCleared).toContain(`${P}entries_fts`);
    expect(report.failedStep).toBeNull();
    expect(diagnostics.some((d) => d.code === 'erase_fts_orphan_cleared')).toBe(true);
  });

  it('Path B gates on the configured strategy: a pre-setup placeholder over a healthy FTS5 store drops nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'erase-preSetup-'));
    const opened: Array<{ closeAsync: () => Promise<void> }> = [];
    try {
      const file = join(dir, 'w.db');
      const raw1 = openTestDatabase(file);
      opened.push(raw1);
      const wiki1 = new WikiMemory(raw1, { llmProvider: llm } as WikiOptions);
      await wiki1.setup(); // capable FTS5 store with live vtabs
      const raw2 = openTestDatabase(file);
      opened.push(raw2);
      const wiki2 = new WikiMemory(raw2, { llmProvider: llm } as WikiOptions); // never set up: placeholder strategy
      vi.spyOn(search(wiki2), 'hasStrictDrain').mockReturnValue(false);
      let thrown: any;
      try { await maint(wiki2).erase(); } catch (e) { thrown = e; }
      expect(thrown).toBeInstanceOf(EraseStepError);
      expect(thrown.code).toBe('erase_fts_index_unavailable');
      expect(thrown.report.failedStep).toBe('index_sync');
      const vtabs = (await raw2.getAllAsync<{ name: string }>(`SELECT name FROM sqlite_master WHERE name = '${P}entries_fts'`)).map((r) => r.name);
      expect(vtabs).toEqual([`${P}entries_fts`]);
    } finally {
      for (const d of opened) await d.closeAsync().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Unavailable honesty: duck-typed unavailable strategy with orphan surfaces refuses to touch tables (AC4)', async () => {
    const t = await make();
    vi.spyOn(search(t.wiki), 'hasStrictDrain').mockReturnValue(false);
    vi.spyOn(search(t.wiki), 'isIndexUnavailable').mockReturnValue(true);
    // Live vtab shadow names are reserved; drop the vtabs so plain tables can stand in (as Path A).
    await t.raw.execAsync(`DROP TABLE ${P}entries_fts; DROP TABLE ${P}source_passages_fts;
      CREATE TABLE ${P}entries_fts_content (k INTEGER, v TEXT); INSERT INTO ${P}entries_fts_content VALUES (1, 'CANARY');`);
    const before = (await t.raw.getAllAsync<{ name: string }>(`SELECT name FROM sqlite_master WHERE name LIKE '${P}entries_fts%'`)).map((r) => r.name);
    const report = newReport();
    await expect(maint(t.wiki)._eraseDrainPassages(report)).rejects.toMatchObject({ code: 'erase_fts_index_unavailable' });
    expect(report.failedStep).toBe('index_sync');
    const after = (await t.raw.getAllAsync<{ name: string }>(`SELECT name FROM sqlite_master WHERE name LIKE '${P}entries_fts%'`)).map((r) => r.name);
    expect(after).toEqual(before);
    expect((await t.raw.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${P}entries_fts_content`))!.n).toBe(1);
  });

  it('AC8: pending rows clear under Path C before the pending throw re-runs', async () => {
    const t = await make();
    vi.spyOn(search(t.wiki), 'hasStrictDrain').mockReturnValue(false);
    await t.raw.runAsync(`DROP TABLE IF EXISTS ${P}entries_fts`);
    await t.raw.runAsync(`DROP TABLE IF EXISTS ${P}source_passages_fts`);
    await t.raw.execAsync(`CREATE TABLE ${P}entries_fts_content (k INTEGER, v TEXT); INSERT INTO ${P}entries_fts_content VALUES (1, 'CANARY');`);
    await t.raw.runAsync(`INSERT INTO ${P}fts_pending (entity_id, id) VALUES ('e1', 'r0')`);
    const report = newReport();
    await maint(t.wiki)._eraseDrainPassages(report);
    expect((await t.raw.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${P}fts_pending`))!.n).toBe(0);
    expect(report.failedStep).toBeNull();
  });

  it('AC8b: a leftover the remediation cannot cover still fails the step honestly', async () => {
    const t = await make();
    vi.spyOn(search(t.wiki), 'hasStrictDrain').mockReturnValue(false);
    await t.raw.runAsync(`DROP TABLE IF EXISTS ${P}entries_fts`);
    await t.raw.runAsync(`DROP TABLE IF EXISTS ${P}source_passages_fts`);
    await t.raw.execAsync(`CREATE TABLE ${P}entries_fts_content (k INTEGER, v TEXT); INSERT INTO ${P}entries_fts_content VALUES (1, 'CANARY');`);
    await t.raw.runAsync(`INSERT INTO ${P}fts_pending (entity_id, id) VALUES ('e1', 'r0')`);
    const realRun = t.raw.runAsync.bind(t.raw);
    vi.spyOn(t.raw, 'runAsync').mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.startsWith(`DELETE FROM ${P}fts_pending`)) return { changes: 0, lastInsertRowId: 0 } as never;
      return realRun(sql as never, params as never);
    });
    const report = newReport();
    await expect(maint(t.wiki)._eraseDrainPassages(report)).rejects.toMatchObject({ code: 'erase_index_sync_failed' });
    expect(report.failedStep).toBe('index_sync');
  });

  it('step 7: optimize runs on both FTS tables', async () => {
    const t = await make();
    const spy = vi.spyOn(t.raw, 'execAsync');
    const run = vi.spyOn(t.raw, 'runAsync');
    await maint(t.wiki)._eraseOptimize(newReport());
    const sql = [...spy.mock.calls, ...run.mock.calls].map((c) => String(c[0]));
    expect(sql.some((s) => s.includes(`${P}entries_fts`) && s.includes('optimize'))).toBe(true);
    expect(sql.some((s) => s.includes(`${P}source_passages_fts`) && s.includes('optimize'))).toBe(true);
  });
});

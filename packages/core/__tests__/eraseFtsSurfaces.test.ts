/**
 * Spec forget-erasure §2 (T4): erase() FTS surfaces — step 3 (chained,
 * surfaced passage drain), step 4 (retired-table reclaim to completion +
 * module-less fallback), step 7 (FTS optimize), and the step-6 `syncEntries`
 * false-is-failure rule. T6 composes these into the full pipeline; here each
 * step is driven directly against the services.
 */
import { describe, it, expect, vi } from 'vitest';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { WikiMemory } from '../src/index';
import { MetadataRepository } from '../src/repositories/MetadataRepository';
import { Fts5IndexStrategy } from '../src/services/search/Fts5IndexStrategy';
import { FTS5_RETIRED_TABLES_KEY } from '../src/services/search/fts5Sql';
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
  syncedIds: [], registrySweep: { skipped: false, deleted: 0 }, failedStep: null, retiredUndroppable: [],
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
      await t.raw.execAsync(`CREATE TABLE ${name}${sfx} (k INTEGER, v TEXT); INSERT INTO ${name}${sfx} VALUES (1, 'secret');`);
    }
    await t.meta.setMeta(FTS5_RETIRED_TABLES_KEY, JSON.stringify([name]));
    vi.spyOn(search(t.wiki), 'reclaimRetiredSurfaced').mockRejectedValue(new Error('no such module: fts5'));
    const report = newReport();
    await maint(t.wiki)._eraseReclaimRetired(report);
    for (const sfx of ['_content', '_data', '_idx', '_docsize', '_config']) {
      const row = await t.raw.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${name}${sfx}`);
      expect(row!.n).toBe(0);
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
      await raw.execAsync(`CREATE TABLE ${name}${sfx} (k INTEGER, v TEXT); INSERT INTO ${name}${sfx} VALUES (1, 'canary');`);
    }
    await meta.setMeta(FTS5_RETIRED_TABLES_KEY, JSON.stringify([name]));
    const report = await maint(wiki).erase();
    for (const sfx of ['_content', '_data', '_idx', '_docsize', '_config']) {
      expect((await raw.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${name}${sfx}`))!.n, sfx + JSON.stringify(report)).toBe(0);
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

  it('step 3: strategy without strict drain refuses on orphaned FTS content tables (F-MAJOR-1); absent tables proceed', async () => {
    const t = await make();
    vi.spyOn(search(t.wiki), 'hasStrictDrain').mockReturnValue(false);
    // A real minisearch store never had FTS5 tables: model that by dropping them.
    await t.raw.runAsync(`DROP TABLE IF EXISTS ${P}entries_fts`);
    await t.raw.runAsync(`DROP TABLE IF EXISTS ${P}source_passages_fts`);
    await maint(t.wiki)._eraseDrainPassages(newReport());
    await t.raw.runAsync(`CREATE TABLE ${P}entries_fts_content (id INTEGER, c0 TEXT)`);
    await t.raw.runAsync(`INSERT INTO ${P}entries_fts_content (id, c0) VALUES (1, 'CANARY-forgotten-text')`);
    const report = newReport();
    await expect(maint(t.wiki)._eraseDrainPassages(report)).rejects.toMatchObject({ code: 'erase_orphaned_fts_content' });
    expect(report.failedStep).toBe('index_sync');
    expect(report.verified).toBe(false);
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

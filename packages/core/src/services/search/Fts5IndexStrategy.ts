// packages/core/src/services/search/Fts5IndexStrategy.ts
import type { SQLiteAdapter } from '../../types';
import type { MetadataRepository } from '../../repositories/MetadataRepository';
import type { DrainOptions, IndexDocument, IndexSearchOptions, IndexSearchResult, IndexStrategy } from './IndexStrategy';
import {
  FTS5_DRAIN_CHUNK, FTS5_STATE_KEY, drainChunkSql, drainHiSql, entityDrainChunkSql, entityDrainHiSql, fts5PendingIndexesDdl,
  fts5TablesDdl, fts5TriggerNames, fts5TriggersDdl, idDrainChunkSql,
} from './fts5Sql';
import { writeRebuildStart } from './fts5Progress';
import { monotonicNow } from '../../utils/monotonicNow';
import { DEFAULT_SETUP_BUDGET_MS } from '../../utils/setupDefaults';
import { buildFtsMatchQuery } from './ftsQuery';

/**
 * Keyword index stored in SQLite FTS5, kept consistent with `entries` by a
 * trigger-fed ledger (`fts_pending`) that `drain()` applies in bounded, all-SQL
 * chunks. Row text never enters JS, so memory is flat at any database size.
 * Spec 2026-10-05 §PR-2 revision.
 */
export class Fts5IndexStrategy implements IndexStrategy {
  constructor(
    private readonly db: SQLiteAdapter,
    private readonly prefix: string,
    private readonly metadataRepo: MetadataRepository,
    private readonly budgetMs: number = DEFAULT_SETUP_BUDGET_MS,
  ) {}

  /**
   * Resolves the index state (spec #280 Change 3 transition table). Every
   * read-only probe runs before the one transition transaction, so a probe
   * failure leaves zero mutation (Change 4 ordering).
   */
  async init(opts: { entriesExisted?: boolean } = {}): Promise<void> {
    const p = this.prefix;
    const state = await this.metadataRepo.getMeta(FTS5_STATE_KEY);
    const ftsExists = await this.metadataRepo.tableExists(`${p}entries_fts`);
    const mapExists = await this.metadataRepo.tableExists(`${p}fts_map`);
    const pendingExists = await this.metadataRepo.tableExists(`${p}fts_pending`);
    const trig = await this.triggersPresent();

    if (state === null && opts.entriesExisted === false) {
      // Fresh store: nothing to index yet.
      await this.db.withTransactionAsync(async (tx) => {
        await tx.execAsync(fts5TablesDdl(p) + fts5PendingIndexesDdl(p) + fts5TriggersDdl(p));
        await this.metadataRepo.setMeta(FTS5_STATE_KEY, 'live', tx);
      });
      return;
    }
    if (state === 'detached') return this.resetAndRearm(); // re-attach: the map is untrustworthy

    const intact = trig && ftsExists && mapExists && pendingExists;
    if (intact && state === 'rebuilding') return; // resume; each quantum re-verifies the fingerprint
    if (intact && state === 'live') {
      if (await this.liveRowsButNothingIndexed()) return this.resetAndRearm();
      return; // fast path
    }
    // Marker lost, a trigger lost, or a table missing.
    if (ftsExists && mapExists && (await this.keepMapConsistent())) {
      await this.db.withTransactionAsync((tx) => this.rearmInTx(tx));
      return;
    }
    return this.resetAndRearm();
  }

  /** live, a live entry, an empty fts_map and an empty ledger: the index was lost (rev 8 m3 / rev 9 m4). */
  private async liveRowsButNothingIndexed(): Promise<boolean> {
    const p = this.prefix;
    if (await this.db.getFirstAsync(`SELECT 1 AS x FROM ${p}fts_map LIMIT 1`)) return false;
    if (!(await this.db.getFirstAsync(`SELECT 1 AS x FROM ${p}entries WHERE deleted_at IS NULL LIMIT 1`))) return false;
    return (await this.db.getFirstAsync(`SELECT 1 AS x FROM ${p}fts_pending LIMIT 1`)) === null;
  }

  /**
   * Read-only keep-map check (spec DDL note): every surviving entries_fts
   * rowid must have a map row. Max-rowid seek, then docsize vs map counts.
   */
  private async keepMapConsistent(): Promise<boolean> {
    const p = this.prefix;
    const fts = await this.db.getFirstAsync<{ rowid: number }>(`SELECT rowid FROM ${p}entries_fts ORDER BY rowid DESC LIMIT 1`);
    const map = await this.db.getFirstAsync<{ hi: number; n: number }>(
      `SELECT coalesce(max(fts_rowid), 0) AS hi, count(*) AS n FROM ${p}fts_map`);
    if ((fts?.rowid ?? 0) > (map?.hi ?? 0)) return false;
    const doc = await this.db.getFirstAsync<{ n: number }>(`SELECT count(*) AS n FROM ${p}entries_fts_docsize`);
    return (doc?.n ?? 0) === (map?.n ?? 0);
  }

  /** Keep-map re-arm: triggers, empty ledger, rebuild from 0, state rebuilding. One transaction. */
  private async rearmInTx(tx: SQLiteAdapter): Promise<void> {
    const p = this.prefix;
    await tx.execAsync(fts5TablesDdl(p));
    await tx.execAsync(`DELETE FROM ${p}fts_pending;`);
    await tx.execAsync(fts5PendingIndexesDdl(p) + fts5TriggersDdl(p));
    await writeRebuildStart(tx, p, this.metadataRepo);
    await this.metadataRepo.setMeta(FTS5_STATE_KEY, 'rebuilding', tx);
  }

  /** Reset path: retire entries_fts, recreate it empty, clear map + ledger, then the re-arm. One transaction. */
  private async resetAndRearm(): Promise<void> {
    const p = this.prefix;
    await this.db.withTransactionAsync(async (tx) => {
      await this.retireFtsTable(tx);
      await tx.execAsync(fts5TablesDdl(p));
      await tx.execAsync(`DELETE FROM ${p}fts_map; DELETE FROM ${p}fts_pending;`);
      await this.rearmInTx(tx);
    });
  }

  /** B2: drop. B4 replaces this with rename-retire (DROP only as the RENAME-failure fallback). */
  private async retireFtsTable(tx: SQLiteAdapter): Promise<void> {
    await tx.execAsync(`DROP TABLE IF EXISTS ${this.prefix}entries_fts;`);
  }

  async drain(opts: DrainOptions = {}): Promise<void> {
    const ids = opts.ids ?? [];
    if (ids.length > 0) await this.drainIds(ids);
    if (opts.mode === 'ledger') {
      // Write turn: at most ONE foreign chunk after the caller's own ids.
      if (ids.length === 0 && opts.entityId !== undefined) await this.drainEntityChunk(opts.entityId);
      else await this.drainLedgerChunk();
      return;
    }
    await this.fullQuantum(opts.deadline ?? monotonicNow() + this.budgetMs);
  }

  /** Full quantum. B3 extends it with rebuild windows, the sweep and the flip. */
  private async fullQuantum(deadline: number): Promise<void> {
    await this.drainLedgerUntil(deadline);
  }

  /** Seq-ordered ledger chunks until empty or the deadline. True when a chunk ran and the deadline was then reached. */
  private async drainLedgerUntil(deadline: number): Promise<boolean> {
    let ran = false;
    while (await this.drainLedgerChunk()) {
      ran = true;
      if (monotonicNow() >= deadline) return true;
    }
    return ran && monotonicNow() >= deadline;
  }

  /** The caller's own ids, to completion, ≤ FTS5_DRAIN_CHUNK per transaction. */
  private async drainIds(ids: readonly string[]): Promise<void> {
    const unique = [...new Set(ids)];
    const chunk = idDrainChunkSql(this.prefix);
    for (let i = 0; i < unique.length; i += FTS5_DRAIN_CHUNK) {
      const json = JSON.stringify(unique.slice(i, i + FTS5_DRAIN_CHUNK));
      await this.db.withTransactionAsync(async (tx) => {
        for (const sql of chunk) await tx.runAsync(sql, [json]);
      });
    }
  }

  /** One seq-ordered chunk. False when the ledger was empty. */
  private async drainLedgerChunk(): Promise<boolean> {
    const hiSql = drainHiSql(this.prefix);
    const chunk = drainChunkSql(this.prefix);
    // A local, not the callback's return value: host adapters may resolve withTransactionAsync to void.
    let ran = false;
    await this.db.withTransactionAsync(async (tx) => {
      const row = await tx.getFirstAsync<{ hi: number | null }>(hiSql);
      if (row?.hi == null) return;
      for (const sql of chunk) await tx.runAsync(sql, [row.hi]);
      ran = true;
    });
    return ran;
  }

  /** One entity-targeted chunk (ORDER BY seq, ≤ FTS5_DRAIN_CHUNK). */
  private async drainEntityChunk(entityId: string): Promise<void> {
    const hiSql = entityDrainHiSql(this.prefix);
    const chunk = entityDrainChunkSql(this.prefix);
    await this.db.withTransactionAsync(async (tx) => {
      const row = await tx.getFirstAsync<{ hi: number | null }>(hiSql, [entityId]);
      if (row?.hi == null) return;
      for (const sql of chunk) await tx.runAsync(sql, [entityId, row.hi]);
    });
  }

  async replace(entityId: string, ids: readonly string[], documents: readonly IndexDocument[]): Promise<void> {
    assertEntity(entityId, documents);
    const docIds = documents.map((d) => d.id);
    await this.db.withTransactionAsync(async (tx) => {
      // Caller-supplied ids are scoped to the entity; incoming document ids are
      // un-scoped so a doc that previously lived under another entity gets
      // detached (otherwise the fts_map UNIQUE(id) insert would throw).
      await this.deleteByIds(tx, entityId, ids);
      await this.deleteByIds(tx, null, docIds);
      await this.insertDocs(tx, documents);
    });
  }

  async replaceEntity(entityId: string, documents: readonly IndexDocument[]): Promise<void> {
    assertEntity(entityId, documents);
    const p = this.prefix;
    await this.db.withTransactionAsync(async (tx) => {
      await tx.runAsync(
        `DELETE FROM ${p}entries_fts WHERE rowid IN (SELECT fts_rowid FROM ${p}fts_map WHERE entity_id = ?)`, [entityId]);
      await tx.runAsync(`DELETE FROM ${p}fts_map WHERE entity_id = ?`, [entityId]);
      await this.insertDocs(tx, documents);
    });
  }

  async replaceAll(documents: readonly IndexDocument[]): Promise<void> {
    const p = this.prefix;
    await this.db.withTransactionAsync(async (tx) => {
      await tx.execAsync(`DELETE FROM ${p}entries_fts; DELETE FROM ${p}fts_map; DELETE FROM ${p}fts_pending;`);
      await this.insertDocs(tx, documents);
    });
  }

  async search(query: string, options: IndexSearchOptions): Promise<IndexSearchResult[]> {
    if (options.entityIds.length === 0) return [];
    const match = buildFtsMatchQuery(query);
    if (match === null) return [];
    const cap = options.preFilterLimit ?? options.limit;
    const limit = cap >= Number.MAX_SAFE_INTEGER ? -1 : cap;
    const t = `${this.prefix}entries_fts`;
    // bm25 is evaluated once per matching row in the inner query; the outer
    // SELECT only clamps and negates it. The outer ORDER BY is kept because SQL
    // does not guarantee a subquery's order survives into the outer query; it
    // sorts at most `limit` rows.
    return this.db.getAllAsync<IndexSearchResult>(
      `SELECT id, entity_id, max(0.0, -raw) AS score FROM (
         SELECT id, entity_id, bm25(${t}, 0.0, 0.0, 2.0, 1.0, 1.0) AS raw
           FROM ${t}
          WHERE ${t} MATCH ? AND entity_id IN (SELECT value FROM json_each(?))
          ORDER BY raw, id
          LIMIT ?)
        ORDER BY raw, id`,
      [match, JSON.stringify(options.entityIds), limit],
    );
  }

  private async deleteByIds(tx: SQLiteAdapter, entityId: string | null, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const p = this.prefix;
    const json = JSON.stringify(ids);
    const whereEntity = entityId === null ? '' : ' AND entity_id = ?';
    // `json_each(?)` is the first placeholder; the optional `entity_id = ?` follows it.
    const args: unknown[] = [json];
    if (entityId !== null) args.push(entityId);
    await tx.runAsync(
      `DELETE FROM ${p}entries_fts WHERE rowid IN (
         SELECT fts_rowid FROM ${p}fts_map WHERE id IN (SELECT value FROM json_each(?))${whereEntity})`,
      args);
    await tx.runAsync(
      `DELETE FROM ${p}fts_map WHERE id IN (SELECT value FROM json_each(?))${whereEntity}`, args);
  }

  /** One INSERT pair per document: a throw part-way rolls back the whole transaction. */
  private async insertDocs(tx: SQLiteAdapter, documents: readonly IndexDocument[]): Promise<void> {
    const p = this.prefix;
    for (const d of documents) {
      const { lastInsertRowId } = await tx.runAsync(
        `INSERT INTO ${p}fts_map (id, entity_id) VALUES (?, ?)`, [d.id, d.entity_id]);
      await tx.runAsync(
        `INSERT INTO ${p}entries_fts (rowid, id, entity_id, title, body, tags) VALUES (?, ?, ?, ?, ?, ?)`,
        [lastInsertRowId, d.id, d.entity_id, d.title, d.body, d.tags]);
    }
  }

  private async triggersPresent(): Promise<boolean> {
    const names = fts5TriggerNames(this.prefix);
    const rows = await this.db.getAllAsync<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN (?, ?, ?)`, [...names]);
    return rows.length === names.length;
  }
}

function assertEntity(entityId: string, documents: readonly IndexDocument[]): void {
  for (const d of documents) {
    if (d.entity_id !== entityId) {
      throw new TypeError(`IndexDocument ${d.id} has entity_id ${d.entity_id}, expected ${entityId}`);
    }
  }
}

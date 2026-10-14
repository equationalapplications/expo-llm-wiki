// packages/core/src/services/search/Fts5IndexStrategy.ts
import type { SQLiteAdapter } from '../../types';
import type { MetadataRepository } from '../../repositories/MetadataRepository';
import type { DrainOptions, IndexDocument, IndexSearchOptions, IndexSearchResult, IndexStrategy } from './IndexStrategy';
import {
  FTS5_DRAIN_CHUNK, FTS5_RECLAIM_MERGE_PAGES, FTS5_RETIRED_COUNTER_KEY, FTS5_RETIRED_TABLES_KEY, isRetiredTableName, retiredTableName, FTS5_REBUILD_SNAPSHOT_KEY, FTS5_REBUILD_WM_KEY, FTS5_STATE_KEY, FTS5_SWEEP_CURSOR_KEY,
  sweepChunkSql, sweepHiSql, windowChunkSql, windowHiSql, drainChunkSql, drainHiSql, entityDrainChunkSql, entityDrainHiSql, fts5PendingIndexesDdl,
  fts5TablesDdl, fts5TriggerNames, fts5TriggersDdl, idDrainChunkSql, idReindexChunkSql,
} from './fts5Sql';
import { readRebuildProgress, writeRebuildStart, type RebuildProgress, type RebuildWatermark } from './fts5Progress';
import { parseJsonArray } from '../../repositories/rowMappers';
import { monotonicNow } from '../../utils/monotonicNow';
import { DEFAULT_SETUP_BUDGET_MS } from '../../utils/setupDefaults';
import { buildFtsMatchQuery } from './ftsQuery';
import { extractSqliteCode } from '../../db/sqliteCodes';

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
    try {
      await this.initOnce(opts);
    } catch (err) {
      const wrapped = unwrapFtsOnly(err);
      const cls = ftsCorruptionClass(wrapped.cause);
      // Corruption confined to FTS tables: entries is untouched, so a reset re-arm is safe (spec #280 Change 4).
      if (cls === 'vtab' || (cls === 'corrupt' && wrapped.ftsOnly)) {
        await this.resetAndRearm();
        return;
      }
      throw wrapped.cause; // generic errors keep the retry -> UnavailableIndexStrategy path; pinned 'fts5' sees them raw
    }
  }

  /** Marks errors from statements that touch only FTS tables (entries_fts + shadows). */
  private async ftsOnly<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw new FtsOnlyStatementError(err);
    }
  }

  private async initOnce(opts: { entriesExisted?: boolean }): Promise<void> {
    const p = this.prefix;
    const state = await this.metadataRepo.getMeta(FTS5_STATE_KEY);
    const schema = await this.readSchema();
    const ftsExists = schema.tables.has(`${p}entries_fts`);
    const mapExists = schema.tables.has(`${p}fts_map`);
    const pendingExists = schema.tables.has(`${p}fts_pending`);
    const trig = schema.triggersPresent;
    const ftsDdl = schema.tables.get(`${p}entries_fts`) ?? null;
    const tokenizerOk = ftsDdl === null || /tokenize\s*=\s*['"]porter\s+unicode61['"]/i.test(ftsDdl);

    if (state === null && opts.entriesExisted === false) {
      // Fresh store: nothing to index yet.
      await this.db.withTransactionAsync(async (tx) => {
        await tx.execAsync(fts5TablesDdl(p) + fts5PendingIndexesDdl(p) + fts5TriggersDdl(p));
        await this.metadataRepo.setMeta(FTS5_STATE_KEY, 'live', tx);
      });
      return;
    }
    if (state === 'detached') return this.resetAndRearm(); // re-attach: the map is untrustworthy

    if (!tokenizerOk) return this.resetAndRearm();

    const intact = trig && ftsExists && mapExists && pendingExists;
    if (intact && state === 'rebuilding') return; // resume; each quantum re-verifies the fingerprint
    if (intact && state === 'live') {
      await this.ftsOnly(() => this.db.getFirstAsync(`SELECT rowid FROM ${p}entries_fts ORDER BY rowid DESC LIMIT 1`));
      if (await this.liveRowUnindexed()) return this.resetAndRearm();
      return; // fast path
    }
    // Marker lost, a trigger lost, or a table missing.
    if (ftsExists && mapExists && (await this.keepMapConsistent())) {
      await this.db.withTransactionAsync((tx) => this.rearmInTx(tx));
      return;
    }
    return this.resetAndRearm();
  }

  /**
   * The index was lost (rev 8 m3 / rev 9 m4): the oldest or the newest live entry is neither mapped nor
   * ledgered, which `live` never allows. The oldest one keeps detection armed after post-loss writes
   * repopulate the map and the ledger (#284 review). Every-open path: each side reads at most
   * FTS5_DRAIN_CHUNK entries rows (final review M1), so an all-soft-deleted store is never fully scanned;
   * a lost index whose oldest and newest rows are all deleted goes undetected.
   */
  private async liveRowUnindexed(): Promise<boolean> {
    const p = this.prefix;
    const edge = (dir: 'ASC' | 'DESC') => `SELECT id FROM (SELECT id FROM (SELECT id, deleted_at FROM ${p}entries`
      + ` ORDER BY rowid ${dir} LIMIT ${FTS5_DRAIN_CHUNK}) WHERE deleted_at IS NULL LIMIT 1)`;
    return (await this.db.getFirstAsync(
      `SELECT 1 AS x FROM (${edge('ASC')} UNION ALL ${edge('DESC')}) e
        WHERE NOT EXISTS (SELECT 1 FROM ${p}fts_map m WHERE m.id = e.id)
          AND NOT EXISTS (SELECT 1 FROM ${p}fts_pending q WHERE q.id = e.id)
        LIMIT 1`)) !== null;
  }

  /**
   * Read-only keep-map check (spec DDL note): every surviving entries_fts
   * rowid must have a map row. Max-rowid seek, then docsize vs map counts.
   */
  private async keepMapConsistent(): Promise<boolean> {
    const p = this.prefix;
    const fts = await this.ftsOnly(() => this.db.getFirstAsync<{ rowid: number }>(`SELECT rowid FROM ${p}entries_fts ORDER BY rowid DESC LIMIT 1`));
    const map = await this.db.getFirstAsync<{ hi: number; n: number }>(
      `SELECT coalesce(max(fts_rowid), 0) AS hi, count(*) AS n FROM ${p}fts_map`);
    if ((fts?.rowid ?? 0) > (map?.hi ?? 0)) return false;
    const doc = await this.ftsOnly(() => this.db.getFirstAsync<{ n: number }>(`SELECT count(*) AS n FROM ${p}entries_fts_docsize`));
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

  /** Rename-retire entries_fts (spec #280 rev 11); DROP only when the RENAME throws. */
  private async retireFtsTable(tx: SQLiteAdapter): Promise<void> {
    const p = this.prefix;
    if (!(await this.metadataRepo.tableExists(`${p}entries_fts`, tx))) return;
    const n = Number((await this.metadataRepo.getMeta(FTS5_RETIRED_COUNTER_KEY, tx)) ?? '0') + 1;
    const name = retiredTableName(p, n);
    try {
      await tx.execAsync(`ALTER TABLE ${p}entries_fts RENAME TO ${name}`);
    } catch (err) {
      // Not damage: SQLite may have rolled the transaction back already, so further statements would
      // autocommit one by one. Fail the reset whole instead (#284 review).
      if (isTransientOrTxFatal(err)) throw err;
      // Shadow tables too damaged to rename: today's DROP, with its measured floor, for this case only.
      await tx.execAsync(`DROP TABLE ${p}entries_fts`);
      return;
    }
    await this.metadataRepo.setMeta(FTS5_RETIRED_TABLES_KEY, JSON.stringify([...(await this.retiredList(tx)), name]), tx);
    await this.metadataRepo.setMeta(FTS5_RETIRED_COUNTER_KEY, String(n), tx);
  }

  private async retiredList(tx: SQLiteAdapter = this.db): Promise<string[]> {
    const raw = parseJsonArray<unknown>(await this.metadataRepo.getMeta(FTS5_RETIRED_TABLES_KEY, tx), []);
    return raw.filter((n): n is string => isRetiredTableName(this.prefix, n));
  }

  async drain(opts: DrainOptions = {}): Promise<void> {
    try {
      await this.drainOnce(opts);
    } catch (err) {
      // SQLITE_CORRUPT_VTAB names the FTS5 table itself, so the reset init() applies is safe here too:
      // without it every drain fails until the next open (#284 review). Other corruption may be in
      // entries, which this cannot repair: it propagates as before.
      if (ftsCorruptionClass(err) !== 'vtab') throw err;
      await this.resetAndRearm();
      // The reset cleared the ledger, so the caller's ids are re-indexed from entries: resolving
      // still means they are searchable (DrainOptions.ids), and the caller may drop them.
      if (opts.ids && opts.ids.length > 0) await this.drainIds(opts.ids, idReindexChunkSql(this.prefix));
    }
  }

  private async drainOnce(opts: DrainOptions): Promise<void> {
    const ids = opts.ids ?? [];
    // The caller's own ids are not deadline-bound (DrainOptions.ids): they drain to completion, and the caller drops them from its stash only once this succeeds.
    if (ids.length > 0) await this.drainIds(ids);
    if (opts.mode === 'ledger') {
      // Write turn: at most ONE foreign chunk after the caller's own ids.
      if (ids.length === 0 && opts.entityId !== undefined) await this.drainEntityChunk(opts.entityId);
      else await this.drainLedgerChunk();
      return;
    }
    await this.fullQuantum(opts.deadline ?? monotonicNow() + this.budgetMs);
  }

  /**
   * One full quantum (spec #280 Change 3): ledger first (at most half the
   * budget while `rebuilding`); then, while `rebuilding`, ≥1 window unless
   * the ledger drain overran the deadline, one sweep tx, and the flip check;
   * then reclamation. A `live` store reads only the state.
   */
  private async fullQuantum(deadline: number): Promise<void> {
    const rebuilding = (await this.metadataRepo.getMeta(FTS5_STATE_KEY)) === 'rebuilding';
    // While rebuilding, the ledger stops at half the remaining budget, so a steady write backlog cannot
    // starve the windows (#284 review). Overrun is still judged against the full deadline.
    const start = monotonicNow();
    const ledgerRan = await this.drainLedgerUntil(rebuilding ? start + (deadline - start) / 2 : deadline);
    const ledgerOverran = ledgerRan && monotonicNow() >= deadline;
    if (rebuilding) {
      const progress = await readRebuildProgress(this.metadataRepo);
      if (!progress || !(await this.fingerprintValid(progress.wm))) {
        // Windows resume next quantum; reclamation below still runs (#284 review).
        await this.restartRebuild();
      } else {
        if (!ledgerOverran) {
          let step: WindowStep;
          do {
            step = await this.runWindow(progress);
          } while (step === 'more' && monotonicNow() < deadline);
          // 'stale': progress moved under this quantum (a VACUUM restart, a re-anchor, a flip); the next quantum re-reads it.
          if (step !== 'stale') await this.runSweepTx(progress);
        }
        await this.tryFlip();
      }
    }
    try {
      await this.reclaimRetired(deadline);
    } catch (err) {
      // Best-effort for database errors only: a locked retired table stays listed and is retried next quantum,
      // never failing drain() or the flip. A non-SQLite error is a bug and propagates (final review I2).
      if (!isSqliteError(err)) throw err;
    }
  }

  /** Bounded reclamation steps, each its own tx, until the deadline or nothing is retired. */
  private async reclaimRetired(deadline: number): Promise<void> {
    while (monotonicNow() < deadline) {
      const [name] = await this.retiredList();
      if (name === undefined) return;
      try {
        // The list and the table are read once per table, not per step (#284 review).
        if (!(await this.metadataRepo.tableExists(name))) {
          await this.delistRetired(name, false);
          continue;
        }
        while (!(await this.reclaimStep(name)) && monotonicNow() < deadline);
      } catch (err) {
        if (ftsCorruptionClass(err) === null) throw err;
        // Persistently corrupt (the corruption reset is what retired it): DROP once and delist; if even
        // the DROP fails, delist anyway so no quantum re-reads its corrupt pages (final review I2).
        try {
          await this.delistRetired(name, true);
        } catch (dropErr) {
          if (!isSqliteError(dropErr)) throw dropErr;
          await this.delistRetired(name, false);
        }
      }
    }
  }

  /** (1) delete <=500 rows, else (2) one bounded merge, else (3) DROP + delist. True once delisted. */
  private async reclaimStep(name: string): Promise<boolean> {
    if (await this.db.getFirstAsync(`SELECT rowid FROM ${name} LIMIT 1`)) {
      await this.db.withTransactionAsync(async (tx) => {
        await tx.runAsync(`DELETE FROM ${name} WHERE rowid IN (SELECT rowid FROM ${name} ORDER BY rowid LIMIT ${FTS5_DRAIN_CHUNK})`);
      });
      return false;
    }
    let merged = false;
    await this.db.withTransactionAsync(async (tx) => {
      const before = await tx.getFirstAsync<{ n: number }>(`SELECT total_changes() AS n`);
      await tx.runAsync(`INSERT INTO ${name}(${name}, rank) VALUES('merge', ${FTS5_RECLAIM_MERGE_PAGES})`);
      const after = await tx.getFirstAsync<{ n: number }>(`SELECT total_changes() AS n`);
      merged = (after?.n ?? 0) - (before?.n ?? 0) >= 2; // FTS5 docs: < 2 means the merge did no work
    });
    if (!merged) await this.delistRetired(name, true);
    return !merged;
  }

  private async delistRetired(name: string, drop: boolean): Promise<void> {
    await this.db.withTransactionAsync(async (tx) => {
      if (drop) await tx.execAsync(`DROP TABLE IF EXISTS ${name}`);
      const rest = (await this.retiredList(tx)).filter((n) => n !== name);
      await this.metadataRepo.setMeta(FTS5_RETIRED_TABLES_KEY, JSON.stringify(rest), tx);
    });
  }

  /** The id at the watermark's rowid still matches. A null id (start, or windows complete) has nothing to check. */
  private async fingerprintValid(wm: RebuildWatermark, tx: SQLiteAdapter = this.db): Promise<boolean> {
    if (wm.id === null) return true;
    const row = await tx.getFirstAsync<{ id: string }>(`SELECT id FROM ${this.prefix}entries WHERE rowid = ?`, [wm.rowid]);
    return row?.id === wm.id;
  }

  /** External change under the watermark: start over (same re-arm transaction as a trigger-loss restart). */
  private async restartRebuild(): Promise<void> {
    await this.db.withTransactionAsync((tx) => this.rearmInTx(tx));
  }

  /**
   * Progress as stored, re-read inside a window/sweep tx: false when it no
   * longer matches what this quantum assumed (final review I1). Writing a
   * watermark or cursor computed from a stale `pr` would overwrite a
   * concurrent restart (runPrune VACUUM is not on the sync chain).
   */
  private async progressUnchanged(pr: RebuildProgress, tx: SQLiteAdapter): Promise<boolean> {
    if ((await this.metadataRepo.getMeta(FTS5_STATE_KEY, tx)) !== 'rebuilding') return false;
    const cur = await readRebuildProgress(this.metadataRepo, tx);
    return cur !== null && cur.wm.rowid === pr.wm.rowid && cur.wm.id === pr.wm.id && cur.cursor === pr.cursor
      && cur.snapshot.entries === pr.snapshot.entries && cur.snapshot.map === pr.snapshot.map;
  }

  /** One window tx. 'done' once no rows remain in (wm, snapshot] (the watermark is then pinned at the snapshot, F9); 'stale' when progress moved under the quantum. */
  private async runWindow(pr: RebuildProgress): Promise<WindowStep> {
    if (pr.wm.rowid >= pr.snapshot.entries) return 'done';
    const p = this.prefix;
    let next: RebuildWatermark = pr.wm;
    let more = false;
    let stale = false;
    await this.db.withTransactionAsync(async (tx) => {
      if (!(await this.progressUnchanged(pr, tx))) { stale = true; return; }
      const row = await tx.getFirstAsync<{ hi: number | null }>(windowHiSql(p), [pr.wm.rowid, pr.snapshot.entries]);
      if (row?.hi == null) {
        next = { rowid: pr.snapshot.entries, id: null };
      } else {
        for (const sql of windowChunkSql(p)) await tx.runAsync(sql, [pr.wm.rowid, row.hi]);
        const fp = await tx.getFirstAsync<{ id: string }>(`SELECT id FROM ${p}entries WHERE rowid = ?`, [row.hi]);
        next = { rowid: row.hi, id: fp!.id };
        more = true;
      }
      await this.metadataRepo.setMeta(FTS5_REBUILD_WM_KEY, JSON.stringify(next), tx);
    });
    if (stale) return 'stale';
    pr.wm = next; // only after the tx resolved
    return more ? 'more' : 'done';
  }

  /** At most one bounded sweep tx; the cursor advances in the same tx. */
  private async runSweepTx(pr: RebuildProgress): Promise<void> {
    if (pr.cursor >= pr.snapshot.map) return;
    const p = this.prefix;
    let next = pr.cursor;
    await this.db.withTransactionAsync(async (tx) => {
      if (!(await this.progressUnchanged(pr, tx))) return; // keep pr.cursor; the next quantum re-reads
      const row = await tx.getFirstAsync<{ hi: number | null }>(sweepHiSql(p), [pr.cursor, pr.snapshot.map]);
      const hi = row?.hi ?? pr.snapshot.map;
      for (const sql of sweepChunkSql(p)) await tx.runAsync(sql, [pr.cursor, hi]);
      await this.metadataRepo.setMeta(FTS5_SWEEP_CURSOR_KEY, String(hi), tx);
      next = hi;
    });
    pr.cursor = next;
  }

  /** Completion, re-checked inside the flipping tx; the residual ledger (≤ one chunk) drains in it. */
  private async tryFlip(): Promise<void> {
    const p = this.prefix;
    await this.db.withTransactionAsync(async (tx) => {
      if ((await this.metadataRepo.getMeta(FTS5_STATE_KEY, tx)) !== 'rebuilding') return;
      const pr = await readRebuildProgress(this.metadataRepo, tx);
      if (!pr || pr.wm.rowid < pr.snapshot.entries || pr.cursor < pr.snapshot.map) return;
      if (!(await this.fingerprintValid(pr.wm, tx))) return;
      const residual = await tx.getFirstAsync<{ n: number }>(
        `SELECT count(*) AS n FROM (SELECT 1 FROM ${p}fts_pending LIMIT ${FTS5_DRAIN_CHUNK + 1})`);
      if ((residual?.n ?? 0) > FTS5_DRAIN_CHUNK) return;
      const hi = await tx.getFirstAsync<{ hi: number | null }>(drainHiSql(p));
      if (hi?.hi != null) for (const sql of drainChunkSql(p)) await tx.runAsync(sql, [hi.hi]);
      await this.metadataRepo.deleteMeta(FTS5_REBUILD_WM_KEY, tx);
      await this.metadataRepo.deleteMeta(FTS5_REBUILD_SNAPSHOT_KEY, tx);
      await this.metadataRepo.deleteMeta(FTS5_SWEEP_CURSOR_KEY, tx);
      await this.metadataRepo.setMeta(FTS5_STATE_KEY, 'live', tx);
    });
  }

  /** Seq-ordered ledger chunks until empty or `stopAt`. True when a chunk ran. */
  private async drainLedgerUntil(stopAt: number): Promise<boolean> {
    let ran = false;
    while (await this.drainLedgerChunk()) {
      ran = true;
      if (monotonicNow() >= stopAt) break;
    }
    return ran;
  }

  /** The caller's own ids, to completion, ≤ FTS5_DRAIN_CHUNK per transaction. */
  private async drainIds(ids: readonly string[], chunk: readonly string[] = idDrainChunkSql(this.prefix)): Promise<void> {
    const unique = [...new Set(ids)];
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

  /** The init probes' schema facts in one sqlite_master read (#284 review): FTS tables with their DDL, and the triggers. */
  private async readSchema(): Promise<{ tables: Map<string, string | null>; triggersPresent: boolean }> {
    const p = this.prefix;
    const triggers = fts5TriggerNames(p);
    const names = [`${p}entries_fts`, `${p}fts_map`, `${p}fts_pending`, ...triggers];
    const rows = await this.db.getAllAsync<{ type: string; name: string; sql: string | null }>(
      `SELECT type, name, sql FROM sqlite_master WHERE name IN (${names.map(() => '?').join(', ')})`, names);
    const tables = new Map(rows.filter((r) => r.type === 'table').map((r) => [r.name, r.sql] as const));
    const present = new Set(rows.filter((r) => r.type === 'trigger').map((r) => r.name));
    return { tables, triggersPresent: triggers.every((n) => present.has(n)) };
  }
}

type WindowStep = 'more' | 'done' | 'stale';

class FtsOnlyStatementError extends Error {
  readonly ftsOnlyCause: unknown;
  constructor(cause: unknown) {
    super('FTS-only statement failed');
    this.ftsOnlyCause = cause;
  }
}

/** Proxy-safe unwrap (issue #96): never `instanceof` a caught value bare. */
function unwrapFtsOnly(err: unknown): { cause: unknown; ftsOnly: boolean } {
  try {
    if (err instanceof FtsOnlyStatementError) return { cause: err.ftsOnlyCause, ftsOnly: true };
  } catch { /* hostile Proxy */ }
  return { cause: err, ftsOnly: false };
}

/**
 * Proxy-safe extractSqliteCode (issue #96): any trap => undefined. Also reads
 * WikiTransactionError's `sqliteErrorCode`: the serialized adapter wraps every
 * failed transaction in one, so the driver code is not on `code` (#284 review).
 */
function safeSqliteCode(err: unknown): string | undefined {
  try {
    const code = extractSqliteCode(err);
    if (code !== undefined) return code;
    const lifted = (err as { sqliteErrorCode?: unknown } | null | undefined)?.sqliteErrorCode;
    return typeof lifted === 'string' ? lifted : undefined;
  } catch {
    return undefined;
  }
}

/** Busy/locked, or a code after which SQLite may roll the transaction back (sqlite.org/lang_transaction.html). Extended codes match by primary name. */
const TRANSIENT_OR_TX_FATAL = ['SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_FULL', 'SQLITE_IOERR', 'SQLITE_NOMEM', 'SQLITE_INTERRUPT', 'SQLITE_ABORT', 'SQLITE_READONLY'];

function isTransientOrTxFatal(err: unknown): boolean {
  const code = safeSqliteCode(err);
  return code !== undefined && TRANSIENT_OR_TX_FATAL.some((c) => code === c || code.startsWith(`${c}_`));
}

/**
 * 'vtab' for SQLITE_CORRUPT_VTAB (extended code 267, any statement), 'corrupt'
 * for another SQLITE_CORRUPT* code, else null. Proxy-safe: any trap => null.
 */
export function ftsCorruptionClass(err: unknown): 'vtab' | 'corrupt' | null {
  const code = safeSqliteCode(err);
  if (code === 'SQLITE_CORRUPT_VTAB') return 'vtab';
  if (code?.startsWith('SQLITE_CORRUPT')) return 'corrupt';
  return null;
}

/** A SQLite error (better-sqlite3 / expo-sqlite shapes): `code` 'SQLITE_*' or an 'Error code N:' message. Proxy-safe: any trap => false. */
export function isSqliteError(err: unknown): boolean {
  return safeSqliteCode(err) !== undefined;
}

function assertEntity(entityId: string, documents: readonly IndexDocument[]): void {
  for (const d of documents) {
    if (d.entity_id !== entityId) {
      throw new TypeError(`IndexDocument ${d.id} has entity_id ${d.entity_id}, expected ${entityId}`);
    }
  }
}

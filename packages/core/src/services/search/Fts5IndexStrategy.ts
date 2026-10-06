// packages/core/src/services/search/Fts5IndexStrategy.ts
import type { SQLiteAdapter } from '../../types';
import type { MetadataRepository } from '../../repositories/MetadataRepository';
import type { IndexDocument, IndexSearchOptions, IndexSearchResult, IndexStrategy } from './IndexStrategy';
import {
  FTS5_STATE_KEY, drainChunkSql, drainHiSql, fts5TablesDdl, fts5TriggerNames, fts5TriggersDdl, rebuildSql,
} from './fts5Sql';
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
  ) {}

  async init(): Promise<void> {
    const state = await this.metadataRepo.getMeta(FTS5_STATE_KEY);
    if (state === 'live' && (await this.triggersPresent())) {
      await this.db.execAsync(fts5TablesDdl(this.prefix));
      return;
    }
    // detached, missing, or live with a trigger gone: one transaction rebuilds
    // and re-arms, so no write can slip between the rebuild and the triggers.
    await this.db.withTransactionAsync(async (tx) => {
      await tx.execAsync(`DROP TABLE IF EXISTS ${this.prefix}entries_fts;`);
      await tx.execAsync(fts5TablesDdl(this.prefix));
      await this.rebuildInTx(tx);
      await tx.execAsync(fts5TriggersDdl(this.prefix));
      await this.metadataRepo.setMeta(FTS5_STATE_KEY, 'live', tx);
    });
  }

  async rebuildFromSource(): Promise<void> {
    await this.db.withTransactionAsync((tx) => this.rebuildInTx(tx));
  }

  async drain(): Promise<void> {
    const hiSql = drainHiSql(this.prefix);
    const chunk = drainChunkSql(this.prefix);
    for (;;) {
      const done = await this.db.withTransactionAsync(async (tx) => {
        const row = await tx.getFirstAsync<{ hi: number | null }>(hiSql);
        if (row?.hi == null) return true;
        for (const sql of chunk) await tx.runAsync(sql, [row.hi]);
        return false;
      });
      if (done) return;
    }
  }

  async replace(entityId: string, ids: readonly string[], documents: readonly IndexDocument[]): Promise<void> {
    assertEntity(entityId, documents);
    const drop = [...new Set([...ids, ...documents.map((d) => d.id)])];
    await this.db.withTransactionAsync(async (tx) => {
      await this.deleteByIds(tx, entityId, drop);
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
    const bm25 = `bm25(${t}, 0.0, 0.0, 2.0, 1.0, 1.0)`;
    return this.db.getAllAsync<IndexSearchResult>(
      `SELECT id, entity_id, max(0.0, -${bm25}) AS score
         FROM ${t}
        WHERE ${t} MATCH ? AND entity_id IN (SELECT value FROM json_each(?))
        ORDER BY ${bm25}, id
        LIMIT ?`,
      [match, JSON.stringify(options.entityIds), limit],
    );
  }

  private async deleteByIds(tx: SQLiteAdapter, entityId: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const p = this.prefix;
    const json = JSON.stringify(ids);
    await tx.runAsync(
      `DELETE FROM ${p}entries_fts WHERE rowid IN (
         SELECT fts_rowid FROM ${p}fts_map WHERE entity_id = ? AND id IN (SELECT value FROM json_each(?)))`,
      [entityId, json]);
    await tx.runAsync(
      `DELETE FROM ${p}fts_map WHERE entity_id = ? AND id IN (SELECT value FROM json_each(?))`, [entityId, json]);
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

  private async rebuildInTx(tx: SQLiteAdapter): Promise<void> {
    const p = this.prefix;
    await tx.execAsync(`DELETE FROM ${p}entries_fts; DELETE FROM ${p}fts_map; DELETE FROM ${p}fts_pending;`);
    for (const sql of rebuildSql(p)) await tx.runAsync(sql);
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

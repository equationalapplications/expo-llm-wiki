// packages/core/src/services/search/Fts5IndexStrategy.ts
import type { SQLiteAdapter } from '../../types';
import type { MetadataRepository } from '../../repositories/MetadataRepository';
import type { IndexDocument, IndexSearchOptions, IndexSearchResult, IndexStrategy } from './IndexStrategy';
import {
  FTS5_STATE_KEY, drainChunkSql, drainHiSql, fts5TablesDdl, fts5TriggerNames, fts5TriggersDdl, rebuildSql,
} from './fts5Sql';

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

  async replace(_entityId: string, _ids: readonly string[], _documents: readonly IndexDocument[]): Promise<void> {
    throw new Error('not implemented');
  }
  async replaceEntity(_entityId: string, _documents: readonly IndexDocument[]): Promise<void> {
    throw new Error('not implemented');
  }
  async replaceAll(_documents: readonly IndexDocument[]): Promise<void> {
    throw new Error('not implemented');
  }
  async search(_query: string, _options: IndexSearchOptions): Promise<IndexSearchResult[]> {
    throw new Error('not implemented');
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

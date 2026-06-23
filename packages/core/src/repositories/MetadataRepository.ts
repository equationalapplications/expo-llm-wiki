import { BaseRepository } from './BaseRepository';
import type { SQLiteAdapter, OntologyManifest, OntologyMode, OntologyUpdates } from '../types';
import { emptyManifest, mergeOntologyUpdates, validateManifest } from '../utils/ontology';

export class MetadataRepository extends BaseRepository {
  // CHECKPOINTS TABLE METHODS

  async getCheckpoint(entityId: string, tx: SQLiteAdapter): Promise<{ memory?: number; heal?: number }> {
    const executor = this.getExecutor(tx);
    const row = await executor.getFirstAsync<{
      memory_checkpoint: number | null;
      heal_checkpoint: number | null;
    }>(
      `SELECT memory_checkpoint, heal_checkpoint FROM ${this.prefix}checkpoints WHERE entity_id = ?`,
      [entityId],
    );
    if (!row) return {};
    return {
      memory: row.memory_checkpoint ?? undefined,
      heal: row.heal_checkpoint ?? undefined,
    };
  }

  async updateCheckpoint(
    entityId: string,
    updates: { memory?: number; heal?: number },
    tx: SQLiteAdapter,
  ): Promise<void> {
    const fields: string[] = [];
    const values: number[] = [];

    if (updates.memory !== undefined) {
      fields.push('memory_checkpoint = ?');
      values.push(updates.memory);
    }
    if (updates.heal !== undefined) {
      fields.push('heal_checkpoint = ?');
      values.push(updates.heal);
    }
    if (fields.length === 0) return;

    const executor = this.getExecutor(tx);
    await executor.runAsync(
      `INSERT INTO ${this.prefix}checkpoints (entity_id, memory_checkpoint, heal_checkpoint)
       VALUES (?, ?, ?)
       ON CONFLICT(entity_id) DO UPDATE SET ${fields.join(', ')}`,
      [entityId, updates.memory ?? 0, updates.heal ?? 0, ...values],
    );
  }

  async deleteCheckpoint(entityId: string, tx: SQLiteAdapter): Promise<void> {
    const executor = this.getExecutor(tx);
    await executor.runAsync(
      `DELETE FROM ${this.prefix}checkpoints WHERE entity_id = ?`,
      [entityId],
    );
  }

  // META TABLE METHODS

  async getMeta(key: string, tx?: SQLiteAdapter): Promise<string | null> {
    const executor = this.getExecutor(tx);
    const row = await executor.getFirstAsync<{ value: string }>(
      `SELECT value FROM ${this.prefix}meta WHERE key = ?`,
      [key],
    );
    return row ? row.value : null;
  }

  async setMeta(key: string, value: string, tx: SQLiteAdapter): Promise<void> {
    const executor = this.getExecutor(tx);
    await executor.runAsync(
      `INSERT INTO ${this.prefix}meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value],
    );
  }

  async clearDimensionMismatch(tx: SQLiteAdapter): Promise<void> {
    const executor = this.getExecutor(tx);
    await executor.runAsync(
      `DELETE FROM ${this.prefix}meta WHERE key = 'embedding_dimension_mismatch'`,
    );
  }

  async tableExists(tableName: string, tx?: SQLiteAdapter): Promise<boolean> {
    const executor = this.getExecutor(tx);
    const row = await executor.getFirstAsync<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
      [tableName],
    );
    return row != null;
  }

  async getTableDdl(tableName: string, tx?: SQLiteAdapter): Promise<string | null> {
    const executor = this.getExecutor(tx);
    const row = await executor.getFirstAsync<{ sql: string | null }>(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name=?`,
      [tableName],
    );
    return row?.sql ?? null;
  }

  async vacuum(): Promise<void> {
    await this.db.execAsync(`PRAGMA wal_checkpoint(TRUNCATE)`);
    await this.db.execAsync(`VACUUM`);
  }

  async getDistinctEntityIds(tx?: SQLiteAdapter): Promise<string[]> {
    const executor = this.getExecutor(tx);
    const rows = await executor.getAllAsync<{ entity_id: string }>(
      `SELECT DISTINCT entity_id FROM (
         SELECT entity_id FROM ${this.prefix}entries WHERE deleted_at IS NULL
         UNION
         SELECT entity_id FROM ${this.prefix}tasks WHERE deleted_at IS NULL
         UNION
         SELECT entity_id FROM ${this.prefix}events
       ) ORDER BY entity_id`,
    );
    return rows.map(r => r.entity_id);
  }

  async getManifest(entityId: string, tx?: SQLiteAdapter): Promise<{
    mode: OntologyMode;
    manifest: OntologyManifest;
  } | null> {
    const executor = this.getExecutor(tx);
    const row = await executor.getFirstAsync<{
      mode: string;
      manifest_json: string;
    }>(`SELECT mode, manifest_json FROM ${this.prefix}entity_manifests WHERE entity_id = ?`, [entityId]);
    if (!row) return null;
    if (row.mode !== 'off' && row.mode !== 'strict' && row.mode !== 'emergent') {
      throw new Error(`Invalid ontology mode for entity ${entityId}: ${JSON.stringify(row.mode)}`);
    }
    let manifest: OntologyManifest;
    try {
      manifest = JSON.parse(row.manifest_json) as OntologyManifest;
    } catch (error) {
      throw new Error(`Invalid manifest_json for entity ${entityId}: ${(error as Error).message}`);
    }
    validateManifest(manifest);
    return {
      mode: row.mode,
      manifest,
    };
  }

  async setManifest(
    entityId: string,
    data: { mode: OntologyMode; manifest: OntologyManifest },
    tx: SQLiteAdapter,
  ): Promise<void> {
    validateManifest(data.manifest);
    const executor = this.getExecutor(tx);
    await executor.runAsync(
      `INSERT INTO ${this.prefix}entity_manifests (entity_id, mode, manifest_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(entity_id) DO UPDATE SET mode = excluded.mode, manifest_json = excluded.manifest_json, updated_at = excluded.updated_at`,
      [entityId, data.mode, JSON.stringify(data.manifest), Date.now()],
    );
  }

  async mergeManifestUpdates(
    entityId: string,
    updates: OntologyUpdates,
    tx: SQLiteAdapter,
  ): Promise<OntologyManifest> {
    const current = (await this.getManifest(entityId, tx)) ?? {
      mode: 'emergent' as OntologyMode,
      manifest: emptyManifest(),
    };
    const merged = mergeOntologyUpdates(current.manifest, updates);
    await this.setManifest(entityId, { mode: current.mode, manifest: merged }, tx);
    return merged;
  }
}

// packages/core/src/services/search/fts5Progress.ts
//
// Rebuild progress for the FTS5 `rebuilding` state (spec #280 Change 3):
// watermark + fingerprint, re-arm snapshot, orphan-sweep cursor.
import type { SQLiteAdapter } from '../../types';
import type { MetadataRepository } from '../../repositories/MetadataRepository';
import { parseJsonObject } from '../../repositories/rowMappers';
import { FTS5_REBUILD_SNAPSHOT_KEY, FTS5_REBUILD_WM_KEY, FTS5_STATE_KEY, FTS5_SWEEP_CURSOR_KEY } from './fts5Sql';

export interface RebuildWatermark { rowid: number; id: string | null }
export interface RebuildProgress {
  wm: RebuildWatermark;
  snapshot: { entries: number; map: number };
  cursor: number;
}

/** Starts (or restarts) a rebuild from 0. Call inside the transition transaction. */
export async function writeRebuildStart(tx: SQLiteAdapter, prefix: string, meta: MetadataRepository): Promise<void> {
  const e = await tx.getFirstAsync<{ hi: number }>(`SELECT coalesce(max(rowid), 0) AS hi FROM ${prefix}entries`);
  const m = await tx.getFirstAsync<{ hi: number }>(`SELECT coalesce(max(fts_rowid), 0) AS hi FROM ${prefix}fts_map`);
  await meta.setMeta(FTS5_REBUILD_WM_KEY, JSON.stringify({ rowid: 0, id: null }), tx);
  await meta.setMeta(FTS5_REBUILD_SNAPSHOT_KEY, JSON.stringify({ entries: e?.hi ?? 0, map: m?.hi ?? 0 }), tx);
  await meta.setMeta(FTS5_SWEEP_CURSOR_KEY, '0', tx);
}

/** Parsed progress, or null when any key is missing or malformed (the caller restarts). */
export async function readRebuildProgress(meta: MetadataRepository, tx?: SQLiteAdapter): Promise<RebuildProgress | null> {
  const wm = parseJsonObject<{ rowid?: unknown; id?: unknown }>(await meta.getMeta(FTS5_REBUILD_WM_KEY, tx));
  const snap = parseJsonObject<{ entries?: unknown; map?: unknown }>(await meta.getMeta(FTS5_REBUILD_SNAPSHOT_KEY, tx));
  const rawCursor = await meta.getMeta(FTS5_SWEEP_CURSOR_KEY, tx);
  const cursor = rawCursor === null ? Number.NaN : Number(rawCursor);
  if (typeof wm?.rowid !== 'number' || !(typeof wm.id === 'string' || wm.id === null)) return null;
  if (typeof snap?.entries !== 'number' || typeof snap.map !== 'number' || !Number.isFinite(cursor)) return null;
  return { wm: { rowid: wm.rowid, id: wm.id }, snapshot: { entries: snap.entries, map: snap.map }, cursor };
}

/**
 * Keeps the rebuild fingerprint valid across an engine hard-delete (spec #280
 * Change 3): call in the deleting transaction, after the DELETE. Only when
 * the fingerprint id is among `deletedIds` does the watermark move to the
 * greatest surviving rowid below it (or 0), so a missing fingerprint at
 * check time always means an external change, which restarts the rebuild.
 * Raw meta SQL: repositories must not depend on MetadataRepository here.
 */
export async function reanchorRebuildFingerprint(tx: SQLiteAdapter, prefix: string, deletedIds: readonly string[]): Promise<void> {
  if (deletedIds.length === 0) return;
  const metaValue = async (key: string) =>
    (await tx.getFirstAsync<{ value: string }>(`SELECT value FROM ${prefix}meta WHERE key = ?`, [key]))?.value ?? null;
  if ((await metaValue(FTS5_STATE_KEY)) !== 'rebuilding') return;
  const wm = parseJsonObject<{ rowid?: unknown; id?: unknown }>(await metaValue(FTS5_REBUILD_WM_KEY));
  if (typeof wm?.rowid !== 'number' || typeof wm.id !== 'string' || !deletedIds.includes(wm.id)) return;
  if ((await tx.getFirstAsync<{ id: string }>(`SELECT id FROM ${prefix}entries WHERE rowid = ?`, [wm.rowid]))?.id === wm.id) return;
  const below = await tx.getFirstAsync<{ rowid: number; id: string }>(
    `SELECT rowid, id FROM ${prefix}entries WHERE rowid < ? ORDER BY rowid DESC LIMIT 1`, [wm.rowid]);
  const next: RebuildWatermark = below ? { rowid: below.rowid, id: below.id } : { rowid: 0, id: null };
  await tx.runAsync(`UPDATE ${prefix}meta SET value = ? WHERE key = ?`, [JSON.stringify(next), FTS5_REBUILD_WM_KEY]);
}

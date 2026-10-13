import type { PendingMigrationWork, SQLiteAdapter } from '../types';
import { MetadataRepository } from '../repositories/MetadataRepository';
import { normalizeSourceRef } from '../utils/pure';
import { CURRENT_SCHEMA_VERSION } from './migrations';

export const SOURCE_REF_NORMALIZE_ALG = 1;
/** Schema version that introduced the stamped normalize; recorded in the stamp, not compared. */
const NORMALIZE_STAMP_SCHEMA_VERSION = 14;
export const NORMALIZE_STAMP_KEY = 'source_ref_normalize_stamp';
export const ENTRIES_WM_KEY = 'normalize_v14_entries_wm';
export const SRI_WM_KEY = 'normalize_v14_sri_wm';
const CHUNK = 500;

interface Watermark { rowid: number; id: string }

export function stampMatches(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const s = JSON.parse(raw) as { normalize_alg?: unknown };
    return s?.normalize_alg === SOURCE_REF_NORMALIZE_ALG;
  } catch {
    return false;
  }
}

export async function writeNormalizeStamp(meta: MetadataRepository, tx: SQLiteAdapter): Promise<void> {
  await meta.setMeta(NORMALIZE_STAMP_KEY, JSON.stringify({ schema_version: NORMALIZE_STAMP_SCHEMA_VERSION, normalize_alg: SOURCE_REF_NORMALIZE_ALG }), tx);
}

/** Shared by the runner and the gate probe so both agree on what a valid watermark is. */
async function readWatermark(meta: MetadataRepository, key: string): Promise<Watermark | null> {
  const raw = await meta.getMeta(key);
  if (!raw) return null;
  try {
    const wm = JSON.parse(raw) as Partial<Watermark>;
    return typeof wm.rowid === 'number' && typeof wm.id === 'string' ? { rowid: wm.rowid, id: wm.id } : null;
  } catch {
    return null;
  }
}

async function resumeRowid(db: SQLiteAdapter, prefix: string, meta: MetadataRepository, table: string, key: string): Promise<number> {
  const wm = await readWatermark(meta, key);
  if (!wm) return 0;
  const row = await db.getFirstAsync<{ id: string }>(`SELECT id FROM ${prefix}${table} WHERE rowid = ?`, [wm.rowid]);
  return row?.id === wm.id ? wm.rowid : 0;
}

async function runPass(
  db: SQLiteAdapter, prefix: string, meta: MetadataRepository,
  table: 'entries' | 'source_ref_index', key: string, stampOnCompletion: boolean,
): Promise<void> {
  let cursor = await resumeRowid(db, prefix, meta, table, key);
  let done = false;
  while (!done) {
    await db.withTransactionAsync(async (tx) => {
      const rows = await tx.getAllAsync<{ rowid: number; id: string; source_ref: string | null }>(
        `SELECT rowid, id, source_ref FROM ${prefix}${table} WHERE rowid > ? ORDER BY rowid LIMIT ${CHUNK}`, [cursor]);
      for (const r of rows) {
        if (r.source_ref == null) continue;
        const n = normalizeSourceRef(r.source_ref);
        if (n === r.source_ref) continue;
        if (table === 'entries') {
          await tx.runAsync(`UPDATE ${prefix}entries SET source_ref = ? WHERE rowid = ?`, [n, r.rowid]);
        } else if (n === null) {
          await tx.runAsync(`UPDATE ${prefix}source_ref_index SET deleted_at = COALESCE(deleted_at, ?) WHERE rowid = ?`, [Date.now(), r.rowid]);
        } else {
          await tx.runAsync(`UPDATE ${prefix}source_ref_index SET source_ref = ? WHERE rowid = ?`, [n, r.rowid]);
        }
      }
      if (rows.length < CHUNK) {
        await meta.deleteMeta(key, tx);
        if (stampOnCompletion) await writeNormalizeStamp(meta, tx);
        done = true;
        return;
      }
      const last = rows[rows.length - 1];
      await meta.setMeta(key, JSON.stringify({ rowid: last.rowid, id: last.id }), tx);
      cursor = last.rowid;
    });
  }
}

async function watermarkRowid(meta: MetadataRepository, key: string): Promise<number> {
  return (await readWatermark(meta, key))?.rowid ?? 0;
}

/** Read-only probe for the migration gate. Never mutates. */
export async function probePendingWork(meta: MetadataRepository, prefix: string): Promise<PendingMigrationWork | null> {
  // Fresh store (nothing created yet): there is no pending work to probe.
  if (!(await meta.tableExists(`${prefix}entries`))) return null;
  // Entries without meta: an unversioned store. setupDatabase would create meta, so this is pending work.
  if (!(await meta.tableExists(`${prefix}meta`))) {
    return { type: 'schema_migration', fromVersion: 0, toVersion: CURRENT_SCHEMA_VERSION };
  }

  // Schema migrations come first: normalization only runs against a current-version schema.
  // A missing/non-numeric schema_version on an existing store means a pre-versioned (legacy) store.
  const parsedVersion = parseInt((await meta.getMeta('schema_version')) ?? '', 10);
  const version = Number.isFinite(parsedVersion) ? parsedVersion : 0;
  if (version < CURRENT_SCHEMA_VERSION) {
    return { type: 'schema_migration', fromVersion: version, toVersion: CURRENT_SCHEMA_VERSION };
  }

  if (!stampMatches(await meta.getMeta(NORMALIZE_STAMP_KEY))) {
    return {
      type: 'source_ref_normalize',
      entriesWatermark: await watermarkRowid(meta, ENTRIES_WM_KEY),
      sourceRefIndexWatermark: await watermarkRowid(meta, SRI_WM_KEY),
    };
  }

  return null;
}

export async function runSourceRefNormalize(db: SQLiteAdapter, prefix: string, meta: MetadataRepository): Promise<void> {
  if (stampMatches(await meta.getMeta(NORMALIZE_STAMP_KEY))) return;
  await runPass(db, prefix, meta, 'entries', ENTRIES_WM_KEY, false);
  await runPass(db, prefix, meta, 'source_ref_index', SRI_WM_KEY, true);
}
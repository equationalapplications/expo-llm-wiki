import type { PendingMigrationWork, SQLiteAdapter } from '../types';
import { MetadataRepository } from '../repositories/MetadataRepository';
import { parseJsonObject } from '../repositories/rowMappers';
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
  return parseJsonObject<{ normalize_alg?: unknown }>(raw)?.normalize_alg === SOURCE_REF_NORMALIZE_ALG;
}

export async function writeNormalizeStamp(meta: MetadataRepository, tx: SQLiteAdapter): Promise<void> {
  await meta.setMeta(NORMALIZE_STAMP_KEY, JSON.stringify({ schema_version: NORMALIZE_STAMP_SCHEMA_VERSION, normalize_alg: SOURCE_REF_NORMALIZE_ALG }), tx);
}

/**
 * Resume rowid for a pass: the stored watermark when it parses AND its fingerprint
 * (the id at that rowid) still matches, else 0. Shared by the runner and the gate
 * probe so a refusal never reports progress the runner would discard.
 */
async function resumeRowid(db: SQLiteAdapter, prefix: string, meta: MetadataRepository, table: string, key: string): Promise<number> {
  const wm = parseJsonObject<Partial<Watermark>>(await meta.getMeta(key));
  if (typeof wm?.rowid !== 'number' || typeof wm.id !== 'string') return 0;
  const row = await db.getFirstAsync<{ id: string }>(`SELECT id FROM ${prefix}${table} WHERE rowid = ?`, [wm.rowid]);
  return row?.id === wm.id ? wm.rowid : 0;
}

/**
 * Drops both pass watermarks. Called before an in-process VACUUM, which may
 * renumber rowids: an interrupted normalize then restarts from 0 instead of
 * trusting a rowid that could now point at a different row.
 */
export async function resetNormalizeWatermarks(meta: MetadataRepository): Promise<void> {
  await meta.deleteMeta(ENTRIES_WM_KEY);
  await meta.deleteMeta(SRI_WM_KEY);
}

/**
 * The store's schema version. A missing row means a pre-versioned store: v1 if
 * its FTS table already uses the porter tokenizer, else v0. Shared by setup()
 * and the gate probe so both report the same version.
 */
export async function detectSchemaVersion(meta: MetadataRepository, prefix: string): Promise<number> {
  const stored = await meta.getMeta('schema_version');
  if (stored) {
    const v = parseInt(stored, 10);
    return Number.isFinite(v) ? v : 0;
  }
  const ftsDdl = await meta.getTableDdl(`${prefix}entries_fts`);
  return /tokenize\s*=\s*['"]porter\s+unicode61['"]/i.test(ftsDdl ?? '') ? 1 : 0;
}

async function runPass(
  db: SQLiteAdapter, prefix: string, meta: MetadataRepository,
  table: 'entries' | 'source_ref_index', key: string, stampOnCompletion: boolean,
): Promise<void> {
  let cursor: number | null = await resumeRowid(db, prefix, meta, table, key);
  while (cursor !== null) {
    // The callback records the next cursor (null = done) in a local that is
    // applied only after the tx resolves, so in-memory progress never moves
    // past a chunk that rolled back. Not the callback's return value: host
    // adapters (e.g. expo-sqlite) may resolve withTransactionAsync to void.
    const from: number = cursor;
    let next: number | null = from;
    await db.withTransactionAsync(async (tx) => {
      const rows = await tx.getAllAsync<{ rowid: number; id: string; source_ref: string | null }>(
        `SELECT rowid, id, source_ref FROM ${prefix}${table} WHERE rowid > ? ORDER BY rowid LIMIT ${CHUNK}`, [from]);
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
        next = null;
        return;
      }
      const last = rows[rows.length - 1];
      await meta.setMeta(key, JSON.stringify({ rowid: last.rowid, id: last.id }), tx);
      next = last.rowid;
    });
    cursor = next;
  }
}

/** Read-only probe for the migration gate. Never mutates. */
export async function probePendingWork(db: SQLiteAdapter, meta: MetadataRepository, prefix: string): Promise<PendingMigrationWork | null> {
  // Fresh store (nothing created yet): there is no pending work to probe.
  if (!(await meta.tableExists(`${prefix}entries`))) return null;
  // Entries without meta: an unversioned store. setupDatabase would create meta, so this is pending work.
  if (!(await meta.tableExists(`${prefix}meta`))) {
    return { type: 'schema_migration', fromVersion: 0, toVersion: CURRENT_SCHEMA_VERSION };
  }

  // Schema migrations come first: normalization only runs against a current-version schema.
  const version = await detectSchemaVersion(meta, prefix);
  if (version < CURRENT_SCHEMA_VERSION) {
    return { type: 'schema_migration', fromVersion: version, toVersion: CURRENT_SCHEMA_VERSION };
  }

  if (!stampMatches(await meta.getMeta(NORMALIZE_STAMP_KEY))) {
    return {
      type: 'source_ref_normalize',
      entriesWatermark: await resumeRowid(db, prefix, meta, 'entries', ENTRIES_WM_KEY),
      sourceRefIndexWatermark: await resumeRowid(db, prefix, meta, 'source_ref_index', SRI_WM_KEY),
    };
  }

  return null;
}

export async function runSourceRefNormalize(db: SQLiteAdapter, prefix: string, meta: MetadataRepository): Promise<void> {
  if (stampMatches(await meta.getMeta(NORMALIZE_STAMP_KEY))) return;
  await runPass(db, prefix, meta, 'entries', ENTRIES_WM_KEY, false);
  await runPass(db, prefix, meta, 'source_ref_index', SRI_WM_KEY, true);
}
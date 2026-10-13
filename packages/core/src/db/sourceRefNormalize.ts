import type { SQLiteAdapter } from '../types';
import { MetadataRepository } from '../repositories/MetadataRepository';
import { normalizeSourceRef } from '../utils/pure';
import { CURRENT_SCHEMA_VERSION } from './migrations';

export const SOURCE_REF_NORMALIZE_ALG = 1;
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
  await meta.setMeta(NORMALIZE_STAMP_KEY, JSON.stringify({ schema_version: 14, normalize_alg: SOURCE_REF_NORMALIZE_ALG }), tx);
}

async function resumeRowid(db: SQLiteAdapter, prefix: string, meta: MetadataRepository, table: string, key: string): Promise<number> {
  const raw = await meta.getMeta(key);
  if (!raw) return 0;
  let wm: Partial<Watermark>;
  try { wm = JSON.parse(raw) as Partial<Watermark>; } catch { return 0; }
  if (typeof wm.rowid !== 'number' || typeof wm.id !== 'string') return 0;
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

export async function probePendingWork(meta: MetadataRepository, prefix: string): Promise<{ type: 'source_ref_normalize'; watermark?: number } | { type: 'full_v14' } | null> {
  // Fresh store (nothing created yet): there is no pending work to probe.
  if (!(await meta.tableExists(`${prefix}entries`)) || !(await meta.tableExists(`${prefix}meta`))) {
    return null;
  }

  // Schema migrations come first: normalization only runs against a current-version schema.
  // A missing/non-numeric schema_version on an existing store means a pre-versioned (legacy) store.
  const schemaVersionValue = await meta.getMeta('schema_version');
  const parsedVersion = schemaVersionValue ? parseInt(schemaVersionValue, 10) : 0;
  const version = Number.isFinite(parsedVersion) ? parsedVersion : 0;
  if (version < CURRENT_SCHEMA_VERSION) {
    return { type: 'full_v14' };
  }

  if (!stampMatches(await meta.getMeta(NORMALIZE_STAMP_KEY))) {
    const entriesWm = await meta.getMeta(ENTRIES_WM_KEY);
    if (entriesWm) {
      try {
        const parsed = JSON.parse(entriesWm) as { rowid: number };
        return { type: 'source_ref_normalize', watermark: parsed.rowid };
      } catch {
        // Invalid JSON, resume from beginning
      }
    }
    return { type: 'source_ref_normalize', watermark: 0 };
  }

  return null;
}

export async function runNormalizedBatchWrite(db: SQLiteAdapter, opts: {
  prefix: string
  batchSize: number
  watermark?: number
}): Promise<{ written: number; watermark: number }> {
  const meta = new MetadataRepository(db, opts.prefix);
  let written = 0;
  let cursor = opts.watermark || 0;

  for (;;) {
    const rows = await db.getAllAsync<{ rowid: number; id: string; source_ref: string | null }>(
      `SELECT rowid, id, source_ref FROM ${opts.prefix}entries WHERE rowid > ? ORDER BY rowid LIMIT ${opts.batchSize}`, [cursor]);

    if (rows.length === 0) break;

    for (const r of rows) {
      if (r.source_ref == null) continue;
      const n = normalizeSourceRef(r.source_ref);
      if (n === r.source_ref) continue;
      await db.runAsync(`UPDATE ${opts.prefix}entries SET source_ref = ? WHERE rowid = ?`, [n, r.rowid]);
      written++;
    }

    const last = rows[rows.length - 1];
    cursor = last.rowid;

    if (rows.length < opts.batchSize) break;
  }

  return { written, watermark: cursor };
}

export async function runSourceRefNormalize(db: SQLiteAdapter, prefix: string, meta: MetadataRepository): Promise<void> {
  if (stampMatches(await meta.getMeta(NORMALIZE_STAMP_KEY))) return;
  await runPass(db, prefix, meta, 'entries', ENTRIES_WM_KEY, false);
  await runPass(db, prefix, meta, 'source_ref_index', SRI_WM_KEY, true);
}
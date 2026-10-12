import type { SQLiteAdapter } from '../types';
import type { MetadataRepository } from '../repositories/MetadataRepository';
import { normalizeSourceRef } from '../utils/pure';

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
  for (;;) {
    const done = await db.withTransactionAsync(async (tx) => {
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
        return true;
      }
      const last = rows[rows.length - 1];
      await meta.setMeta(key, JSON.stringify({ rowid: last.rowid, id: last.id }), tx);
      cursor = last.rowid;
      return false;
    });
    if (done) return;
  }
}

export async function runSourceRefNormalize(db: SQLiteAdapter, prefix: string, meta: MetadataRepository): Promise<void> {
  if (stampMatches(await meta.getMeta(NORMALIZE_STAMP_KEY))) return;
  await runPass(db, prefix, meta, 'entries', ENTRIES_WM_KEY, false);
  await runPass(db, prefix, meta, 'source_ref_index', SRI_WM_KEY, true);
}
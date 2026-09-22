import { expect } from 'vitest';
import type { SQLiteAdapter } from '../../src/types';
export { makeDiagnosticWiki, ofCode, expectNoContent, HASH_A, HASH_B } from './diagnosticsHarness';

export interface FactRow {
  id: string;
  title: string;
  source_type: string;
  source_hash: string | null;
  lifecycle_status: string;
  okf_verified: Array<{ by: string; at: string }> | null;
  last_verified_by: string | null;
  last_verified_at: number | null;
}

/** Live facts for an entity with their trust columns, ordered by title. */
export async function factRows(db: SQLiteAdapter, entityId = 'e1'): Promise<FactRow[]> {
  const rows = await db.getAllAsync<Omit<FactRow, 'okf_verified'> & { okf_verified: string | null }>(
    `SELECT id, title, source_type, source_hash, lifecycle_status, okf_verified, last_verified_by, last_verified_at
       FROM llm_wiki_entries WHERE entity_id = ? AND deleted_at IS NULL ORDER BY title`,
    [entityId],
  );
  return rows.map((r) => ({ ...r, okf_verified: r.okf_verified ? JSON.parse(r.okf_verified) : null }));
}

export const GROUNDED = [{ by: 'process:grounding-check', at: expect.any(String) }];

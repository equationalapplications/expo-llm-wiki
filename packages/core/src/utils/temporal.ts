/**
 * Single definition of fact liveness (spec 2026-09-29 §4.2). Every read path
 * uses these so SQL and JS can never disagree.
 *
 * - 'asOf' — valid time using current knowledge: live at T when
 *   COALESCE(valid_from, created_at) <= T < valid_to (valid_to NULL = open).
 * - 'current' — live now per the row's own validity columns. A row with both
 *   columns NULL is always current; created_at is deliberately ignored so
 *   existing rows (and fixtures with arbitrary created_at) stay current.
 */
export type LiveMode = 'current' | 'asOf';

/** Boolean SQL fragment. Consumes exactly two `?` placeholders, both bound to T. */
export function liveAtSql(mode: LiveMode, alias = ''): string {
  const from = mode === 'asOf'
    ? `COALESCE(${alias}valid_from, ${alias}created_at) <= ?`
    : `(${alias}valid_from IS NULL OR ${alias}valid_from <= ?)`;
  return `(${from} AND (${alias}valid_to IS NULL OR ${alias}valid_to > ?))`;
}

export function isLiveAt(
  f: { created_at: number; deleted_at: number | null; valid_from?: number | null; valid_to?: number | null },
  mode: LiveMode,
  t: number,
): boolean {
  if (f.deleted_at != null) return false;
  const from = mode === 'asOf' ? (f.valid_from ?? f.created_at) : f.valid_from;
  if (from != null && from > t) return false;
  return f.valid_to == null || f.valid_to > t;
}

export function assertEpochMs(name: string, v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    throw new TypeError(`${name} must be a finite epoch-ms number >= 0`);
  }
  return Math.trunc(v);
}
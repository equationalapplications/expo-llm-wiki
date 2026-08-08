/**
 * SQLite primary result codes → symbolic name (https://sqlite.org/rescode.html),
 * so a numeric expo-sqlite code normalizes to the same shape as the string codes
 * better-sqlite3 / node:sqlite already report (e.g. both become 'SQLITE_BUSY').
 *
 * Dependency-free leaf module: shared by `db/serializedAdapter.ts` and `types.ts`
 * (via `WikiTransactionError`) so the mapping has a single source of truth.
 */
const SQLITE_RESULT_CODE_NAMES: Record<number, string> = {
  1: 'SQLITE_ERROR', 2: 'SQLITE_INTERNAL', 3: 'SQLITE_PERM', 4: 'SQLITE_ABORT',
  5: 'SQLITE_BUSY', 6: 'SQLITE_LOCKED', 7: 'SQLITE_NOMEM', 8: 'SQLITE_READONLY',
  9: 'SQLITE_INTERRUPT', 10: 'SQLITE_IOERR', 11: 'SQLITE_CORRUPT', 12: 'SQLITE_NOTFOUND',
  13: 'SQLITE_FULL', 14: 'SQLITE_CANTOPEN', 15: 'SQLITE_PROTOCOL', 16: 'SQLITE_EMPTY',
  17: 'SQLITE_SCHEMA', 18: 'SQLITE_TOOBIG', 19: 'SQLITE_CONSTRAINT', 20: 'SQLITE_MISMATCH',
  21: 'SQLITE_MISUSE', 22: 'SQLITE_NOLFS', 23: 'SQLITE_AUTH', 24: 'SQLITE_FORMAT',
  25: 'SQLITE_RANGE', 26: 'SQLITE_NOTADB', 27: 'SQLITE_NOTICE', 28: 'SQLITE_WARNING',
  // Extended result codes (https://sqlite.org/rescode.html#extended_result_code_list).
  // 2067 = SQLITE_CONSTRAINT_UNIQUE — raised when a UNIQUE index/PRIMARY KEY
  // rejects an INSERT/UPDATE; expo-sqlite reports this as a numeric "Error code N:"
  // prefix and we normalize it back to the symbolic name so callers can branch on
  // the same string the rest of the ecosystem uses.
  2067: 'SQLITE_CONSTRAINT_UNIQUE',
  100: 'SQLITE_ROW', 101: 'SQLITE_DONE',
};

/** Falls back to `SQLITE_<n>` for a result code outside the known table. */
export function nameForSqliteResultCode(n: number): string {
  return SQLITE_RESULT_CODE_NAMES[n] ?? `SQLITE_${n}`;
}

/**
 * Best-effort SQLite code extraction. Driver-specific:
 *   better-sqlite3 / node:sqlite: err.code === 'SQLITE_BUSY' (string, SQLITE_-prefixed)
 *   expo-sqlite:                  err.message starts with 'Error code N: …' (numeric,
 *                                  normalized here to the same symbolic name)
 */
export function extractSqliteCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const { code, message } = err as { code?: unknown; message?: unknown };
  if (typeof code === 'string' && code.startsWith('SQLITE_')) return code;
  if (typeof message === 'string') {
    const m = /^Error code (\d+):/.exec(message);
    if (m) return nameForSqliteResultCode(Number(m[1]));
  }
  return undefined;
}

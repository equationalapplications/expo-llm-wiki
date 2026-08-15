/**
 * Shared JSON column parsers for repository row mappers.
 *
 * SQLite JSON1 columns return a string when read; in-memory callers expect the
 * parsed value. The parsers tolerate both shapes so callers stay
 * implementation-agnostic (e.g. tests pass arrays directly, drivers return
 * strings). Hoisted to module scope so each row mapping doesn't reallocate
 * two closures (was the case before refactor — see #90 review).
 */

export function parseJsonArray<T>(s: unknown, fallback: T[]): T[] {
  if (Array.isArray(s)) return s as T[];
  if (typeof s === 'string' && s.length > 0) {
    try {
      const p = JSON.parse(s);
      if (Array.isArray(p)) return p as T[];
    } catch {
      // fall through to fallback
    }
  }
  return fallback;
}

/**
 * Arrays are rejected in both branches: `typeof [] === 'object'`, so a
 * malformed `okf_usage_window` of `[]` would otherwise be handed back as an
 * object and re-exported with an invalid shape (see #90 review).
 */
export function parseJsonObject<T>(s: unknown, fallback: T | null = null): T | null {
  if (s && typeof s === 'object' && !Array.isArray(s)) return s as T;
  if (typeof s === 'string' && s.length > 0) {
    try {
      const p = JSON.parse(s);
      if (p && typeof p === 'object' && !Array.isArray(p)) return p as T;
    } catch {
      // fall through to fallback
    }
  }
  return fallback;
}

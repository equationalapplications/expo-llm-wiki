// packages/core/src/services/search/ftsQuery.ts

const TOKEN = /[\p{L}\p{N}]+/gu;

/**
 * Turn a free-text query into an FTS5 MATCH expression that can never be a
 * syntax error: every token is a double-quoted string (FTS5 has no escapes
 * inside quotes except `""`, and tokens contain no quotes), followed by `*`
 * for prefix matching. Tokens are ORed, which matches MiniSearch's
 * `prefix: true` and its `combineWith: 'OR'`. Returns `null` when no token
 * survives, and the caller returns no results.
 */
export function buildFtsMatchQuery(query: string): string | null {
  const seen = new Set<string>();
  for (const m of query.toLowerCase().matchAll(TOKEN)) seen.add(m[0]);
  if (seen.size === 0) return null;
  return [...seen].map((t) => `"${t}"*`).join(' OR ');
}

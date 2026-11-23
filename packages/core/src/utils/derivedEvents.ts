// packages/core/src/utils/derivedEvents.ts
//
// `entries.derived_events` helpers (specs/inplace-update-provenance §1, §5).
// A contribution ledger: JSON array of event id strings, deduplicated,
// insertion order. Not a second pointer; `source_pointer` keeps its meaning.

/**
 * Exact validator for an imported / OKF-parsed value: an array of non-empty
 * strings. Returns the deduplicated list, `null` for an empty array or null,
 * and `undefined` when malformed.
 */
export function validateDerivedEventsValue(v: unknown): string[] | null | undefined {
  if (v === null) return null;
  if (!Array.isArray(v)) return undefined;
  for (const x of v) {
    if (typeof x !== 'string' || x.length === 0) return undefined;
  }
  const out = dedupeEventIds(v as string[]);
  return out.length === 0 ? null : out;
}

/**
 * Tolerant stored-value read for the row mappers: a stored value that is not an array
 * reads as null without throwing; non-string elements of an array are dropped.
 */
export function parseStoredDerivedEvents(raw: unknown): string[] | null {
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  // Tolerant: keep the valid string elements of a partly valid list so a
  // later merge extends it rather than overwriting (and losing) them.
  if (!Array.isArray(parsed)) return null;
  const kept = dedupeEventIds(parsed.filter((x): x is string => typeof x === 'string'));
  return kept.length === 0 ? null : kept;
}

/** Serialize for storage; null/undefined/empty -> null. */
export function serializeDerivedEvents(list: readonly string[] | null | undefined): string | null {
  if (!list || list.length === 0) return null;
  return JSON.stringify(list);
}

/** Order-preserving dedupe that also drops null/undefined/empty ids. */
export function dedupeEventIds(ids: ReadonlyArray<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

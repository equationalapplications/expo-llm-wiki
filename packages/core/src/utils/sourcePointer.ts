// packages/core/src/utils/sourcePointer.ts
//
// Source-pointer validation and parsing (specs/source-pointers).
// Shared by the row mappers (tolerant read), the import predicate
// (exact, §Export, import, and OKF), and parseOkfBundle (tolerant-null
// with a dropped-values report).

import type { WikiSourcePointer } from '../types';

const POINTER_SLOTS = ['event_id', 'ref', 'quote', 'position'] as const;

function isStringOrNull(v: unknown): boolean {
  return v === null || typeof v === 'string';
}

/** Spec §Export, import, and OKF predicate: `position` is null or `{ start: integer ≥ 0, length: integer ≥ 0 }`. */
function isValidPosition(v: unknown): boolean {
  if (v === null) return true;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== 2 || !('start' in o) || !('length' in o)) return false;
  const { start, length } = o;
  return (
    typeof start === 'number' && Number.isInteger(start) && start >= 0 &&
    typeof length === 'number' && Number.isInteger(length) && length >= 0
  );
}

/**
 * The exact import predicate (spec §Export, import, and OKF): `null` is a
 * valid null pointer; an object whose keys are a subset of the four slots
 * with the right slot types is a valid pointer; anything else — extra keys,
 * wrong types, a negative position — is malformed. An object with no
 * non-null slots (including `{}`) is VALID: OKF emission omits null slots,
 * so an all-null pointer round-trips to an empty map, and that is not an
 * error. Returns the pointer (null for an all-null map), or `undefined`
 * when the value is malformed.
 */
export function validateSourcePointerValue(
  v: unknown,
): WikiSourcePointer | null | undefined {
  if (v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  for (const k of keys) {
    if (!(POINTER_SLOTS as readonly string[]).includes(k)) return undefined;
  }
  if (!isStringOrNull(o['event_id'] === undefined ? null : o['event_id']) ||
      !isStringOrNull(o['ref'] === undefined ? null : o['ref']) ||
      !isStringOrNull(o['quote'] === undefined ? null : o['quote'])) {
    return undefined;
  }
  if (!isValidPosition(o['position'] === undefined ? null : o['position'])) return undefined;
  return {
    event_id: (o['event_id'] as string | null) ?? null,
    ref: (o['ref'] as string | null) ?? null,
    quote: (o['quote'] as string | null) ?? null,
    position: (o['position'] as WikiSourcePointer['position']) ?? null,
  };
}

/**
 * Tolerant stored-value read for the row mappers (spec test 1): a malformed
 * stored `source_pointer` reads as null without throwing. Valid values parse
 * exactly; anything unreadable returns null.
 */
export function parseStoredSourcePointer(raw: unknown): WikiSourcePointer | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const v = validateSourcePointerValue(parsed);
  return v === undefined ? null : v;
}

/** Serialize a pointer for storage; null/undefined → null. */
export function serializeSourcePointer(p: WikiSourcePointer | null | undefined): string | null {
  return p ? JSON.stringify(p) : null;
}

import type { WikiEvent } from '../types';
import type { LibrarianWatermark } from '../repositories/MetadataRepository';

export type StampReason = 'future' | 'behind_watermark' | 'invalid';

export interface PlannedStamp {
  createdAt: number;
  occurredAt: number | null;
  reason: StampReason | null;
}

const DATE_MAX = 8.64e15;

/** Decimal numeric text, which SQLite's INTEGER affinity converts to a number. Hex, binary and octal stay TEXT there. */
const DECIMAL_TEXT = /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?\s*$/;

/** A bundle created_at as SQLite's INTEGER column would read it: numbers as-is, decimal strings parsed, anything else NaN. */
export function createdAtValue(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && DECIMAL_TEXT.test(v)) return Number(v);
  return NaN;
}

/** True when `v` is finite and inside the JS Date range. */
export function isUsableDate(v: number): boolean {
  return Number.isFinite(v) && v >= -DATE_MAX && v <= DATE_MAX;
}

/** A source watermark from a bundle: `at` a finite number and `id` a string, else null. */
export function parseSourceWatermark(raw: unknown): LibrarianWatermark | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const { at, id } = raw as { at?: unknown; id?: unknown };
  if (typeof at !== 'number' || !Number.isFinite(at) || typeof id !== 'string') return null;
  return { at, id };
}

const cmp = (a: number | string, b: number | string): number => (a === b ? 0 : a < b ? -1 : 1);

/**
 * Plans created_at / occurred_at for every bundle event (spec
 * import-past-dated-events §7, §8.1). Events dated after `now`, behind the
 * local librarian watermark (merge only, and not behind the source's own
 * watermark), or with an unusable created_at are re-stamped `floor + 1 + i`
 * in (key, id) order, so they sort after everything already read and keep
 * their relative order. Others keep their own created_at.
 */
export function planEventStamps(
  events: readonly WikiEvent[],
  ctx: { now: number; floor: number; merge: boolean; localWm: LibrarianWatermark | null; sourceWm: LibrarianWatermark | null },
): Map<WikiEvent, PlannedStamp> {
  const { now, floor, merge, localWm, sourceWm } = ctx;
  const after = (v: number, id: string, wm: LibrarianWatermark) => v > wm.at || (v === wm.at && id > wm.id);
  const plan = new Map<WikiEvent, PlannedStamp>();
  const restamp: { e: WikiEvent; key: number; stamp: PlannedStamp }[] = [];

  for (const e of events) {
    const v = createdAtValue(e.created_at);
    const o = createdAtValue(e.occurred_at);
    let occurredAt: number | null = null;
    let occurredInvalid = false;
    if (e.occurred_at != null) {
      if (isUsableDate(o)) occurredAt = Math.trunc(o);
      else occurredInvalid = true;
    }

    let reason: StampReason | null = null;
    const invalidCreated = Number.isNaN(v) || v < -DATE_MAX;
    if (invalidCreated) reason = 'invalid';
    else if (v > now) reason = 'future';
    else if (
      merge &&
      localWm !== null &&
      Number.isFinite(localWm.at) &&
      !after(v, e.id, localWm) &&
      (sourceWm === null || after(v, e.id, sourceWm))
    ) {
      reason = 'behind_watermark';
    }

    if (reason === 'behind_watermark' && occurredAt === null && Number.isFinite(v) && v >= 0) {
      occurredAt = Math.trunc(v);
    }

    const stamp: PlannedStamp = { createdAt: v, occurredAt, reason };
    if (reason === null && occurredInvalid) stamp.reason = 'invalid';
    plan.set(e, stamp);
    if (reason !== null) restamp.push({ e, key: invalidCreated ? -Infinity : v, stamp });
  }

  restamp.sort((x, y) => cmp(x.key, y.key) || cmp(x.e.id, y.e.id));
  // Past 2^53 - 1, floor + 1 + i rounds and the stamps tie with each other
  // and the watermark. Only an absurd stored date gets here; fail loudly,
  // as write() does, rather than store events that sort behind it.
  if (restamp.length > 0 && floor + restamp.length > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`importDump: cannot re-date ${restamp.length} future-dated event(s): the floor (${floor}) is too close to Number.MAX_SAFE_INTEGER to keep them ordered.`);
  }
  restamp.forEach((x, i) => {
    x.stamp.createdAt = floor + 1 + i;
  });
  return plan;
}

import type { RememberInput, WikiFact } from '../types';
import { assertEntityId } from './entityId';
import { generateId } from './ids';
import { assertEpochMs } from './temporal';

const CONFIDENCE_VALUES: ReadonlySet<string> = new Set(['certain', 'inferred', 'tentative']);
const SOURCE_TYPE_VALUES: ReadonlySet<string> = new Set(['user_stated', 'user_confirmed']);

export interface NormalizedRememberInput {
  /** The row to upsert. `okf_type` is null here; RememberService resolves `okfType` against the manifest. */
  fact: WikiFact;
  /** Truncated epoch ms, or undefined when the caller gave none. */
  validFrom?: number;
  /** The caller's raw type slug, or null. */
  okfType: string | null;
}

/**
 * Every validation rule of remember() (spec §3.2), with no I/O. Throws
 * TypeError; never clips or coerces. `now` is injected so tests are stable.
 */
export function normalizeRememberInput(entityId: string, input: RememberInput, now: number): NormalizedRememberInput {
  assertEntityId(entityId);
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('remember(): input must be a non-null object.');
  }
  if (typeof input.title !== 'string' || input.title.trim() === '') {
    throw new TypeError('remember(): input.title must be a non-empty string.');
  }
  if (typeof input.body !== 'string') {
    throw new TypeError('remember(): input.body must be a string.');
  }
  let tags: string[] = [];
  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags)) {
      throw new TypeError('remember(): input.tags must be an array of strings.');
    }
    // Index-based loop on purpose: Array.prototype.every skips holes, so a
    // sparse array (e.g. new Array(2)) would otherwise pass validation.
    for (let i = 0; i < input.tags.length; i++) {
      if (typeof input.tags[i] !== 'string') {
        throw new TypeError('remember(): input.tags must be an array of strings.');
      }
    }
    tags = [...(input.tags as string[])];
  }
  // null is a supplied value, not absence (spec §3.2: nothing coerced silently);
  // it fails the Set check below with the same message as any other bad value.
  const confidence = input.confidence === undefined ? 'certain' : input.confidence;
  if (!CONFIDENCE_VALUES.has(confidence)) {
    throw new TypeError(`remember(): input.confidence must be certain | inferred | tentative; got ${JSON.stringify(input.confidence)}.`);
  }
  const sourceType = input.source_type === undefined ? 'user_stated' : input.source_type;
  if (!SOURCE_TYPE_VALUES.has(sourceType)) {
    throw new TypeError(`remember(): input.source_type must be user_stated | user_confirmed; got ${JSON.stringify(input.source_type)}.`);
  }
  let okfType: string | null = null;
  if (input.okf_type !== undefined && input.okf_type !== null) {
    if (typeof input.okf_type !== 'string' || input.okf_type.trim() === '') {
      throw new TypeError('remember(): input.okf_type must be a non-empty string or null.');
    }
    okfType = input.okf_type;
  }
  const validFrom = input.valid_from === undefined ? undefined : assertEpochMs('input.valid_from', input.valid_from);

  const fact: WikiFact = {
    id: generateId('fact_'),
    entity_id: entityId,
    title: input.title,
    body: input.body,
    tags,
    confidence,
    source_type: sourceType,
    source_hash: null,
    source_ref: null,
    created_at: now,
    updated_at: now,
    last_accessed_at: null,
    access_count: 0,
    deleted_at: null,
    okf_type: null,
  };
  return { fact, validFrom, okfType };
}

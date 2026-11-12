import { sha256WithPrefix, utf8Encode } from './sha256';

export interface DeriveEventIdInput {
  /** The entity the log is imported into (not a directory name in the bundle). */
  entityId: string;
  /** The log heading's date text, `YYYY-MM-DD`, as written. */
  date: string;
  /** The event type the event is stored with. */
  eventType: string;
  /** The summary the event is stored with (after unescaping). */
  summary: string;
  /** How many earlier id-less lines in the same log share date, type and summary; 0 for the first. */
  occurrence: number;
}

const TAG = 'llm-wiki/event-id/1';
const PREFIX = 'evt_okf1_';

function encodeFields(fields: readonly string[]): Uint8Array {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const field of fields) {
    const bytes = utf8Encode(field);
    const part = utf8Encode(`${bytes.length}:`);
    const chunk = new Uint8Array(part.length + bytes.length + 1);
    chunk.set(part);
    chunk.set(bytes, part.length);
    chunk[chunk.length - 1] = 0x2c; // ','
    parts.push(chunk);
    total += chunk.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

const prefixFields = (input: Omit<DeriveEventIdInput, 'occurrence'>) =>
  [TAG, input.entityId, input.date, input.eventType, input.summary];

/** Length-prefixed field encoding hashed by {@link deriveEventId}. Internal; exported for tests. */
export function encodeEventIdInput(input: DeriveEventIdInput): Uint8Array {
  return encodeFields([...prefixFields(input), String(input.occurrence)]);
}

/**
 * {@link deriveEventId} for one (entity, date, type, summary) at many
 * occurrences: the shared fields are encoded and hashed once, so each call
 * costs the same however long the summary is. Returns the same ids as
 * `deriveEventId({ ...input, occurrence })`.
 */
export function createEventIdDeriver(input: Omit<DeriveEventIdInput, 'occurrence'>): (occurrence: number) => string {
  const finish = sha256WithPrefix(encodeFields(prefixFields(input)));
  return (occurrence) => {
    if (!Number.isInteger(occurrence) || occurrence < 0) {
      throw new TypeError(`deriveEventId: occurrence must be an integer >= 0, got ${String(occurrence)}`);
    }
    const digest = finish(encodeFields([String(occurrence)]));
    let hex = '';
    for (let i = 0; i < 16; i++) hex += digest[i].toString(16).padStart(2, '0');
    return PREFIX + hex;
  };
}

/**
 * Deterministic id for an OKF log line that carries no id comment
 * (`docs/okf-profile.md` §7): `evt_okf1_` + the first 32 hex characters of
 * SHA-256 over the length-prefixed fields. The same line in the same entity
 * always gets the same id, so importing it again is a no-op while the earlier
 * copy is stored.
 */
export function deriveEventId(input: DeriveEventIdInput): string {
  return createEventIdDeriver(input)(input.occurrence);
}

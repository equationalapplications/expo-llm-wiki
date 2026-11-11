import { sha256, utf8Encode } from './sha256';

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

/** Length-prefixed field encoding hashed by {@link deriveEventId}. Internal; exported for tests. */
export function encodeEventIdInput(input: DeriveEventIdInput): Uint8Array {
  const fields = [TAG, input.entityId, input.date, input.eventType, input.summary, String(input.occurrence)];
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

/**
 * Deterministic id for an OKF log line that carries no id comment
 * (`docs/okf-profile.md` §7): `evt_okf1_` + the first 32 hex characters of
 * SHA-256 over the length-prefixed fields. The same line in the same entity
 * always gets the same id, so importing it again is a no-op while the earlier
 * copy is stored.
 */
export function deriveEventId(input: DeriveEventIdInput): string {
  if (!Number.isInteger(input.occurrence) || input.occurrence < 0) {
    throw new TypeError(`deriveEventId: occurrence must be an integer >= 0, got ${String(input.occurrence)}`);
  }
  const digest = sha256(encodeEventIdInput(input));
  let hex = '';
  for (let i = 0; i < 16; i++) hex += digest[i].toString(16).padStart(2, '0');
  return PREFIX + hex;
}

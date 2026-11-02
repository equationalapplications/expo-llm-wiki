/**
 * The entity id rule shared by write() and remember(): a non-empty string,
 * at most 200 chars, no null bytes. Message is byte-for-byte what write()
 * threw before the helper existed (hosts match on it).
 */
export function assertEntityId(entityId: unknown): asserts entityId is string {
  if (typeof entityId !== 'string' || entityId.length === 0 || entityId.length > 200 || entityId.includes('\0')) {
    throw new TypeError(
      `Invalid entityId: must be a non-empty string at most 200 chars with no null bytes; got ${JSON.stringify(entityId)}.`,
    );
  }
}

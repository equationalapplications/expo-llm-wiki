/**
 * Generate a random ID with an optional prefix.
 * Uses crypto.randomUUID() when available, falling back to crypto.getRandomValues().
 * Throws if neither is available — record IDs must always be cryptographically random.
 */
export function generateId(prefix: string = ''): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    // Use crypto.randomUUID for high entropy (128 bits)
    return prefix + crypto.randomUUID().replace(/-/g, '').substring(0, 24);
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return prefix + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('').substring(0, 24);
  }
  throw new Error(
    'generateId: no cryptographically secure random source available ' +
      '(crypto.randomUUID and crypto.getRandomValues are both missing).',
  );
}

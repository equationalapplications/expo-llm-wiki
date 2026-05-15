/**
 * Generate a random ID with an optional prefix.
 * Uses crypto.randomUUID() when available, falling back to Math.random() for compatibility.
 * Provides cryptographically secure random values when available.
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
  // Fallback to Math.random (lower entropy, ~92 bits combined)
  return prefix + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

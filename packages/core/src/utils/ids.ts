/**
 * Generate a random ID with an optional prefix.
 * Uses crypto.randomUUID() when available, falling back to Math.random() for compatibility.
 * Provides cryptographically secure random values when available.
 */
export function generateId(prefix: string = ''): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    // Use crypto.randomUUID for high entropy (128 bits)
    return prefix + crypto.randomUUID().replace(/-/g, '').substring(0, 24);
  }
  // Fallback to Math.random (lower entropy, ~92 bits combined)
  return prefix + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

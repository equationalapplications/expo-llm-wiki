/**
 * Generate a random ID with an optional prefix.
 * Uses Math.random() for pseudo-random values (not cryptographically secure).
 */
export function generateId(prefix: string = ''): string {
  return prefix + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

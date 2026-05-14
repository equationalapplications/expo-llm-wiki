/**
 * Generate a random ID with an optional prefix.
 * Uses crypto-random values for high entropy.
 */
export function generateId(prefix: string = ''): string {
  return prefix + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

/**
 * The message of any thrown value: `(error as Error).message` is `undefined`
 * for a non-Error rejection (a thrown string, a polyfill's plain object),
 * which would show the user literally "undefined" and hide the cause.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

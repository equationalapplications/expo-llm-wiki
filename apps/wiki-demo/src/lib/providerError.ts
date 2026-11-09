/**
 * Build the error for a failed provider call (audit 2026-08-24, L-3). The
 * message carries only the HTTP status: provider bodies can contain account
 * or project identifiers, and thrown messages reach the UI. Set
 * VITE_DEBUG_LLM_RAW_ERRORS=true to log a truncated body for local debugging.
 */
export async function providerRequestError(response: Response): Promise<Error> {
  if (import.meta.env?.VITE_DEBUG_LLM_RAW_ERRORS === 'true') {
    const body = await response.text()
    console.error(`Provider error body: ${body.slice(0, 500)}`)
  }
  return new Error(`Provider request failed: HTTP ${response.status}`)
}

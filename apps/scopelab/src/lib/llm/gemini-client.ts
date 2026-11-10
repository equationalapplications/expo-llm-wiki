/**
 * The one Gemini HTTP client for ScopeLab: the rolling model alias, the
 * authenticated call, and the text-part join. The chat path
 * (function-caller.ts) and the memory maintenance provider
 * (gemini-provider.ts) both go through here, so an alias repin or an auth
 * change lands in one file.
 */

// `gemini-flash-latest` is Google's rolling alias. The previous pin,
// gemini-2.0-flash, was retired and 404'd on every generate call while
// its models/ metadata still answered 200 (live smoke, 2026-11-10).
export const GEMINI_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent'

/** How long a chat call may run before its fetch is aborted. */
export const CHAT_TIMEOUT_MS = 60_000

/** The response shape ScopeLab reads from generateContent. */
export interface GeminiGenerateResponse {
  candidates?: Array<{
    content?: {
      role?: string
      parts?: Array<{
        text?: string
        thought?: boolean
        functionCall?: { id?: string; name: string; args?: Record<string, unknown> }
      }>
    }
    finishReason?: string
  }>
  promptFeedback?: { blockReason?: string }
}

/** Concatenate the visible text parts of a Gemini candidate, skipping thoughts. */
export function joinText(parts: Array<{ text?: string; thought?: boolean }> | undefined): string {
  return (parts ?? []).filter(p => typeof p.text === 'string' && !p.thought).map(p => p.text).join('')
}

/**
 * One generateContent POST. Auth goes in a lower-case header (never the
 * URL) so web/Expo fetch polyfills normalize it consistently and the key
 * can't leak into URL logs. Every call is bounded by an AbortSignal: a
 * stalled fetch must never wedge the caller — the maintenance path would
 * otherwise hold the consolidate chain and the librarian lock forever.
 * Errors stay status-only: provider bodies can carry account identifiers,
 * so the raw body is only logged behind VITE_DEBUG_LLM_RAW_ERRORS.
 */
export async function callGemini(
  apiKey: string,
  body: unknown,
  label = 'API',
  timeoutMs = CHAT_TIMEOUT_MS,
): Promise<GeminiGenerateResponse> {
  const response = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    if (import.meta.env.VITE_DEBUG_LLM_RAW_ERRORS === 'true') {
      const errorText = await response.text()
      console.error(`Gemini ${label} error body: ${errorText.slice(0, 500)}`)
    }
    throw new Error(`Gemini ${label} error: HTTP ${response.status}`)
  }
  return (await response.json()) as GeminiGenerateResponse
}

import type { LLMProvider } from '@equationalapplications/core-llm-wiki'

// Same rolling alias as the chat path (function-caller.ts).
const GEMINI_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent'

/**
 * The memory engine's maintenance model, backed by the developer's own Gemini
 * key. `getApiKey` is read on every call, not once at launch: the key field
 * can be filled in after Initialize, and edited later.
 */
export function geminiGenerateText(getApiKey: () => string): LLMProvider['generateText'] {
  return async ({ systemPrompt, userPrompt }) => {
    const apiKey = getApiKey().trim()
    if (!apiKey) throw new Error('ScopeLab memory needs a Gemini API key to save facts.')
    const response = await fetch(GEMINI_URL, {
      method: 'POST',
      // Key in a header, never the URL (see function-caller.ts).
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        // The librarian parses JSON; asking for it avoids prose and fences.
        generationConfig: { responseMimeType: 'application/json' },
      }),
    })
    // Status only: provider bodies can carry account identifiers.
    if (!response.ok) throw new Error(`Gemini maintenance error: HTTP ${response.status}`)
    const data = await response.json()
    const parts: Array<{ text?: string; thought?: boolean }> = data.candidates?.[0]?.content?.parts ?? []
    const text = parts.filter(p => typeof p.text === 'string' && !p.thought).map(p => p.text).join('')
    if (!text) throw new Error('Gemini maintenance call returned no text.')
    return text
  }
}

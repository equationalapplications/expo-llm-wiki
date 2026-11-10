import type { LLMProvider } from '@equationalapplications/core-llm-wiki'
import { callGemini, joinText } from './gemini-client'

// The librarian's prompts are small: a hung call is dead weight, so the
// maintenance timeout is tighter than the chat path's.
const MAINTENANCE_TIMEOUT_MS = 30_000

/**
 * The memory engine's maintenance model, backed by the developer's own Gemini
 * key. `getApiKey` is read on every call, not once at launch: the key field
 * can be filled in after Initialize, and edited later.
 */
export function geminiGenerateText(getApiKey: () => string): LLMProvider['generateText'] {
  return async ({ systemPrompt, userPrompt }) => {
    const apiKey = getApiKey().trim()
    if (!apiKey) throw new Error('ScopeLab memory needs a Gemini API key to save facts.')
    const data = await callGemini(
      apiKey,
      {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        // The librarian parses JSON; asking for it avoids prose and fences.
        generationConfig: { responseMimeType: 'application/json' },
      },
      'maintenance',
      MAINTENANCE_TIMEOUT_MS,
    )
    const text = joinText(data.candidates?.[0]?.content?.parts)
    if (!text) throw new Error('Gemini maintenance call returned no text.')
    return text
  }
}

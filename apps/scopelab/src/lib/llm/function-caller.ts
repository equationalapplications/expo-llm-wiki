import { buildAuthorizedToolsArray, isAuthorizedScope } from '@equationalapplications/core-llm-tools'
import type { AgentToolManifest } from '@equationalapplications/core-llm-tools'
import { executeTool } from './tool-executor'
import { WikiService } from '../memory/wiki-service'
import { wrapRetrievedMemory } from './memory-delimiters'

/** Concatenate the visible text parts of a Gemini candidate, skipping thoughts. */
function joinText(parts: Array<{ text?: string; thought?: boolean }> | undefined): string {
  return (parts ?? []).filter(p => typeof p.text === 'string' && !p.thought).map(p => p.text).join('')
}

export async function chatWithMemory({
  userMessage,
  tools,
  enabledScopes,
  apiKey,
  wiki,
  history = [],
}: {
  userMessage: string
  tools: AgentToolManifest[]
  enabledScopes: string[]
  apiKey: string
  wiki: WikiService
  history: Array<{ role: string; content: string }>
}): Promise<{ response: string; toolCalls?: any[] }> {
  await wiki.remember(userMessage, { timestamp: Date.now() })
  const memoryContext = await wiki.getContext(userMessage)
  const authorizedTools = buildAuthorizedToolsArray(tools, enabledScopes)
  // `gemini-flash-latest` is Google's rolling alias. The previous pin,
  // gemini-2.0-flash, was retired and 404'd on every generate call while
  // its models/ metadata still answered 200 (live smoke, 2026-11-10).
  const GEMINI_URL =
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent'
  // Auth goes in a lower-case header (never the URL) so web/Expo fetch
  // polyfills normalize it consistently and the key can't leak into URL logs.
  const headers = { 'content-type': 'application/json', 'x-goog-api-key': apiKey }

  const systemPrompt = `You are a helpful assistant with access to tools.\n${memoryContext ? `${wrapRetrievedMemory(memoryContext)}\n` : ''}Only use tools whose scopes are enabled.`
  // The system prompt travels in `systemInstruction`: Gemini rejects a
  // `system` role inside `contents`, and only `user` / `model` are its
  // documented turn roles, so app-side `assistant` turns map to `model`.
  const systemInstruction = { parts: [{ text: systemPrompt }] }
  const contents = [...history, { role: 'user', content: userMessage }].map(m => ({
    role: m.role === 'assistant' ? 'model' : m.role,
    parts: [{ text: m.content }],
  }))

  const response = await fetch(GEMINI_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        systemInstruction,
        contents,
        tools: authorizedTools.length ? authorizedTools : undefined,
        tool_config: { function_calling_config: { mode: 'AUTO' } },
      }),
    },
  )

  if (!response.ok) {
    // Generic message only: provider bodies can contain account/project
    // identifiers. Raw body available behind DEBUG_LLM_RAW_ERRORS.
    if (import.meta.env.VITE_DEBUG_LLM_RAW_ERRORS === 'true') {
      const errorText = await response.text()
      console.error(`Gemini API error body: ${errorText.slice(0, 500)}`)
    }
    throw new Error(`Gemini API error: HTTP ${response.status}`)
  }

  const data = await response.json()
  const candidate = data.candidates?.[0]
  // Search every part: a model may emit text or thought parts before the call.
  const functionCall = candidate?.content?.parts?.find((p: any) => p.functionCall)?.functionCall

  if (functionCall) {
    // Fail-closed: a tool is executable only if its scope is always-on
    // (AUTHORIZED_SCOPES, imported from core-llm-tools) or in the user's
    // enabledScopes. Tools with missing/unknown scopes are rejected.
    const advertisedNames = new Set(
      authorizedTools.flatMap(entry =>
        'functionDeclarations' in entry ? entry.functionDeclarations.map(d => d.name) : []
      )
    )
    const tool = tools.find(t => {
      if (t.name !== functionCall.name) return false
      if (!advertisedNames.has(t.name)) return false
      if (!t.scope) return false
      return isAuthorizedScope(t.scope) || enabledScopes.includes(t.scope)
    })
    if (tool) {
      const result = await executeTool(tool, functionCall.args || {})
      const followup = await fetch(GEMINI_URL, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            systemInstruction,
            // Echo the model's turn verbatim: thinking models attach a
            // `thoughtSignature` to the functionCall part and reject the
            // follow-up without it. The function response goes back as a
            // `user` turn; Gemini rejects a `function` role.
            contents: [
              ...contents,
              candidate.content,
              { role: 'user', parts: [{ functionResponse: { name: functionCall.name, response: { result } } }] },
            ],
          }),
        },
      )

      if (!followup.ok) {
        if (import.meta.env.VITE_DEBUG_LLM_RAW_ERRORS === 'true') {
          const errorText = await followup.text()
          console.error(`Gemini API follow-up error body: ${errorText.slice(0, 500)}`)
        }
        throw new Error(`Gemini API follow-up error: HTTP ${followup.status}`)
      }

      const finalData = await followup.json()
      const finalText = joinText(finalData.candidates?.[0]?.content?.parts) || 'Tool executed.'
      await wiki.remember(`Tool call: ${functionCall.name}(${JSON.stringify(functionCall.args)}) → ${JSON.stringify(result).slice(0, 200)}`, {
        type: 'tool_execution',
        tool: functionCall.name,
      })
      return { response: finalText, toolCalls: [{ name: functionCall.name, args: functionCall.args, result }] }
    }
  }

  const text = joinText(candidate?.content?.parts) || 'No response.'
  await wiki.remember(`Assistant: ${text.slice(0, 500)}`, { type: 'assistant_response' })
  return { response: text }
}

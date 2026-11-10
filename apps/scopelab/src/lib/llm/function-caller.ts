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
  history?: Array<{ role: string; content: string }>
}): Promise<{
  response: string
  toolCalls?: Array<{ name: string; args?: Record<string, unknown>; result: unknown }>
  /**
   * True when `response` is a model answer, remembered as such. False when it
   * is a status message: it is not remembered and must stay out of chat history.
   */
  stored: boolean
}> {
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
    // Gemini knows only `user` and `model`; anything else would 400.
    role: m.role === 'assistant' || m.role === 'model' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }))

  const response = await fetch(GEMINI_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        systemInstruction,
        contents,
        // tool_config only alongside tools: with every scope toggled off
        // there are no declarations, and a lone tool_config can be rejected.
        ...(authorizedTools.length
          ? { tools: authorizedTools, tool_config: { function_calling_config: { mode: 'AUTO' } } }
          : {}),
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
  if (!candidate?.content?.parts?.length) {
    // Safety block, recitation stop, or empty candidate: tell the user
    // and keep the placeholder out of memory and history replay.
    const reason = data.promptFeedback?.blockReason ?? candidate?.finishReason ?? 'empty response'
    return { response: `Gemini returned no answer (${reason}).`, stored: false }
  }
  // Search every part: a model may emit text or thought parts before the
  // call, and may emit several calls in one turn (parallel calling).
  const functionCalls: Array<{ id?: string; name: string; args?: Record<string, unknown> }> =
    candidate.content.parts.filter((p: any) => p.functionCall).map((p: any) => p.functionCall)

  if (functionCalls.length) {
    // Fail-closed: a tool is executable only if its scope is always-on
    // (AUTHORIZED_SCOPES, imported from core-llm-tools) or in the user's
    // enabledScopes. Tools with missing/unknown scopes are rejected.
    const advertisedNames = new Set(
      authorizedTools.flatMap(entry =>
        'functionDeclarations' in entry ? entry.functionDeclarations.map(d => d.name) : []
      )
    )
    const authorize = (name: string) => tools.find(t => {
      if (t.name !== name) return false
      if (!advertisedNames.has(t.name)) return false
      if (!t.scope) return false
      return isAuthorizedScope(t.scope) || enabledScopes.includes(t.scope)
    })
    const resolved = functionCalls.map(call => ({ call, tool: authorize(call.name) }))

    if (!resolved.some(r => r.tool)) {
      // Nothing the model asked for is executable: no tool runs and no
      // follow-up is sent (M-2). Say so instead of storing a placeholder.
      const names = functionCalls.map(c => c.name).join(', ')
      return { response: `The model asked for a tool that is not enabled (${names}).`, stored: false }
    }

    const toolCalls: Array<{ name: string; args?: Record<string, unknown>; result: unknown }> = []
    const responseParts: any[] = []
    for (const { call, tool } of resolved) {
      // Gemini requires one functionResponse per functionCall, in order;
      // an unauthorized call in a mixed turn gets an error, never a run.
      // A handler that throws gets an error too, so one failing call
      // neither breaks the count nor discards the calls that already ran.
      let result: unknown
      if (!tool) {
        result = { error: 'Tool not enabled.' }
      } else {
        try {
          result = await executeTool(tool, call.args || {})
          toolCalls.push({ name: call.name, args: call.args, result })
        } catch {
          result = { error: 'Tool failed.' }
        }
      }
      responseParts.push({
        functionResponse: { ...(call.id ? { id: call.id } : {}), name: call.name, response: { result } },
      })
    }

    const followup = await fetch(GEMINI_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          systemInstruction,
          // Echo the model's turn verbatim: thinking models attach a
          // `thoughtSignature` to the (first) functionCall part and reject
          // the follow-up without it. The function responses go back as a
          // `user` turn; Gemini rejects a `function` role. One tool round
          // only: `tools` is not resent, so the model must answer in text.
          contents: [
            ...contents,
            { ...candidate.content, role: 'model' },
            { role: 'user', parts: responseParts },
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
    // Tool executions are remembered once the follow-up parses, whether or
    // not it carries text: the calls did run.
    for (const { name, args, result } of toolCalls) {
      await wiki.remember(`Tool call: ${name}(${JSON.stringify(args)}) → ${JSON.stringify(result).slice(0, 200)}`, {
        type: 'tool_execution',
        tool: name,
      })
    }
    const finalCandidate = finalData.candidates?.[0]
    const finalText = joinText(finalCandidate?.content?.parts)
    if (!finalText) {
      const reason = finalData.promptFeedback?.blockReason ?? finalCandidate?.finishReason ?? 'no text'
      return { response: `The tool ran, but Gemini returned no answer (${reason}).`, toolCalls, stored: false }
    }
    // Same contract as the text path: a stored answer is in memory too.
    await wiki.remember(`Assistant: ${finalText.slice(0, 500)}`, { type: 'assistant_response' })
    return { response: finalText, toolCalls, stored: true }
  }

  const text = joinText(candidate.content.parts)
  if (!text) {
    return { response: `Gemini returned no answer (${candidate.finishReason ?? 'no text'}).`, stored: false }
  }
  await wiki.remember(`Assistant: ${text.slice(0, 500)}`, { type: 'assistant_response' })
  return { response: text, stored: true }
}

import { buildAuthorizedSchemaArray } from '@equationalapplications/core-llm-tools'
import type { AgentToolManifest } from '@equationalapplications/core-llm-tools'
import { executeTool } from './tool-executor'
import { WikiService } from '../memory/wiki-service'

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
  const authorizedScopes = buildAuthorizedSchemaArray(tools, enabledScopes)
  const systemPrompt = `You are a helpful assistant with access to tools.\n${memoryContext}${memoryContext ? '\n' : ''}Only use tools whose scopes are enabled.`
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: userMessage },
  ]

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: messages.map(m => ({ role: m.role === 'system' ? 'user' : m.role, parts: [{ text: m.content }] })),
        tools: authorizedScopes.length ? [{ functionDeclarations: authorizedScopes }] : undefined,
        tool_config: { function_calling_config: { mode: 'AUTO' } },
      }),
    },
  )

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Gemini API error: ${response.status} ${response.statusText} — ${errorText.slice(0, 500)}`)
  }

  const data = await response.json()
  const candidate = data.candidates?.[0]
  const functionCall = candidate?.content?.parts?.[0]?.functionCall

  if (functionCall) {
    const tool = tools.find(t => {
      if (t.name !== functionCall.name) return false
      // buildAuthorizedSchemaArray includes 'core' scope unconditionally;
      // also accept tools whose scope is in the authorized scopes list
      return t.scope === 'core' || enabledScopes.includes(t.scope)
    })
    if (tool) {
      const result = await executeTool(tool, functionCall.args || {})
      const followup = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [
              ...messages.map(m => ({ role: m.role === 'system' ? 'user' : m.role, parts: [{ text: m.content }] })),
              { role: 'model', parts: [{ functionCall }] },
              { role: 'function', parts: [{ functionResponse: { name: functionCall.name, response: { result } } }] },
            ],
          }),
        },
      )

      if (!followup.ok) {
        const errorText = await followup.text()
        throw new Error(`Gemini API follow-up error: ${followup.status} ${followup.statusText} — ${errorText.slice(0, 500)}`)
      }

      const finalData = await followup.json()
      const finalText = finalData.candidates?.[0]?.content?.parts?.[0]?.text || 'Tool executed.'
      await wiki.remember(`Tool call: ${functionCall.name}(${JSON.stringify(functionCall.args)}) → ${JSON.stringify(result).slice(0, 200)}`, {
        type: 'tool_execution',
        tool: functionCall.name,
      })
      return { response: finalText, toolCalls: [{ name: functionCall.name, args: functionCall.args, result }] }
    }
  }

  const text = candidate?.content?.parts?.[0]?.text || 'No response.'
  await wiki.remember(`Assistant: ${text.slice(0, 500)}`, { type: 'assistant_response' })
  return { response: text }
}

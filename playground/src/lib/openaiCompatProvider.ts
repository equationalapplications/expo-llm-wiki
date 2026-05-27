import type { LLMProvider } from '@equationalapplications/react-llm-wiki'

export interface OpenAICompatConfig {
  baseUrl: string
  apiKey?: string
  chatModel: string
  embedModel?: string
}

export function createOpenAICompatProvider(config: OpenAICompatConfig): LLMProvider {
  const { baseUrl, apiKey, chatModel, embedModel } = config
  const base = baseUrl.replace(/\/$/, '')
  const headers = {
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  }

  return {
    generateText: async ({ systemPrompt, userPrompt }) => {
      const response = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: chatModel,
          max_tokens: 4096,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        }),
      })
      if (!response.ok) {
        const err = await response.text()
        throw new Error(`LLM API error ${response.status}: ${err}`)
      }
      const data = await response.json()
      return data.choices?.[0]?.message?.content ?? ''
    },

    embed: embedModel
      ? async (text: string) => {
          const response = await fetch(`${base}/v1/embeddings`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ model: embedModel, input: text }),
          })
          if (!response.ok) {
            const err = await response.text()
            throw new Error(`Embed API error ${response.status}: ${err}`)
          }
          const data = await response.json()
          return data.data?.[0]?.embedding as number[]
        }
      : undefined,
  }
}

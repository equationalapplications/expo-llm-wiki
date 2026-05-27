import type { LLMProvider } from '@equationalapplications/react-llm-wiki'

export interface OpenAICompatConfig {
  baseUrl: string
  apiKey?: string
  chatModel: string
  embedModel?: string
}

export function createOpenAICompatProvider(config: OpenAICompatConfig): LLMProvider {
  const { baseUrl, apiKey, chatModel, embedModel } = config
  const base = baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '')
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
      const content = data.choices?.[0]?.message?.content
      if (typeof content !== 'string') throw new Error('LLM API error: unexpected response shape (missing choices[0].message.content)')
      return content
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
          const data = (await response.json()) as {
            data?: Array<{ embedding?: unknown }>
          }
          const embedding = data.data?.[0]?.embedding
          if (
            !Array.isArray(embedding) ||
            !embedding.every((value) => typeof value === 'number')
          ) {
            throw new Error(
              'Embed API error: missing or invalid embedding array in response',
            )
          }
          return embedding
        }
      : undefined,
  }
}

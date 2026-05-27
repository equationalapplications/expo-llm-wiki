import type { LLMProvider } from '@equationalapplications/react-llm-wiki'

export function createAnthropicProvider(apiKey: string, model: string): LLMProvider {
  return {
    generateText: async ({ systemPrompt, userPrompt }) => {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        }),
      })
      if (!response.ok) {
        const err = await response.text()
        throw new Error(`Anthropic API error ${response.status}: ${err}`)
      }
      const data = await response.json()
      return data.content?.[0]?.text ?? ''
    },
  }
}

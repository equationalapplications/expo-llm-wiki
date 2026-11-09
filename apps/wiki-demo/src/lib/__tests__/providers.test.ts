import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAnthropicProvider } from '../anthropicProvider'
import { createOpenAICompatProvider } from '../openaiCompatProvider'

const SECRET_BODY = '{"error":"quota exceeded for project acct-12345"}'

function stubFailingFetch(status: number) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(SECRET_BODY, { status })))
}

async function failure(call: () => Promise<unknown>): Promise<string> {
  try {
    await call()
  } catch (e) {
    return (e as Error).message
  }
  throw new Error('expected the call to reject')
}

const prompts = { systemPrompt: 's', userPrompt: 'u' }

describe('provider error scrubbing (audit 2026-08-24, L-3)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('anthropic generateText reports only the HTTP status', async () => {
    stubFailingFetch(429)
    const provider = createAnthropicProvider('k', 'm')
    expect(await failure(() => provider.generateText(prompts as never))).toBe(
      'Provider request failed: HTTP 429',
    )
  })

  it('openai-compatible generateText reports only the HTTP status', async () => {
    stubFailingFetch(401)
    const provider = createOpenAICompatProvider({ baseUrl: 'https://x.test', chatModel: 'm' })
    expect(await failure(() => provider.generateText(prompts as never))).toBe(
      'Provider request failed: HTTP 401',
    )
  })

  it('openai-compatible embed reports only the HTTP status', async () => {
    stubFailingFetch(500)
    const provider = createOpenAICompatProvider({
      baseUrl: 'https://x.test',
      chatModel: 'm',
      embedModel: 'e',
    })
    expect(await failure(() => provider.embed!('t'))).toBe('Provider request failed: HTTP 500')
  })
})

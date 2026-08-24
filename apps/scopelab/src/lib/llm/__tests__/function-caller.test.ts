import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { chatWithMemory } from '../function-caller'
import type { AgentToolManifest } from '@equationalapplications/core-llm-tools'

const searchTool: AgentToolManifest = {
  name: 'search_memory',
  description: 'Search stored memories',
  parameters: { type: 'object', properties: { query: { type: 'string' } } },
  scope: 'core',
} as unknown as AgentToolManifest

function mockWiki(context = '') {
  return {
    remember: vi.fn().mockResolvedValue(undefined),
    getContext: vi.fn().mockResolvedValue(context),
  } as any
}

function geminiResponse(body: any) {
  return new Response(JSON.stringify(body), { status: 200 })
}

describe('chatWithMemory — Gemini auth header (H-2)', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(
      geminiResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
    )
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends the api key via x-goog-api-key header, lower-case', async () => {
    await chatWithMemory({
      userMessage: 'hi',
      tools: [searchTool],
      enabledScopes: [],
      apiKey: 'test-key-123',
      wiki: mockWiki(),
    })
    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers['x-goog-api-key']).toBe('test-key-123')
    expect(Object.keys(init.headers).some(k => k !== k.toLowerCase())).toBe(false)
  })

  it('never places the key in the request URL', async () => {
    await chatWithMemory({
      userMessage: 'hi',
      tools: [searchTool],
      enabledScopes: [],
      apiKey: 'secret-value',
      wiki: mockWiki(),
    })
    for (const [url] of fetchMock.mock.calls) {
      expect(String(url)).not.toContain('key=')
      expect(String(url)).not.toContain('secret-value')
    }
  })

  it('surfaces generic errors without embedding provider response bodies', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"error":"account project-abc quota"}', { status: 403 }))
    await expect(
      chatWithMemory({
        userMessage: 'hi',
        tools: [searchTool],
        enabledScopes: [],
        apiKey: 'k',
        wiki: mockWiki(),
      }),
    ).rejects.toThrow(/HTTP 403/)
  })
})

import { describe, it, expect, vi } from 'vitest'
import { AUTHORIZED_SCOPES, buildAuthorizedSchemaArray } from '@equationalapplications/core-llm-tools'
import { chatWithMemory } from '../function-caller'
import type { AgentToolManifest } from '@equationalapplications/core-llm-tools'

// NOTE: the assertions below must never hardcode 'core' — a sync test that
// repeats the literal stops being a sync test. Everything derives from
// AUTHORIZED_SCOPES.

function mockWiki(context = '') {
  return {
    remember: vi.fn().mockResolvedValue(undefined),
    getContext: vi.fn().mockResolvedValue(context),
  } as any
}

function geminiResponse(body: any) {
  return new Response(JSON.stringify(body), { status: 200 })
}

function geminiFunctionCall(name: string, args: object = {}) {
  return geminiResponse({
    candidates: [{ content: { parts: [{ functionCall: { name, args } }] } }],
  })
}

function geminiText(text: string) {
  const part = { text: text }
  const parts = [part]
  const content = { parts: parts }
  const candidate = { content: content }
  const candidates = [candidate]
  return geminiResponse({ candidates: candidates })
}

/** A manifest that buildAuthorizedSchemaArray will actually advertise (has `schema`). */
function makeTool(over: Partial<{ name: string; scope: string; schemaName: string }> = {}) {
  const name = over.name ?? 'search_memory'
  return {
    name,
    description: 'd',
    parameters: { type: 'object', properties: { query: { type: 'string' } } },
    scope: over.scope ?? AUTHORIZED_SCOPES[0],
    schema: {
      name: over.schemaName ?? name,
      description: 'd',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
    },
  } as unknown as AgentToolManifest
}

describe('injector/executor scope parity (issue #106)', () => {
  it('advertises exactly the always-on scopes when nothing is granted', () => {
    const manifests = AUTHORIZED_SCOPES.map((scope) => makeTool({ scope }))
    const advertised = buildAuthorizedSchemaArray(manifests, [])
    expect(advertised).toHaveLength(AUTHORIZED_SCOPES.length)
  })

  it('executes an always-on tool with empty enabledScopes', async () => {
    const scope = AUTHORIZED_SCOPES[0]
    const fetchMock = vi.fn()
    fetchMock
      .mockResolvedValueOnce(geminiFunctionCall('search_memory', { query: 'q' }))
      .mockResolvedValueOnce(geminiText('done'))
    vi.stubGlobal('fetch', fetchMock)
    try {
      await chatWithMemory({
        userMessage: 'hi',
        tools: [makeTool({ scope })],
        enabledScopes: [],
        apiKey: 'k',
        wiki: mockWiki('ctx'),
      })
      // initial + follow-up = 2 fetches → tool ran
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects a tool whose scope is neither always-on nor enabled', async () => {
    const fetchMock = vi.fn()
    fetchMock.mockResolvedValueOnce(geminiFunctionCall('search_memory', { query: 'q' }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      await chatWithMemory({
        userMessage: 'hi',
        tools: [makeTool({ scope: 'memory:write' })],
        enabledScopes: [],
        apiKey: 'k',
        wiki: mockWiki(),
      })
      // initial only → tool NOT executed
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

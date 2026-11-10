import { describe, it, expect, vi, afterEach } from 'vitest'
import { geminiGenerateText } from '../gemini-provider'

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

describe('geminiGenerateText', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('sends the prompts with the key in a header and asks for JSON', async () => {
    const fetchMock = vi.fn(async () => ok({ candidates: [{ content: { parts: [{ text: '{"facts":[]}' }] } }] }))
    vi.stubGlobal('fetch', fetchMock)
    const text = await geminiGenerateText(() => ' key-1 ')({ systemPrompt: 'sys', userPrompt: 'usr' })
    expect(text).toBe('{"facts":[]}')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).not.toContain('key-1')
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('key-1')
    // A hung maintenance call must not hold the consolidate chain forever.
    expect(init.signal).toBeInstanceOf(AbortSignal)
    const body = JSON.parse(init.body as string)
    expect(body.systemInstruction.parts[0].text).toBe('sys')
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'usr' }] }])
    expect(body.generationConfig.responseMimeType).toBe('application/json')
  })

  it('reads the key at call time, so a key typed after launch is used', async () => {
    const fetchMock = vi.fn(async () => ok({ candidates: [{ content: { parts: [{ text: '{}' }] } }] }))
    vi.stubGlobal('fetch', fetchMock)
    let key = ''
    const generate = geminiGenerateText(() => key)
    key = 'typed-later'
    await generate({ systemPrompt: 's', userPrompt: 'u' })
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('typed-later')
  })

  it('fails without calling Gemini when no key is set', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(geminiGenerateText(() => '  ')({ systemPrompt: 's', userPrompt: 'u' })).rejects.toThrow(/API key/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('throws on an HTTP error without echoing the body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('secret project id', { status: 429 })))
    const call = geminiGenerateText(() => 'k')({ systemPrompt: 's', userPrompt: 'u' })
    await expect(call).rejects.toThrow('HTTP 429')
    await expect(call).rejects.not.toThrow(/secret/)
  })

  it('throws on an empty answer, skipping thought parts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ candidates: [{ content: { parts: [{ text: 'hmm', thought: true }] } }] })))
    await expect(geminiGenerateText(() => 'k')({ systemPrompt: 's', userPrompt: 'u' })).rejects.toThrow(/no text/)
  })
})

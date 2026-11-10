import { describe, it, expect, vi, afterEach } from 'vitest'
import { callGemini, GEMINI_URL } from '../gemini-client'

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

describe('callGemini', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('posts to the rolling alias with the key in a lower-case header, never the URL', async () => {
    const fetchMock = vi.fn(async () => ok({ candidates: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await callGemini('key-1', { a: 1 })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(GEMINI_URL)
    expect(String(url)).not.toContain('key-1')
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('key-1')
    expect(Object.keys(init.headers as Record<string, string>).every(k => k === k.toLowerCase())).toBe(true)
    expect(init.body).toBe(JSON.stringify({ a: 1 }))
  })

  it('bounds the call with an AbortSignal so a stalled fetch cannot wedge the caller', async () => {
    const fetchMock = vi.fn(async () => ok({}))
    vi.stubGlobal('fetch', fetchMock)
    await callGemini('k', {})
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(init.signal?.aborted).toBe(false)
  })

  it('throws a status-only error under the given label and never echoes the body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"account project-abc quota"}', { status: 429 })))
    await expect(callGemini('k', {}, 'maintenance')).rejects.toThrow('Gemini maintenance error: HTTP 429')
    await expect(callGemini('k', {}, 'maintenance')).rejects.not.toThrow(/project-abc/)
    await expect(callGemini('k', {}, 'maintenance')).rejects.not.toThrow(/quota/)
  })
})

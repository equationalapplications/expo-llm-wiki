import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { loadSessionConfig, saveSessionConfig } from '../sessionConfig'

const DEFAULTS = { providerType: 'anthropic', anthropicKey: '' }

function mockStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  } as Storage
}

describe('sessionConfig (H-3)', () => {
  let session: Storage | undefined
  let local: Storage | undefined

  beforeEach(() => {
    session = mockStorage()
    local = mockStorage()
    vi_stub()
  })

  function vi_stub() {
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get: () => session })
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => local })
  }

  afterEach(() => {
    session = undefined
    local = undefined
    vi_stub()
  })

  it('default load returns defaults (legacy purge is no longer per-call)', () => {
    local!.setItem('llm-config', '{"anthropicKey":"legacy"}')
    local!.setItem('anthropic-key', 'sk-legacy')
    const cfg = loadSessionConfig(DEFAULTS)
    expect(cfg).toEqual(DEFAULTS)
  })

  it('save with persist=false writes nothing anywhere', () => {
    saveSessionConfig({ a: 1 }, false)
    expect(session!.getItem('llm-config')).toBeNull()
    expect(local!.getItem('llm-config')).toBeNull()
  })

  it('opting out (persist=false) removes a previously persisted session config', () => {
    saveSessionConfig({ providerType: 'anthropic', anthropicKey: 'sk-secret' }, true)
    expect(session!.getItem('llm-config')).not.toBeNull()
    expect(saveSessionConfig({ providerType: 'anthropic', anthropicKey: '' }, false)).toBe(true)
    expect(session!.getItem('llm-config')).toBeNull()
    expect(loadSessionConfig(DEFAULTS)).toEqual(DEFAULTS)
  })

  it('save with persist=true writes sessionStorage only, and round-trips', () => {
    expect(saveSessionConfig({ providerType: 'openai-compat', anthropicKey: 'sk-x' }, true)).toBe(true)
    expect(local!.getItem('llm-config')).toBeNull()
    const cfg = loadSessionConfig(DEFAULTS)
    expect(cfg.providerType).toBe('openai-compat')
    expect(cfg.anthropicKey).toBe('sk-x')
  })

  it('falls back to memory-only when sessionStorage is unavailable (SSR/privacy mode)', () => {
    session = undefined
    expect(saveSessionConfig({ a: 1 }, true)).toBe(false)
    expect(() => loadSessionConfig(DEFAULTS)).not.toThrow()
    expect(loadSessionConfig(DEFAULTS)).toEqual(DEFAULTS)
  })
})

describe('legacy-key purge runs once per page load (issue #107)', () => {
  it('purges at module import and not again on a second call', async () => {
    const removed: string[] = []
    const recording = {
      getItem: () => null,
      setItem: () => {},
      removeItem: (k: string) => { removed.push(k) },
      clear: () => {},
    } as unknown as Storage

    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => recording,
    })
    try {
      // Fresh module registry == a fresh page load, so the module body re-runs
      // with the recording stub visible.
      vi.resetModules()
      const mod = await import('../sessionConfig')
      expect(removed).toEqual(['llm-config', 'anthropic-key'])

      // Same (cached) module instance: the guard must suppress a second sweep.
      mod.purgeLegacyPlaintextKeys()
      expect(removed).toEqual(['llm-config', 'anthropic-key'])

      // load/save must not sweep — the purge is import-time only (#107).
      removed.length = 0
      mod.loadSessionConfig(DEFAULTS)
      mod.saveSessionConfig({ providerType: 'anthropic', anthropicKey: '' }, false)
      expect(removed).toEqual([])
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original)
      else delete (globalThis as { localStorage?: Storage }).localStorage
    }
  })
})

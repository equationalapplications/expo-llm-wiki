// Session-scoped config storage with graceful degradation.
//
// Security posture (audit 2026-08-24, H-3): API keys are NEVER persisted to
// localStorage. Keys live in memory for the tab session; an explicit opt-in
// keeps them in sessionStorage (cleared when the tab closes). If
// sessionStorage is unavailable (SSR, non-browser, privacy mode), we fall
// back to pure in-memory storage — initialization never throws.

const STORE_KEY = 'llm-config'

interface StoredConfig {
  [k: string]: unknown
}

function getStorage(): Storage | null {
  try {
    if (typeof sessionStorage !== 'undefined') {
      const probe = '__llm_probe__'
      sessionStorage.setItem(probe, '1')
      sessionStorage.removeItem(probe)
      return sessionStorage
    }
  } catch { /* unavailable or blocked */ }
  return null
}

/** One-time cleanup of legacy plaintext localStorage keys (pre-hardening). */
export function purgeLegacyPlaintextKeys(): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('llm-config')
      localStorage.removeItem('anthropic-key')
    }
  } catch { /* ignore */ }
}

function loadPersisted(): Record<string, unknown> | null {
  const storage = getStorage()
  if (!storage) return null
  try {
    const raw = storage.getItem(STORE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch { /* ignore JSON errors */ }
  return null
}

export function loadSessionConfig<T extends object>(defaults: T): T {
  purgeLegacyPlaintextKeys()
  const stored = loadPersisted()
  const merged: Record<string, unknown> = { ...defaults }
  if (stored) {
    for (const key of Object.keys(defaults) as Array<keyof T & string>) {
      if (typeof stored[key] === typeof defaults[key]) merged[key] = stored[key]
    }
  }
  return merged as unknown as T
}

/**
 * Persist only when `persist` is true (explicit user opt-in). Returns false
 * when persistence was requested but is unavailable — callers should surface
 * that the config will last only for this session instead of throwing.
 */
export function saveSessionConfig(cfg: object, persist: boolean): boolean {
  purgeLegacyPlaintextKeys()
  if (!persist) return true // memory-only by design
  const storage = getStorage()
  if (!storage) return false
  try {
    storage.setItem(STORE_KEY, JSON.stringify(cfg))
    return true
  } catch {
    return false
  }
}

import { useState } from 'react'
import { WikiProvider, createWiki } from '@equationalapplications/react-llm-wiki'
import type { WikiMemory } from '@equationalapplications/react-llm-wiki'
import { createSqlJsAdapter } from './lib/sqlJsAdapter'
import { createAnthropicProvider } from './lib/anthropicProvider'
import { createOpenAICompatProvider } from './lib/openaiCompatProvider'
import { ReadTab } from './components/ReadTab'
import { WriteTab } from './components/WriteTab'
import { IngestTab } from './components/IngestTab'
import { MaintenanceTab } from './components/MaintenanceTab'
import { ExportTab } from './components/ExportTab'

type Tab = 'write' | 'read' | 'ingest' | 'maintenance' | 'export'
type ProviderType = 'anthropic' | 'openai-compat'

const TABS: Array<{ id: Tab; label: string; icon: string }> = [
  { id: 'write', label: 'Write', icon: '✏' },
  { id: 'read', label: 'Read', icon: '🔍' },
  { id: 'ingest', label: 'Ingest', icon: '📄' },
  { id: 'maintenance', label: 'Maintenance', icon: '⚙' },
  { id: 'export', label: 'Export', icon: '↓' },
]

interface StoredConfig {
  providerType: ProviderType
  anthropicKey: string
  anthropicModel: string
  openaiBaseUrl: string
  openaiApiKey: string
  openaiChatModel: string
  openaiEmbedModel: string
}

const DEFAULTS: StoredConfig = {
  providerType: 'anthropic',
  anthropicKey: '',
  anthropicModel: 'claude-haiku-4-5-20251001',
  openaiBaseUrl: 'https://api.openai.com',
  openaiApiKey: '',
  openaiChatModel: 'gpt-4o-mini',
  openaiEmbedModel: 'text-embedding-3-small',
}

function loadConfig(): StoredConfig {
  try {
    const raw = localStorage.getItem('llm-config')
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null) {
        const p = parsed as Record<string, unknown>
        const merged: StoredConfig = { ...DEFAULTS }
        for (const key of Object.keys(DEFAULTS) as Array<keyof StoredConfig>) {
          if (typeof p[key] === typeof DEFAULTS[key]) {
            (merged as unknown as Record<string, unknown>)[key] = p[key]
          }
        }
        if (merged.providerType !== 'anthropic' && merged.providerType !== 'openai-compat') {
          merged.providerType = DEFAULTS.providerType
        }
        return merged
      }
    }
    // migrate legacy key
    const legacy = localStorage.getItem('anthropic-key')
    if (legacy) return { ...DEFAULTS, anthropicKey: legacy }
  } catch { /* ignore JSON.parse errors */ }
  return { ...DEFAULTS }
}

function saveConfig(cfg: StoredConfig) {
  try {
    localStorage.setItem('llm-config', JSON.stringify(cfg))
  } catch {
    throw new Error(
      'Unable to save your configuration in this browser. Storage may be disabled or full. Please check your browser settings and try again.',
    )
  }
}

function SetupScreen({ onReady }: { onReady: (wiki: WikiMemory) => void }) {
  const [cfg, setCfg] = useState<StoredConfig>(loadConfig)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const set = (patch: Partial<StoredConfig>) => setCfg(prev => ({ ...prev, ...patch }))

  const canStart =
    cfg.providerType === 'anthropic'
      ? cfg.anthropicKey.trim().length > 0
      : cfg.openaiBaseUrl.trim().length > 0 && cfg.openaiChatModel.trim().length > 0

  const handleStart = async () => {
    if (!canStart || loading) return
    setLoading(true)
    setError('')
    try {
      saveConfig(cfg)
      const adapter = await createSqlJsAdapter()
      const llmProvider =
        cfg.providerType === 'anthropic'
          ? createAnthropicProvider(cfg.anthropicKey, cfg.anthropicModel)
          : createOpenAICompatProvider({
              baseUrl: cfg.openaiBaseUrl,
              apiKey: cfg.openaiApiKey,
              chatModel: cfg.openaiChatModel,
              embedModel: cfg.openaiEmbedModel.trim() || undefined,
            })
      const wiki = createWiki(adapter, {
        llmProvider,
        config: {
          autoLibrarianThreshold: 5,
          autoHealThreshold: 20,
        },
      })
      await wiki.setup()
      onReady(wiki)
    } catch (e) {
      setError((e as Error).message)
      setLoading(false)
    }
  }

  return (
    <div className="setup-screen">
      <div className="setup-card">
        <div className="setup-logo">
          <span className="logo-icon">◈</span>
          <div>
            <h1>LLM Wiki Playground</h1>
            <p>Interactive explorer for <code>@equationalapplications/react-llm-wiki</code></p>
          </div>
        </div>

        <div className="setup-features">
          <div className="feature">
            <span>🧠</span>
            <div>
              <strong>Persistent Memory</strong>
              <p>Facts, tasks, and events stored in-browser via sql.js (WebAssembly SQLite)</p>
            </div>
          </div>
          <div className="feature">
            <span>🔍</span>
            <div>
              <strong>Hybrid Retrieval</strong>
              <p>Keyword (MiniSearch) + semantic (embeddings) with configurable blend</p>
            </div>
          </div>
          <div className="feature">
            <span>🤖</span>
            <div>
              <strong>Bring Your Own Inference</strong>
              <p>Anthropic or any OpenAI-compatible endpoint (Groq, Together, Ollama, …)</p>
            </div>
          </div>
        </div>

        <div className="setup-form">
          <label>Provider</label>
          <div className="provider-tabs">
            <button
              className={`provider-tab ${cfg.providerType === 'anthropic' ? 'active' : ''}`}
              onClick={() => set({ providerType: 'anthropic' })}
              type="button"
            >
              Anthropic
            </button>
            <button
              className={`provider-tab ${cfg.providerType === 'openai-compat' ? 'active' : ''}`}
              onClick={() => set({ providerType: 'openai-compat' })}
              type="button"
            >
              OpenAI-Compatible
            </button>
          </div>

          {cfg.providerType === 'anthropic' && (
            <>
              <label>API Key</label>
              <input
                type="password"
                value={cfg.anthropicKey}
                onChange={e => set({ anthropicKey: e.target.value })}
                placeholder="sk-ant-..."
                onKeyDown={e => e.key === 'Enter' && handleStart()}
              />
              <p className="hint" style={{ color: 'var(--yellow)' }}>
                ⚠ API key is saved in browser localStorage (plaintext) and sent directly from your browser to Anthropic. Use a browser profile you trust, avoid shared machines, and do not use a key with broad permissions.
              </p>
              <label>Model</label>
              <input
                type="text"
                value={cfg.anthropicModel}
                onChange={e => set({ anthropicModel: e.target.value })}
                placeholder="claude-haiku-4-5-20251001"
                onKeyDown={e => e.key === 'Enter' && handleStart()}
              />
              <p className="hint">
                Used for Librarian/Heal/Ingest jobs. No embed support — falls back to keyword search.
                Get a key at <a href="https://console.anthropic.com" target="_blank" rel="noopener">console.anthropic.com</a>.
              </p>
            </>
          )}

          {cfg.providerType === 'openai-compat' && (
            <>
              <label>Base URL</label>
              <input
                type="text"
                value={cfg.openaiBaseUrl}
                onChange={e => set({ openaiBaseUrl: e.target.value })}
                placeholder="https://api.openai.com"
              />
              <p className="hint">
                OpenAI: <code>https://api.openai.com</code> ·
                Groq: <code>https://api.groq.com/openai</code> ·
                Together: <code>https://api.together.xyz</code> ·
                Ollama: <code>http://localhost:11434</code>
              </p>

              <label>API Key <span className="optional">(optional for local)</span></label>
              <input
                type="password"
                value={cfg.openaiApiKey}
                onChange={e => set({ openaiApiKey: e.target.value })}
                placeholder="sk-..."
              />
              {cfg.openaiApiKey && (
                <p className="hint" style={{ color: 'var(--yellow)' }}>
                  ⚠ API key is saved in browser localStorage (plaintext). Use a browser profile you trust and avoid shared machines.
                </p>
              )}

              <label>Chat Model</label>
              <input
                type="text"
                value={cfg.openaiChatModel}
                onChange={e => set({ openaiChatModel: e.target.value })}
                placeholder="gpt-4o-mini"
                onKeyDown={e => e.key === 'Enter' && handleStart()}
              />

              <label>Embed Model <span className="optional">(optional — blank = keyword fallback)</span></label>
              <input
                type="text"
                value={cfg.openaiEmbedModel}
                onChange={e => set({ openaiEmbedModel: e.target.value })}
                placeholder="text-embedding-3-small"
                onKeyDown={e => e.key === 'Enter' && handleStart()}
              />
              <p className="hint">
                Leave blank to skip vector embeddings and use keyword search only.
              </p>
            </>
          )}

          {error && <div className="status error">Error: {error}</div>}

          <button className="btn-primary btn-large" onClick={handleStart} disabled={loading || !canStart}>
            {loading ? 'Initializing…' : 'Launch Playground'}
          </button>
        </div>

        <div className="setup-footer">
          <a href="https://www.npmjs.com/package/@equationalapplications/react-llm-wiki" target="_blank" rel="noopener">npm</a>
          <span>·</span>
          <a href="https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f" target="_blank" rel="noopener">Karpathy's LLM Wiki spec</a>
        </div>
      </div>
    </div>
  )
}

export default function App() {
  const [wiki, setWiki] = useState<WikiMemory | null>(null)
  const [tab, setTab] = useState<Tab>('write')

  if (!wiki) return <SetupScreen onReady={setWiki} />

  return (
    <WikiProvider wiki={wiki}>
      <div className="app">
        <header className="app-header">
          <div className="header-left">
            <span className="logo-icon">◈</span>
            <span className="logo-text">LLM Wiki Playground</span>
          </div>
          <nav className="tab-nav">
            {TABS.map(t => (
              <button
                key={t.id}
                className={`tab-btn ${tab === t.id ? 'active' : ''}`}
                onClick={() => setTab(t.id)}
              >
                <span className="tab-icon">{t.icon}</span>
                {t.label}
              </button>
            ))}
          </nav>
          <button className="btn-ghost header-btn" onClick={() => setWiki(null)}>
            Settings
          </button>
        </header>

        <main className="app-main">
          {tab === 'write' && <WriteTab />}
          {tab === 'read' && <ReadTab />}
          {tab === 'ingest' && <IngestTab />}
          {tab === 'maintenance' && <MaintenanceTab />}
          {tab === 'export' && <ExportTab />}
        </main>
      </div>
    </WikiProvider>
  )
}

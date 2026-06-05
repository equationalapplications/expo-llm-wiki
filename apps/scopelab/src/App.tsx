import { useMemo, useState } from 'react'
import { SqlJsAdapter } from './lib/database/sqljs-adapter'
import { WikiService } from './lib/memory/wiki-service'
import { chatWithMemory } from './lib/llm/function-caller'
import { setToolWiki } from './lib/llm/tool-executor'
import { ScopeToggle } from './components/Tools/ScopeToggle'

const DEFAULT_SCOPES = ['tools:search', 'tools:memory']

export default function App() {
  const [apiKey, setApiKey] = useState('')
  const [wiki, setWiki] = useState<WikiService | null>(null)
  const [initialized, setInitialized] = useState(false)
  const [message, setMessage] = useState('')
  const [response, setResponse] = useState('')
  const [enabledScopes, setEnabledScopes] = useState<string[]>(DEFAULT_SCOPES)
  const [history, setHistory] = useState<Array<{ role: string; content: string }>>([])
  const [status, setStatus] = useState('Ready to launch ScopeLab')

  const tools = useMemo(
    () => [
      {
        name: 'search_memory',
        description: 'Search saved memories for relevant facts',
        scope: 'tools:memory',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
          },
          required: ['query'],
        },
      },
    ],
    [],
  )

  const launchApp = async () => {
    setStatus('Initializing memory…')
    try {
      const adapter = await SqlJsAdapter.create()
      const service = new WikiService(adapter)
      await service.init()
      setWiki(service)
      setToolWiki(service)
      setInitialized(true)
      setStatus('ScopeLab ready. Ask a question or open the memory panel.')
    } catch (error) {
      setStatus(`Initialization failed: ${(error as Error).message}`)
    }
  }

  const handleSend = async () => {
    if (!wiki || !apiKey.trim() || !message.trim()) return
    setStatus('Querying Gemini…')
    const userMessage = message.trim()
    const nextHistory = [...history, { role: 'user', content: userMessage }]
    setHistory(nextHistory)
    setMessage('')
    try {
      const result = await chatWithMemory({
        userMessage,
        tools,
        enabledScopes,
        apiKey: apiKey.trim(),
        wiki,
        history,
      })
      setResponse(result.response)
      setHistory(prev => [...prev, { role: 'assistant', content: result.response }])
      setStatus('Received response')
    } catch (error) {
      setStatus(`Chat failed: ${(error as Error).message}`)
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1>ScopeLab</h1>
          <p>Client-side LLM tool playground with local memory.</p>
        </div>
        <div className="status-bar">{status}</div>
      </header>

      <main className="grid">
        <section className="panel card">
          <h2>Setup</h2>
          <label>
            Gemini API Key
            <input
              type="password"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder="Enter Gemini API key"
            />
          </label>
          <button onClick={launchApp} disabled={initialized}>
            {initialized ? 'Memory initialized' : 'Initialize ScopeLab'}
          </button>
          <div className="hint">
            The app keeps memory in-browser using sql.js and lets you enable scoped tool access.
          </div>
          <div className="tool-toggle">
            <ScopeToggle tools={tools as any} enabledScopes={enabledScopes} onToggle={setEnabledScopes} />
          </div>
        </section>

        <section className="panel card">
          <h2>Chat</h2>
          <textarea
            rows={5}
            value={message}
            onChange={e => setMessage(e.target.value)}
            placeholder="Ask ScopeLab a question..."
            disabled={!initialized}
          />
          <button onClick={handleSend} disabled={!initialized || !message.trim()}>
            Send
          </button>
          <div className="response-box">
            <h3>Response</h3>
            <pre>{response || 'No response yet.'}</pre>
          </div>
        </section>
      </main>
    </div>
  )
}

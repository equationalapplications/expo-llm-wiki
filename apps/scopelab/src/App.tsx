import { useEffect, useMemo, useRef, useState } from 'react'
import { SqlJsAdapter } from './lib/database/sqljs-adapter'
import { WikiService } from './lib/memory/wiki-service'
import { chatWithMemory } from './lib/llm/function-caller'
import { geminiGenerateText } from './lib/llm/gemini-provider'
import { setToolWiki } from './lib/llm/tool-executor'
import { errorMessage } from './lib/errors'
import { ScopeToggle } from './components/Tools/ScopeToggle'
import type { AgentToolManifest } from '@equationalapplications/core-llm-tools'

const DEFAULT_SCOPES = ['memory:read']

export default function App() {
  const [apiKey, setApiKey] = useState('')
  const [wiki, setWiki] = useState<WikiService | null>(null)
  const [initialized, setInitialized] = useState(false)
  const [message, setMessage] = useState('')
  const [response, setResponse] = useState('')
  const [enabledScopes, setEnabledScopes] = useState<string[]>(DEFAULT_SCOPES)
  const [history, setHistory] = useState<Array<{ role: string; content: string }>>([])
  const [status, setStatus] = useState('Ready to launch ScopeLab')
  const [launching, setLaunching] = useState(false)
  const [sending, setSending] = useState(false)
  // Memory maintenance reads the key when it runs, so a key typed (or
  // changed) after Initialize is the one it uses. The ref is synced in an
  // effect, not during render: a discarded concurrent render must not
  // leave a key from uncommitted state behind.
  const apiKeyRef = useRef('')
  useEffect(() => {
    apiKeyRef.current = apiKey
  }, [apiKey])

  // buildAuthorizedToolsArray reads `schema`; a flat manifest without it
  // was advertised to Gemini as `functionDeclarations: [null]`, so the
  // model never saw the tool (live smoke, 2026-11-10).
  const tools = useMemo<AgentToolManifest[]>(
    () => [
      {
        name: 'search_memory',
        scope: 'memory:read',
        schema: {
          name: 'search_memory',
          description: 'Search saved memories for relevant facts',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search query' },
            },
            required: ['query'],
          },
        },
      },
    ],
    [],
  )

  const launchApp = async () => {
    // The wasm load takes hundreds of ms; a second click before it settles
    // would open a second database and leak the first service's.
    if (launching || initialized) return
    setLaunching(true)
    setStatus('Initializing memory…')
    try {
      const adapter = await SqlJsAdapter.create()
      const service = new WikiService(adapter, { generateText: geminiGenerateText(() => apiKeyRef.current) })
      await service.init()
      setWiki(service)
      setToolWiki(service)
      setInitialized(true)
      setStatus('ScopeLab ready. Ask a question or open the memory panel.')
    } catch (error) {
      setStatus(`Initialization failed: ${errorMessage(error)}`)
    } finally {
      setLaunching(false)
    }
  }

  const handleSend = async () => {
    // One turn at a time: a second concurrent send would run chatWithMemory
    // against the same stale `history` closure and double-spend on
    // consolidation.
    if (sending || !wiki || !apiKey.trim() || !message.trim()) return
    setSending(true)
    setStatus('Querying Gemini…')
    const userMessage = message.trim()
    setMessage('')
    // Give the message back for a retry, unless the user has already started
    // typing a new one while this turn was in flight.
    const restoreMessage = () => setMessage(current => (current.trim() ? current : userMessage))
    try {
      // `history` excludes this turn: chatWithMemory appends userMessage.
      const result = await chatWithMemory({
        userMessage,
        tools,
        enabledScopes,
        apiKey: apiKey.trim(),
        wiki,
        history,
      })
      setResponse(result.response)
      // Commit the pair only on a real answer, so a failed or status-only
      // turn never replays as two user turns or a placeholder model turn.
      if (result.stored) {
        setHistory(prev => [
          ...prev,
          { role: 'user', content: userMessage },
          { role: 'assistant', content: result.response },
        ])
        // Turn the new messages into facts so search_memory can find them.
        // This is one or more Gemini calls on the developer's key —
        // extraction, plus a resolve pass whenever a fact is ambiguous —
        // after the answer is already on screen.
        setStatus('Received response. Saving to memory…')
        try {
          await wiki.consolidate()
          setStatus('Received response. Memory updated.')
        } catch (error) {
          setStatus(`Received response, but saving to memory failed: ${errorMessage(error)}`)
        }
      } else {
        restoreMessage()
        setStatus('No answer from Gemini; see the response box.')
      }
    } catch (error) {
      restoreMessage()
      setStatus(`Chat failed: ${errorMessage(error)}`)
    } finally {
      setSending(false)
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
          <button onClick={launchApp} disabled={initialized || launching}>
            {initialized ? 'Memory initialized' : launching ? 'Initializing…' : 'Initialize ScopeLab'}
          </button>
          <div className="hint">
            The app keeps memory in-browser using sql.js and lets you enable scoped tool access. After each answer, one or more Gemini calls on your key turn the chat into facts that search_memory can find.
          </div>
          <div className="tool-toggle">
            <ScopeToggle tools={tools} enabledScopes={enabledScopes} onToggle={setEnabledScopes} />
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
          <button onClick={handleSend} disabled={sending || !initialized || !message.trim()}>
            {sending ? 'Sending…' : 'Send'}
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

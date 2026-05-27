import { useState } from 'react'
import { useWikiWrite } from '@equationalapplications/react-llm-wiki'
import { CodeBlock } from './CodeBlock'

const CODE = `const { execute, isPending, error } = useWikiWrite()

await execute('user-1', {
  event_type: 'observation',  // 'observation' | 'decision' | 'action' | 'outcome'
  summary: 'User prefers TypeScript over JavaScript',
})

// Events accumulate; librarian auto-runs after
// config.autoLibrarianThreshold (default: 20) events
// to synthesize them into WikiFacts.`

const EVENT_TYPES = ['observation', 'decision', 'action', 'outcome'] as const

export function WriteTab() {
  const [entityId, setEntityId] = useState('user-1')
  const [summary, setSummary] = useState('')
  const [eventType, setEventType] = useState<(typeof EVENT_TYPES)[number]>(EVENT_TYPES[0])
  const [log, setLog] = useState<Array<{ id: number; ts: string; msg: string; ok: boolean }>>([])

  const { execute, isPending, error } = useWikiWrite()

  const handleWrite = async () => {
    if (!summary.trim()) return
    try {
      await execute(entityId, {
        event_type: eventType,
        summary,
      })
      setLog(l => [{ id: Date.now(), ts: new Date().toLocaleTimeString(), msg: summary, ok: true }, ...l.slice(0, 9)])
      setSummary('')
    } catch (e) {
      setLog(l => [{ id: Date.now(), ts: new Date().toLocaleTimeString(), msg: `Error: ${(e as Error).message}`, ok: false }, ...l.slice(0, 9)])
    }
  }

  return (
    <div className="tab-content">
      <div className="hook-header">
        <span className="hook-badge">hook</span>
        <h2>useWikiWrite</h2>
        <p>Record raw observations and events. The librarian job synthesizes them into structured facts automatically.</p>
      </div>

      <div className="panel-grid">
        <div className="panel">
          <h3>Write an Event</h3>
          <div className="field-group">
            <label htmlFor="write-entity-id">Entity ID</label>
            <input id="write-entity-id" value={entityId} onChange={e => setEntityId(e.target.value)} />
          </div>
          <div className="field-group">
            <label>Event Type</label>
            <div className="pill-select">
              {EVENT_TYPES.map(t => (
                <button
                  key={t}
                  className={`pill ${eventType === t ? 'active' : ''}`}
                  onClick={() => setEventType(t)}
                >{t}</button>
              ))}
            </div>
          </div>
          <div className="field-group">
            <label htmlFor="write-summary">Summary</label>
            <textarea
              id="write-summary"
              rows={3}
              value={summary}
              onChange={e => setSummary(e.target.value)}
              placeholder="e.g. User prefers dark mode and uses vim keybindings"
              onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleWrite() }}
            />
            <span className="hint">⌘+Enter to submit</span>
          </div>

          <div className="quick-inserts">
            <span className="hint">Quick examples:</span>
            {[
              'User prefers TypeScript over JavaScript',
              'User works at a startup building dev tools',
              'User is learning Rust in their spare time',
              'User dislikes meetings before 10am',
            ].map(ex => (
              <button key={ex} className="pill" onClick={() => setSummary(ex)}>{ex}</button>
            ))}
          </div>

          <button className="btn-primary" onClick={handleWrite} disabled={isPending || !summary.trim()}>
            {isPending ? '⟳ Writing…' : '→ Write Event'}
          </button>
          {error && <div className="status error">✗ {error.message}</div>}
        </div>

        <div className="panel">
          <h3>Write Log</h3>
          {log.length === 0 && <div className="empty">No writes yet.</div>}
          <div className="log-list">
            {log.map((entry) => (
              <div key={entry.id} className={`log-entry ${entry.ok ? 'ok' : 'err'}`}>
                <span className="log-time">{entry.ts}</span>
                <span className="log-msg">{entry.msg}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <CodeBlock code={CODE} />
    </div>
  )
}

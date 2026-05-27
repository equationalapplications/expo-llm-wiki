import { useState } from 'react'
import { useMemoryRead } from '@equationalapplications/react-llm-wiki'
import { CodeBlock } from './CodeBlock'

const CODE = `const { data, isPending, error, refetch } = useMemoryRead(
  entityId,   // string | string[]
  query,      // semantic search query
  {
    maxResults: 10,
    hybridWeight: 0.7,  // blend semantic + keyword
  }
)

// data?.facts  — WikiFact[]
// data?.tasks  — WikiTask[]
// data?.events — WikiEvent[]`

export function ReadTab() {
  const [entityId, setEntityId] = useState('user-1')
  const [query, setQuery] = useState('')
  const [maxResults, setMaxResults] = useState(10)
  const [hybridWeight, setHybridWeight] = useState(0.7)
  const [committed, setCommitted] = useState({ entityId: 'user-1', query: '' })

  const { data, isPending, error, refetch } = useMemoryRead(
    committed.entityId,
    committed.query,
    { maxResults, hybridWeight }
  )

  return (
    <div className="tab-content">
      <div className="hook-header">
        <span className="hook-badge">hook</span>
        <h2>useMemoryRead</h2>
        <p>Reactively read facts, tasks, and events from the wiki. Auto-refetches when inputs change.</p>
      </div>

      <div className="panel-grid">
        <div className="panel">
          <h3>Parameters</h3>
          <div className="field-group">
            <label>Entity ID</label>
            <input
              value={entityId}
              onChange={e => setEntityId(e.target.value)}
              placeholder="user-1"
            />
          </div>
          <div className="field-group">
            <label>Query <span className="hint">(empty = fetch all)</span></label>
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="e.g. programming preferences"
            />
          </div>
          <div className="field-group">
            <label>Max Results: <strong>{maxResults}</strong></label>
            <input
              type="range" min={1} max={50} value={maxResults}
              onChange={e => setMaxResults(Number(e.target.value))}
            />
          </div>
          <div className="field-group">
            <label>
              Hybrid Weight: <strong>{hybridWeight}</strong>
              <span className="hint"> (0=keyword, 1=semantic)</span>
            </label>
            <input
              type="range" min={0} max={1} step={0.1} value={hybridWeight}
              onChange={e => setHybridWeight(Number(e.target.value))}
            />
          </div>
          <button
            className="btn-primary"
            onClick={() => setCommitted({ entityId, query })}
          >
            Apply & Read
          </button>
        </div>

        <div className="panel">
          <h3>Live Result</h3>
          {isPending && <div className="status pending">⟳ Loading…</div>}
          {error && <div className="status error">✗ {error.message}</div>}
          {!isPending && !error && (
            <div className="result-summary">
              <div className="counts">
                <span className="count-badge fact">{data?.facts?.length ?? 0} facts</span>
                <span className="count-badge task">{data?.tasks?.length ?? 0} tasks</span>
                <span className="count-badge event">{data?.events?.length ?? 0} events</span>
              </div>
              <button className="btn-ghost" onClick={refetch}>↺ Refetch</button>
            </div>
          )}

          {data?.facts && data.facts.length > 0 && (
            <div className="fact-list">
              {data.facts.map(f => (
                <div key={f.id} className={`fact-card conf-${f.confidence}`}>
                  <div className="fact-title">{f.title}</div>
                  <div className="fact-body">{f.body}</div>
                  <div className="fact-meta">
                    <span className={`confidence ${f.confidence}`}>{f.confidence}</span>
                    {f.tags?.length > 0 && (
                      <span className="tags">{(f.tags as string[]).join(', ')}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {data?.facts?.length === 0 && !isPending && (
            <div className="empty">No facts found. Write some memories first!</div>
          )}
        </div>
      </div>

      <CodeBlock code={CODE} />
    </div>
  )
}

import { useState } from 'react'
import { useWikiExport, formatMemoryDump } from '@equationalapplications/react-llm-wiki'
import type { MemoryBundle } from '@equationalapplications/react-llm-wiki'
import { CodeBlock } from './CodeBlock'

const CODE = `const { execute, lastResult, isPending, error } = useWikiExport()

// Export all entities
const dump = await execute()

// Export specific entities
const dump = await execute(['user-1', 'user-2'])

// dump.entities: Record<string, MemoryBundle>
// dump.generatedAt: number (milliseconds since epoch, i.e. Date.now())

// Formatted output (manifest + per-entity markdown files)
const formatted = formatMemoryDump(dump)
// formatted.manifest  — table of contents
// formatted.files     — Array<{ name, content }>`

export function ExportTab() {
  const [entityIds, setEntityIds] = useState('user-1')
  const [view, setView] = useState<'summary' | 'formatted' | 'raw'>('summary')

  const { execute, lastResult, isPending, error } = useWikiExport()

  const handleExport = async () => {
    const ids = entityIds.trim() ? entityIds.split(',').map(s => s.trim()).filter(Boolean) : undefined
    try {
      await execute(ids)
    } catch {
      // error displayed via hook's error state
    }
  }

  const formatted = lastResult ? formatMemoryDump(lastResult) : null
  const entityEntries = lastResult ? Object.entries(lastResult.entities) : []

  return (
    <div className="tab-content">
      <div className="hook-header">
        <span className="hook-badge">hook</span>
        <h2>useWikiExport</h2>
        <p>Export the full memory dump for backup, debugging, or migration. Includes facts, tasks, and events per entity.</p>
      </div>

      <div className="panel-grid">
        <div className="panel">
          <h3>Export</h3>
          <div className="field-group">
            <label>Entity IDs <span className="hint">(comma-separated, empty = all)</span></label>
            <input
              value={entityIds}
              onChange={e => setEntityIds(e.target.value)}
              placeholder="user-1, user-2"
            />
          </div>
          <button className="btn-primary" onClick={handleExport} disabled={isPending}>
            {isPending ? '⟳ Exporting…' : '↓ Export Dump'}
          </button>
          {error && <div className="status error">✗ {error.message}</div>}

          {lastResult && (
            <div className="result-card">
              <div className="result-row">
                <span>Generated at</span>
                <strong>{new Date(lastResult.generatedAt).toLocaleTimeString()}</strong>
              </div>
              <div className="result-row">
                <span>Total entities</span>
                <strong>{entityEntries.length}</strong>
              </div>
              <div className="result-row">
                <span>Total facts</span>
                <strong>
                  {entityEntries.reduce((n, [, bundle]) => n + ((bundle as MemoryBundle).facts?.length ?? 0), 0)}
                </strong>
              </div>
              <div className="result-row">
                <span>Total tasks</span>
                <strong>
                  {entityEntries.reduce((n, [, bundle]) => n + ((bundle as MemoryBundle).tasks?.length ?? 0), 0)}
                </strong>
              </div>
              <button
                className="btn-ghost"
                onClick={() => {
                  const blob = new Blob([JSON.stringify(lastResult, null, 2)], { type: 'application/json' })
                  const url = URL.createObjectURL(blob)
                  const a = document.createElement('a')
                  a.href = url
                  a.download = 'wiki-dump.json'
                  a.click()
                  URL.revokeObjectURL(url)
                }}
              >
                ↓ Download JSON
              </button>
            </div>
          )}
        </div>

        <div className="panel">
          <h3>
            Dump Viewer
            {lastResult && (
              <div className="view-toggle">
                {(['summary', 'formatted', 'raw'] as const).map(v => (
                  <button key={v} className={`pill ${view === v ? 'active' : ''}`} onClick={() => setView(v)}>
                    {v}
                  </button>
                ))}
              </div>
            )}
          </h3>

          {!lastResult && <div className="empty">Run an export to see the dump.</div>}

          {lastResult && view === 'summary' && (
            <div className="dump-summary">
              {entityEntries.length === 0 && <div className="empty">No entities exported.</div>}
              {entityEntries.map(([entityId, bundle]) => {
                const b = bundle as MemoryBundle
                return (
                  <div key={entityId} className="dump-entity">
                    <div className="dump-entity-header">{entityId}</div>
                    {b.facts && b.facts.length > 0 && (
                      <div className="dump-section">
                        <strong>Facts ({b.facts.length})</strong>
                        {b.facts.map((f) => (
                          <div key={f.id} className="dump-fact">
                            <span className={`confidence ${f.confidence}`}>{f.confidence}</span>
                            <span className="dump-fact-title">{f.title}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {b.tasks && b.tasks.length > 0 && (
                      <div className="dump-section">
                        <strong>Tasks ({b.tasks.length})</strong>
                        {b.tasks.map((t) => (
                          <div key={t.id} className="dump-task">{t.description}</div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {lastResult && view === 'formatted' && formatted && (
            <div className="dump-summary">
              <div className="dump-entity">
                <div className="dump-entity-header">manifest.md</div>
                <pre className="json-view" style={{ margin: 8 }}>{formatted.manifest}</pre>
              </div>
              {formatted.files.map((f) => (
                <div key={f.name} className="dump-entity">
                  <div className="dump-entity-header">{f.name}</div>
                  <pre className="json-view" style={{ margin: 8 }}>{f.content}</pre>
                </div>
              ))}
            </div>
          )}

          {lastResult && view === 'raw' && (
            <pre className="json-view">{JSON.stringify(lastResult, null, 2)}</pre>
          )}
        </div>
      </div>

      <CodeBlock code={CODE} />
    </div>
  )
}

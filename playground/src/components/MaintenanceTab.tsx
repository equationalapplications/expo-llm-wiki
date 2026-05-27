import { useState } from 'react'
import { useWikiMaintenance, useWikiForget } from '@equationalapplications/react-llm-wiki'
import { CodeBlock } from './CodeBlock'

const MAINTENANCE_CODE = `const {
  runLibrarian, runHeal, runReembed, runPrune,
  isPending, error, lastResult
} = useWikiMaintenance()

// Synthesize events → facts
await runLibrarian('user-1')

// LLM-driven fact review (orphan removal, downgrade stale)
await runHeal('user-1')

// Hard-delete soft-deleted entries after retention window
await runPrune('user-1')`

const FORGET_CODE = `const { execute, lastResult, isPending, error } = useWikiForget()

// Forget a specific fact by ID
await execute('user-1', { entryId: 'fact-uuid' })

// Forget all facts from a source document
await execute('user-1', { sourceRef: 'doc-readme' })

// Nuclear option: clear everything for an entity
await execute('user-1', { clearAll: true })`

export function MaintenanceTab() {
  const [entityId, setEntityId] = useState('user-1')
  const [forgetMode, setForgetMode] = useState<'entryId' | 'sourceRef' | 'clearAll'>('clearAll')
  const [forgetValue, setForgetValue] = useState('')
  const [log, setLog] = useState<Array<{ id: number; ts: string; msg: string; ok: boolean }>>([])

  const { runLibrarian, runHeal, runPrune, isPending, error } = useWikiMaintenance()
  const forget = useWikiForget()

  const addLog = (msg: string, ok: boolean) =>
    setLog(l => [{ id: Date.now(), ts: new Date().toLocaleTimeString(), msg, ok }, ...l.slice(0, 14)])

  const run = async (label: string, fn: () => Promise<unknown>) => {
    try {
      const result = await fn()
      addLog(`${label} completed${result ? `: ${JSON.stringify(result)}` : ''}`, true)
    } catch (e) {
      addLog(`${label} failed: ${(e as Error).message}`, false)
    }
  }

  const handleForget = async () => {
    const params =
      forgetMode === 'clearAll'
        ? { clearAll: true as const }
        : forgetMode === 'entryId'
        ? { entryId: forgetValue }
        : { sourceRef: forgetValue }
    try {
      const result = await forget.execute(entityId, params)
      addLog(`Forget: deleted ${result.deleted.entries} entries, ${result.deleted.tasks} tasks`, true)
    } catch (e) {
      addLog(`Forget failed: ${(e as Error).message}`, false)
    }
  }

  return (
    <div className="tab-content">
      <div className="hook-header">
        <span className="hook-badge hook-badge--multi">hooks</span>
        <h2>useWikiMaintenance + useWikiForget</h2>
        <p>Run background jobs to synthesize, heal, and prune the wiki. Delete specific facts or entire entities.</p>
      </div>

      <div className="panel-grid panel-grid--3">
        {/* Maintenance jobs */}
        <div className="panel">
          <h3>Maintenance Jobs</h3>
          <div className="field-group">
            <label>Entity ID</label>
            <input value={entityId} onChange={e => setEntityId(e.target.value)} />
          </div>

          <div className="job-list">
            <div className="job-card">
              <div className="job-info">
                <strong>Librarian</strong>
                <p>Synthesizes accumulated events into structured facts. Auto-runs after 5 events.</p>
              </div>
              <button
                className="btn-job"
                disabled={isPending}
                onClick={() => run('Librarian', () => runLibrarian(entityId))}
              >Run</button>
            </div>

            <div className="job-card">
              <div className="job-info">
                <strong>Heal</strong>
                <p>LLM reviews facts: removes orphans, downgrades stale inferences, fixes errors.</p>
              </div>
              <button
                className="btn-job"
                disabled={isPending}
                onClick={() => run('Heal', () => runHeal(entityId))}
              >Run</button>
            </div>

            <div className="job-card">
              <div className="job-info">
                <strong>Prune</strong>
                <p>Hard-deletes soft-deleted entries past retention window (default 7 days).</p>
              </div>
              <button
                className="btn-job"
                disabled={isPending}
                onClick={() => run('Prune', () => runPrune(entityId))}
              >Run</button>
            </div>
          </div>

          {isPending && <div className="status pending">⟳ Running job…</div>}
          {error && <div className="status error">✗ {error.message}</div>}
        </div>

        {/* Forget */}
        <div className="panel">
          <h3>Forget</h3>
          <div className="field-group">
            <label>Mode</label>
            <div className="pill-select">
              {(['clearAll', 'entryId', 'sourceRef'] as const).map(m => (
                <button
                  key={m}
                  className={`pill ${forgetMode === m ? 'active' : ''}`}
                  onClick={() => setForgetMode(m)}
                >{m}</button>
              ))}
            </div>
          </div>

          {forgetMode !== 'clearAll' && (
            <div className="field-group">
              <label>{forgetMode === 'entryId' ? 'Fact ID' : 'Source Reference'}</label>
              <input
                value={forgetValue}
                onChange={e => setForgetValue(e.target.value)}
                placeholder={forgetMode === 'entryId' ? 'abc-123-...' : 'doc-readme'}
              />
            </div>
          )}

          {forgetMode === 'clearAll' && (
            <div className="status warn">⚠ This soft-deletes ALL facts for the entity.</div>
          )}

          <button
            className="btn-danger"
            onClick={handleForget}
            disabled={forget.isPending || (forgetMode !== 'clearAll' && !forgetValue.trim())}
          >
            {forget.isPending ? '⟳ Deleting…' : '✕ Forget'}
          </button>
          {forget.error && <div className="status error">✗ {forget.error.message}</div>}
          {forget.lastResult && (
            <div className="status ok">
              ✓ Deleted {forget.lastResult.deleted.entries} entries, {forget.lastResult.deleted.tasks} tasks
            </div>
          )}
        </div>

        {/* Log */}
        <div className="panel">
          <h3>Operation Log</h3>
          {log.length === 0 && <div className="empty">No operations yet.</div>}
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

      <div className="code-pair">
        <CodeBlock code={MAINTENANCE_CODE} label="useWikiMaintenance" />
        <CodeBlock code={FORGET_CODE} label="useWikiForget" />
      </div>
    </div>
  )
}

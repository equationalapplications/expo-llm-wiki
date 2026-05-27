import { useState } from 'react'
import { useWikiIngest } from '@equationalapplications/react-llm-wiki'
import { CodeBlock } from './CodeBlock'

const CODE = `const { execute, lastResult, isPending, error } = useWikiIngest()

await execute('user-1', {
  sourceRef: 'doc-readme',        // stable identifier for the source
  sourceHash: await hash(text),   // change-detection hash
  documentChunk: text,            // the document content
  // promptOverride: '...',       // optional: override extraction prompt
})

// lastResult: { truncated: boolean, chunks: number }`

const SAMPLE_DOCS: Record<string, string> = {
  'README': `# LLM Wiki Memory System

A persistent memory layer for AI agents inspired by Andrej Karpathy's LLM Wiki spec.

## Core Concepts

**Entities** are namespaces (e.g. user IDs, agent IDs) that own their memories independently.

**Facts** are structured knowledge: title, body, confidence level (certain/inferred/tentative), and optional tags.

**Events** are raw observations that feed the Librarian job, which synthesizes them into facts.

**Tasks** are action items extracted during librarian synthesis.

## Architecture

The system uses a two-phase retrieval pipeline:
1. MiniSearch keyword pre-filtering (fast)
2. Cosine similarity scoring on embedding vectors (semantic)

Hybrid scoring blends both signals via a configurable hybridWeight parameter.`,

  'User Profile': `# User Profile: Alex

Alex is a senior software engineer with 8 years of experience.

## Technical Preferences
- Primary languages: TypeScript, Python, Go
- Prefers functional programming patterns
- Uses Neovim with vim motions
- Prefers dark themes (Tokyo Night)
- Runs macOS on Apple Silicon

## Work Style
- Deep work sessions from 9am-12pm (no meetings)
- Afternoon for code reviews and collaboration
- Works remotely 4 days/week, 1 day at office

## Current Projects
- Building a developer productivity tool using AI
- Learning Rust for systems programming
- Contributing to open-source TypeScript tooling`,
}

async function simpleHash(text: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(text)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16)
}

export function IngestTab() {
  const [entityId, setEntityId] = useState('user-1')
  const [sourceRef, setSourceRef] = useState('doc-readme')
  const [docText, setDocText] = useState(SAMPLE_DOCS['README'])
  const [selectedSample, setSelectedSample] = useState('README')

  const { execute, lastResult, isPending, error } = useWikiIngest()

  const handleIngest = async () => {
    const sourceHash = await simpleHash(docText)
    await execute(entityId, { sourceRef, sourceHash, documentChunk: docText })
  }

  const loadSample = (name: string) => {
    setSelectedSample(name)
    setDocText(SAMPLE_DOCS[name])
    setSourceRef(`doc-${name.toLowerCase().replace(/\s+/g, '-')}`)
  }

  return (
    <div className="tab-content">
      <div className="hook-header">
        <span className="hook-badge">hook</span>
        <h2>useWikiIngest</h2>
        <p>Parse and extract structured facts from documents. The LLM chunks the text and extracts facts/tasks automatically.</p>
      </div>

      <div className="panel-grid">
        <div className="panel">
          <h3>Ingest a Document</h3>
          <div className="field-group">
            <label>Entity ID</label>
            <input value={entityId} onChange={e => setEntityId(e.target.value)} />
          </div>
          <div className="field-group">
            <label>Source Reference <span className="hint">(stable ID for change detection)</span></label>
            <input value={sourceRef} onChange={e => setSourceRef(e.target.value)} />
          </div>
          <div className="field-group">
            <label>Sample Documents</label>
            <div className="pill-select">
              {Object.keys(SAMPLE_DOCS).map(name => (
                <button
                  key={name}
                  className={`pill ${selectedSample === name ? 'active' : ''}`}
                  onClick={() => loadSample(name)}
                >{name}</button>
              ))}
            </div>
          </div>
          <div className="field-group">
            <label>Document Content</label>
            <textarea
              rows={10}
              value={docText}
              onChange={e => setDocText(e.target.value)}
            />
          </div>
          <button className="btn-primary" onClick={handleIngest} disabled={isPending || !docText.trim()}>
            {isPending ? '⟳ Ingesting with LLM…' : '→ Ingest Document'}
          </button>
          {error && <div className="status error">✗ {error.message}</div>}
        </div>

        <div className="panel">
          <h3>Ingest Result</h3>
          {lastResult ? (
            <div className="result-card">
              <div className="result-row">
                <span>Chunks processed</span>
                <strong>{lastResult.chunks}</strong>
              </div>
              <div className="result-row">
                <span>Truncated</span>
                <strong>{lastResult.truncated ? 'Yes' : 'No'}</strong>
              </div>
              <div className="status ok">✓ Document ingested. Facts extracted and stored.</div>
              <p className="hint">Switch to the Read tab to query the extracted facts.</p>
            </div>
          ) : (
            <div className="empty">No ingest run yet.</div>
          )}

          <div className="info-box">
            <h4>How it works</h4>
            <ol>
              <li>Document is chunked (default 12,000 chars with 400-char overlap)</li>
              <li>Each chunk is sent to the LLM with the ingest system prompt</li>
              <li>LLM extracts <code>facts</code> and optionally <code>tasks</code></li>
              <li>Results are stored with <code>source_type: "immutable_document"</code></li>
              <li>Re-ingesting the same <code>sourceHash</code> is a no-op</li>
            </ol>
          </div>
        </div>
      </div>

      <CodeBlock code={CODE} />
    </div>
  )
}

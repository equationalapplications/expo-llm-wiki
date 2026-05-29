import { useState } from 'react'
import type { AgentToolManifest } from '@equationalapplications/core-llm-tools'

interface ScopeToggleProps {
  tools: AgentToolManifest[]
  enabledScopes: string[]
  onToggle: (scopes: string[]) => void
}

export function ScopeToggle({ tools, enabledScopes, onToggle }: ScopeToggleProps) {
  const [localScopes, setLocalScopes] = useState(new Set(enabledScopes))

  const toggleScope = (scope: string) => {
    const next = new Set(localScopes)
    if (next.has(scope)) next.delete(scope)
    else next.add(scope)
    setLocalScopes(next)
    onToggle(Array.from(next))
  }

  const scopesByCategory = tools.reduce((acc, tool) => {
    const [category] = tool.scope.split(':')
    if (!acc[category]) acc[category] = new Set<string>()
    acc[category].add(tool.scope)
    return acc
  }, {} as Record<string, Set<string>>)

  return (
    <div className="scope-toggle-card">
      <h3>Capability Scopes</h3>
      <p>Toggle which abilities the AI can access. Changes apply immediately.</p>
      {Object.entries(scopesByCategory).map(([category, scopes]) => (
        <div key={category} className="scope-group">
          <h4>{category}</h4>
          <div className="scope-items">
            {Array.from(scopes).map(scope => (
              <label key={scope} className="scope-label">
                <input
                  type="checkbox"
                  checked={localScopes.has(scope)}
                  onChange={() => toggleScope(scope)}
                />
                <span>{scope}</span>
              </label>
            ))}
          </div>
        </div>
      ))}
      <div className="scope-actions">
        <button
          type="button"
          onClick={() => {
            const all = tools.map(t => t.scope)
            setLocalScopes(new Set(all))
            onToggle(all)
          }}
        >
          Enable all
        </button>
        <button
          type="button"
          onClick={() => {
            setLocalScopes(new Set())
            onToggle([])
          }}
        >
          Disable all
        </button>
      </div>
    </div>
  )
}

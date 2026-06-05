import type { AgentToolManifest } from '@equationalapplications/core-llm-tools'

let wikiInstance: { getContext(query: string): Promise<string> } | null = null

export function setToolWiki(wiki: { getContext(query: string): Promise<string> }): void {
  wikiInstance = wiki
}

export async function executeTool(tool: AgentToolManifest, args: Record<string, unknown>): Promise<unknown> {
  if (tool.name === 'search_memory') {
    const query = (args.query as string) ?? ''
    if (wikiInstance) {
      const context = await wikiInstance.getContext(query)
      return { result: context || 'No relevant memories found.', query }
    }
    return { result: `Search executed for query: ${query}`, query }
  }

  throw new Error(`Unknown tool: ${tool.name}. No handler registered.`)
}

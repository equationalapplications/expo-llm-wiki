import { WikiMemory } from '@equationalapplications/core-llm-wiki'
import type { SQLiteAdapter } from '../database/sqljs-adapter'
import { SqlJsAdapter } from '../database/sqljs-adapter'

export class WikiService {
  private wiki: WikiMemory
  private readonly entityId = 'scopelab-user'

  constructor(adapter: SQLiteAdapter) {
    this.wiki = new WikiMemory(adapter, {
      config: {
        autoLibrarianThreshold: 10,
        autoHealThreshold: 30,
      },
    })
  }

  async init(): Promise<void> {
    await this.wiki.setup()
  }

  async remember(message: string, metadata?: Record<string, unknown>): Promise<void> {
    await this.wiki.write(this.entityId, {
      event_type: 'user_message',
      summary: message,
      metadata,
    })
  }

  async getContext(query: string, maxFacts = 5): Promise<string> {
    const memory = await this.wiki.read(this.entityId, query, {
      maxResults: maxFacts,
      hybridWeight: 0.7,
    })
    const contextParts = memory.facts?.map((fact: any) =>
      `• ${fact.title || fact.summary || 'Fact'}: ${fact.body || fact.summary || ''}${fact.tags?.length ? ` [${fact.tags.join(', ')}]` : ''}`,
    )
    return contextParts?.length ? `Relevant memory:\n${contextParts.join('\n')}\n\n` : ''
  }

  async listFacts(limit = 20) {
    const memory = await this.wiki.read(this.entityId, '', { maxResults: limit })
    return memory.facts || []
  }

  async persist(): Promise<Uint8Array> {
    return (this.wiki as any).adapter?.export?.() ?? new Uint8Array()
  }
}

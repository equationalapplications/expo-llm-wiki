import { WikiMemory } from '@equationalapplications/core-llm-wiki'
import type { LLMProvider } from '@equationalapplications/core-llm-wiki'
import type { SQLiteAdapter } from '../database/sqljs-adapter'

/**
 * ScopeLab has no maintenance LLM. `WikiOptions.llmProvider` is required:
 * without one, every non-empty `read()` threw on `llmProvider.embed`. This
 * provider has no `embed`, so reads use keyword search, and its
 * `generateText` fails loudly if anything ever runs the librarian.
 */
const noMaintenanceLlm: LLMProvider = {
  generateText: async () => {
    throw new Error('ScopeLab has no maintenance LLM: run the librarian from a host with an LLM provider.')
  },
}

export class WikiService {
  private wiki: WikiMemory
  private readonly entityId = 'scopelab-user'

  constructor(adapter: SQLiteAdapter) {
    // `maintenance` is left to the engine default (deferred): the old
    // `'auto'` setting ran the librarian every 10 events, and with no LLM
    // every pass failed and logged an error.
    this.wiki = new WikiMemory(adapter, { llmProvider: noMaintenanceLlm })
  }

  async init(): Promise<void> {
    await this.wiki.setup()
  }

  /** Append a chat event. `occurredAt` is when it happened (e.g. when the user sent it). */
  async remember(message: string, opts: { occurredAt?: number } = {}): Promise<void> {
    await this.wiki.write(this.entityId, {
      event_type: 'observation',
      summary: message,
      ...(opts.occurredAt !== undefined ? { occurred_at: opts.occurredAt } : {}),
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
    const adapter = (this.wiki as any).adapter
    if (!adapter || typeof adapter.export !== 'function') {
      throw new Error('Persistence adapter/export unavailable for WikiService.persist')
    }
    return adapter.export()
  }
}

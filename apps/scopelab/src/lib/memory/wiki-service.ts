import { WikiMemory } from '@equationalapplications/core-llm-wiki'
import type { LLMProvider } from '@equationalapplications/core-llm-wiki'
import type { SQLiteAdapter } from '../database/sqljs-adapter'

/** Stands in when no maintenance model is given; `consolidate()` never calls it. */
const noMaintenanceLlm: LLMProvider['generateText'] = async () => {
  throw new Error('ScopeLab has no maintenance LLM.')
}

export class WikiService {
  private wiki: WikiMemory
  private readonly entityId = 'scopelab-user'
  private readonly canConsolidate: boolean
  private consolidating: Promise<unknown> = Promise.resolve()

  /**
   * `generateText` is the maintenance model that turns chat events into
   * facts. The provider has no `embed`, so reads use keyword search (without
   * an `llmProvider` at all, every non-empty `read()` threw).
   */
  constructor(adapter: SQLiteAdapter, opts: { generateText?: LLMProvider['generateText'] } = {}) {
    this.canConsolidate = opts.generateText !== undefined
    // `maintenance` stays at the engine default (deferred): `consolidate()`
    // runs the librarian once per answered turn instead of every N writes.
    this.wiki = new WikiMemory(adapter, { llmProvider: { generateText: opts.generateText ?? noMaintenanceLlm } })
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

  /**
   * Turn the chat events written so far into facts, so `getContext` and the
   * `search_memory` tool can find them. Resolves false when there is no
   * maintenance model. Calls are serialized: the librarian takes a
   * per-entity lock, so an overlapping run would otherwise throw.
   */
  consolidate(): Promise<boolean> {
    if (!this.canConsolidate) return Promise.resolve(false)
    const run = this.consolidating.then(async () => {
      await this.wiki.runLibrarian(this.entityId)
      return true
    })
    this.consolidating = run.catch(() => undefined)
    return run
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

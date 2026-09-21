import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { LLMProvider, WikiFact } from '../src/types';

/** A class-based provider whose methods depend on `this`, as SDK wrappers commonly do. */
class ClassProvider implements LLMProvider {
  readonly embedded: string[] = [];
  private readonly dims = [0.6, 0.8];
  async generateText(): Promise<string> {
    return '{}';
  }
  async embed(text: string): Promise<number[]> {
    this.embedded.push(text);
    return [...this.dims];
  }
}

function fact(id: string, title: string): WikiFact {
  return {
    id, entity_id: 'e1', title, body: `${title} body`, tags: [], confidence: 'certain',
    source_type: 'user_stated', source_hash: null, source_ref: null,
    created_at: 1, updated_at: 1, last_accessed_at: null, access_count: 0, deleted_at: null,
  };
}

describe('class-based LLMProvider keeps its this binding', () => {
  it('embed() is called with the provider as this when storing and when querying', async () => {
    const provider = new ClassProvider();
    const db = openTestDatabase();
    const wiki = new WikiMemory(db, { llmProvider: provider });
    await wiki.setup();
    await wiki.importDump({ generatedAt: 1, entities: { e1: { facts: [fact('f1', 'Apple')], tasks: [], events: [], edges: [] } } });

    const stored = await db.getFirstAsync<{ embedding_blob: Uint8Array | null }>(
      'SELECT embedding_blob FROM llm_wiki_entries WHERE id = ?', ['f1'],
    );
    expect(stored?.embedding_blob).toBeTruthy();

    const result = await wiki.read('e1', 'apple');
    expect(provider.embedded).toContain('apple');
    expect(result.facts.map((f) => f.id)).toEqual(['f1']);
  });
});

import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { MemoryDump, WikiDiagnostic } from '../src/types';

// specs/import-diagnostics-after-commit §Test plan (issue #473).

const P = 'llm_wiki_';
const H = (c: string): string => c.repeat(64);

function mk(config?: unknown, onEmit?: (d: WikiDiagnostic, db: ReturnType<typeof openTestDatabase>) => void | Promise<void>) {
  const db = openTestDatabase();
  const diagnostics: WikiDiagnostic[] = [];
  const wiki = new WikiMemory(db, {
    llmProvider: { generateText: async () => '{}' },
    config,
    onDiagnostic: (d: WikiDiagnostic) => { diagnostics.push(d); void onEmit?.(d, db); },
  } as any);
  return { db, wiki, diagnostics };
}

const fact = (entityId: string, id: string, extra: Record<string, unknown> = {}) => ({
  id, entity_id: entityId, title: `Title ${id}`, body: `Body ${id} content`, tags: [], confidence: 'certain',
  source_type: 'immutable_document', source_hash: null, source_ref: 'doc.md',
  created_at: 1000, updated_at: 1000, last_accessed_at: null, access_count: 0, deleted_at: null, ...extra,
});
const src = (ref: string, text: string) => ({ sourceRef: ref, sourceHash: H('a'), text, textHash: 'x', charCount: text.length, storedAt: 1, passages: [] });
const badSrc = { sourceRef: '', sourceHash: '', text: 'x', textHash: 'x', charCount: 1, storedAt: 1, passages: [] };
const ent = (facts: unknown[], storedSources?: unknown[]) => ({ facts, tasks: [], events: [], ...(storedSources ? { storedSources } : {}) });
const count = async (db: ReturnType<typeof openTestDatabase>) =>
  Number((await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${P}entries`))!.n);

describe('import diagnostics are emitted only after commit (#473)', () => {
  it('1. a rolled-back import emits nothing', async () => {
    const { db, wiki, diagnostics } = mk();
    await wiki.setup();
    const dump = { generatedAt: 1, entities: { e: ent([fact('e', 'a', { source_pointer: { event_id: 42, oops: true } }), fact('e', 'b')], [badSrc]) } } as unknown as MemoryDump;
    await expect(wiki.importDump(dump)).rejects.toThrow(/invalid stored source/);
    expect(diagnostics).toEqual([]);
    expect(await count(db)).toBe(0);
  });

  it('2. success still emits once, after commit (fact readable at emit time)', async () => {
    const seen: Array<Promise<number>> = [];
    const { db, wiki, diagnostics } = mk(undefined, (d, d2) => {
      if (d.code === 'source_pointer_invalid') seen.push(count(d2));
    });
    await wiki.setup();
    await wiki.importDump({ generatedAt: 1, entities: { e: ent([fact('e', 'a', { source_pointer: { bad: true } })]) } } as unknown as MemoryDump);
    const bad = diagnostics.filter((d) => d.code === 'source_pointer_invalid');
    expect(bad).toHaveLength(1);
    expect(bad[0]!.detail).toEqual({ factId: 'a' });
    expect(await Promise.all(seen)).toEqual([1]);
    expect(await count(db)).toBe(1);
  });

  it('3. mixed: pointer then source refusal, both after commit', async () => {
    const seen: Array<Promise<number>> = [];
    const { wiki, diagnostics } = mk({ sourceStore: { maxCharsPerSource: 10 } }, (d, d2) => {
      if (d.code === 'source_pointer_invalid') seen.push(count(d2));
    });
    await wiki.setup();
    await wiki.importDump({ generatedAt: 1, entities: { e: ent([fact('e', 'a', { source_pointer: { bad: true } })], [src('big.md', 'x'.repeat(11))]) } } as unknown as MemoryDump);
    const codes = diagnostics.map((d) => d.code).filter((c) => c === 'source_pointer_invalid' || c === 'source_store_source_too_large');
    expect(codes).toEqual(['source_pointer_invalid', 'source_store_source_too_large']);
    expect(await Promise.all(seen)).toEqual([1]);
  });

  it('4. multi-entity: entity 1 committed and emitted, entity 2 throws and emits nothing', async () => {
    const { db, wiki, diagnostics } = mk();
    await wiki.setup();
    const dump = { generatedAt: 1, entities: {
      e1: ent([fact('e1', 'a', { source_pointer: { bad: true } })]),
      e2: ent([fact('e2', 'b', { source_pointer: { bad: true } })], [badSrc]),
    } } as unknown as MemoryDump;
    await expect(wiki.importDump(dump)).rejects.toThrow();
    const bad = diagnostics.filter((d) => d.code === 'source_pointer_invalid');
    expect(bad).toHaveLength(1);
    expect(bad[0]!.entityId).toBe('e1');
    expect(await count(db)).toBe(1);
  });

  it('5. rollback suppresses source_pointer_invalid and derived_events_invalid together', async () => {
    const { db, wiki, diagnostics } = mk();
    await wiki.setup();
    const dump = { generatedAt: 1, entities: { e: ent([fact('e', 'a', { source_pointer: { bad: true }, derived_events: 'nope' }), fact('e', 'b')], [badSrc]) } } as unknown as MemoryDump;
    await expect(wiki.importDump(dump)).rejects.toThrow();
    expect(diagnostics).toEqual([]);
    expect(await count(db)).toBe(0);
  });
});

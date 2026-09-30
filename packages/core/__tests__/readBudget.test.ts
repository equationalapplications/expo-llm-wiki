import { describe, it, expect } from 'vitest';
import { WikiInvalidReadOptions } from '../src/types';
import { makeDiagnosticWiki, ofCode } from './helpers/diagnosticsHarness';

async function seeded() {
  const h = await makeDiagnosticWiki();
  for (let i = 0; i < 6; i++) {
    await h.db.runAsync(
      `INSERT INTO llm_wiki_entries (id, entity_id, title, body, confidence, created_at, updated_at) VALUES (?, 'u', ?, ?, 'certain', ?, ?)`,
      [`f${i}`, `tea fact ${i}`, 'tea '.repeat(50 * (i + 1)), i, i],
    );
  }
  await (h.wiki.__testAccess.searchService as any).sync();
  return h;
}

describe('read({ tokenBudget })', () => {
  it('omitted ⇒ unchanged', async () => {
    const { wiki, diagnostics } = await seeded();
    expect((await wiki.read('u', 'tea')).facts.length).toBe(6);
    expect(ofCode(diagnostics, 'read_budget')).toEqual([]);
  });
  it('packs facts within the budget and emits read_budget', async () => {
    const { wiki, diagnostics } = await seeded();
    const b = await wiki.read('u', 'tea', { tokenBudget: 200 });
    const used = b.facts.reduce((n, f) => n + Math.ceil(`${f.title} ${f.body} ${f.tags.join(' ')}`.length / 4), 0);
    expect(used).toBeLessThanOrEqual(200);
    expect(b.facts.length).toBeLessThan(6);
    const [d] = ofCode(diagnostics, 'read_budget');
    expect(d).toMatchObject({ operation: 'read', entityId: 'u', detail: { candidates: 6, packed: b.facts.length } });
  });
  it('recency path is packed too', async () => {
    const { wiki } = await seeded();
    expect((await wiki.read('u', '', { tokenBudget: 60 })).facts.length).toBeGreaterThanOrEqual(1);
  });
  it('only packed facts are access-tracked', async () => {
    const { wiki, db } = await seeded();
    const b = await wiki.read('u', 'tea', { tokenBudget: 60 });
    const tracked = await db.getAllAsync<{ id: string }>(`SELECT id FROM llm_wiki_entries WHERE access_count > 0 ORDER BY id`);
    expect(tracked.map((r) => r.id)).toEqual(b.facts.map((f) => f.id).sort());
  });
  it('rejects an invalid budget', async () => {
    const { wiki } = await seeded();
    await expect(wiki.read('u', 'tea', { tokenBudget: -5 })).rejects.toBeInstanceOf(WikiInvalidReadOptions);
  });
});
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { createWiki } from '../src/index';
import { HEAL_SYSTEM_PROMPT } from '../src/prompts';
import { EntryRepository } from '../src/repositories/EntryRepository';
import { SearchService } from '../src/services/SearchService';
import type { SQLiteAdapter } from '../src/types';

const PREFIX = 'llm_wiki_';
const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

beforeEach(() => {
  warnSpy.mockClear();
  vi.restoreAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

async function seed(db: SQLiteAdapter, id: string, updatedAt = 1000): Promise<void> {
  await db.runAsync(
    `INSERT INTO ${PREFIX}entries
       (id, entity_id, title, body, tags, confidence, source_type, created_at,
        updated_at, access_count, deleted_at, heal_checked_at)
     VALUES (?, 'e1', ?, ?, '[]', 'inferred', 'librarian_inferred', ?, ?, 0, NULL, NULL)`,
    [id, `title ${id}`, `body ${id}`, updatedAt, updatedAt],
  );
}

async function make(response: unknown, systemOne?: Record<string, unknown>, ids = ['f1', 'f2']) {
  const db = openTestDatabase();
  const diags: any[] = [];
  const generateText = vi.fn(async () => (typeof response === 'string' ? response : JSON.stringify(response)));
  const wiki = createWiki(db, {
    llmProvider: { generateText },
    config: { orphanAfterDays: null, staleInferredAfterDays: null, ...(systemOne ? { systemOne } : {}) },
    onDiagnostic: (d: any) => diags.push(d),
  } as any);
  await wiki.setup();
  for (const [i, id] of ids.entries()) await seed(db, id, 1000 + i);
  return { db, wiki, diags, generateText };
}

const AUTO = (floor: number) => ({ healScreen: 'auto', minConfidence: { healScreen: floor } });
const live = async (db: SQLiteAdapter, id: string) =>
  (await db.getAllAsync<{ deleted_at: number | null; confidence: string; heal_checked_at: number | null }>(
    `SELECT deleted_at, confidence, heal_checked_at FROM ${PREFIX}entries WHERE id = ?`, [id]))[0];
const receipts = (diags: any[]) => diags.filter((d) => d.code === 'heal_deleted' || d.code === 'heal_downgraded');

describe('HEAL_SYSTEM_PROMPT (T2.1)', () => {
  it('declares {id, confidence} in both arrays', () => {
    expect(HEAL_SYSTEM_PROMPT).toContain('"downgraded": [{ "id": "string (fact ID)", "confidence": "number 0-1" }]');
    expect(HEAL_SYSTEM_PROMPT).toContain('"deleted": [{ "id": "string (fact ID)", "confidence": "number 0-1" }]');
  });
});

describe('wire compat (§4, OQ1a)', () => {
  it("bare strings under 'auto': all apply, one warnOnce across two runs naming healSystemPrompt", async () => {
    const { db, wiki } = await make({ downgraded: ['f1'], deleted: ['f2'], newFacts: [] }, AUTO(0.7));
    const r = await wiki.runHeal('e1');
    expect(r.deletedIds).toEqual(['f2']);
    expect(r.downgradedIds).toEqual(['f1']);
    expect((await live(db, 'f2')).deleted_at).not.toBeNull();
    await db.runAsync(`UPDATE ${PREFIX}entries SET heal_checked_at = NULL, deleted_at = NULL`);
    await wiki.runHeal('e1');
    const w = warnSpy.mock.calls.length ? warnSpy.mock.calls : (console.warn as any).mock.calls;
    const hits = (w as any[][]).filter((c) => String(c[0]).includes('healSystemPrompt'));
    expect(hits).toHaveLength(1);
  });

  it("bare strings under 'llm': no warning, legacy behaviour", async () => {
    const { db, wiki, diags } = await make({ downgraded: ['f1'], deleted: ['f2'], newFacts: [] });
    const r = await wiki.runHeal('e1');
    expect(r.deleted).toBe(1);
    expect((await live(db, 'f2')).deleted_at).not.toBeNull();
    expect((console.warn as any).mock.calls.filter((c: any[]) => String(c[0]).includes('healSystemPrompt'))).toHaveLength(0);
    expect(receipts(diags).every((d) => d.detail.reason === 'applied')).toBe(true);
  });

  it("object response under 'llm' normalizes ids; mixed arrays parse", async () => {
    const { wiki } = await make({ downgraded: [{ id: 'f1', confidence: 0.2 }, 'f2'], deleted: [{ nope: 1 }, { id: 'f2' }], newFacts: [] });
    const r = await wiki.runHeal('e1');
    expect(r.downgradedIds).toEqual(['f1', 'f2']);
    expect(r.deletedIds).toEqual(['f2']);
  });

  it('duplicate id across entries carries the lowest valid confidence; invalid values are missing', async () => {
    const { db, wiki, diags } = await make(
      { downgraded: [], deleted: [{ id: 'f1', confidence: 0.9 }, { id: 'f1', confidence: 0.6 }, { id: 'f2', confidence: 1.5 }], newFacts: [] },
      AUTO(0.7),
    );
    const r = await wiki.runHeal('e1');
    expect(r.deletedIds).toEqual(['f2']); // f2 invalid → unscreened → applied; f1 lowest 0.6 → withheld
    expect((await live(db, 'f1')).deleted_at).toBeNull();
    const f1 = diags.find((d) => d.detail.factId === 'f1');
    expect(f1.detail).toMatchObject({ reason: 'below_floor', confidence: 0.6 });
    const f2 = diags.find((d) => d.detail.factId === 'f2');
    expect(f2.detail).toEqual({ factId: 'f2', reason: 'applied_unscreened' });
  });

  it.each([[NaN], [-0.1], [1.5], ['high']])('invalid confidence %s counts as missing', async (bad) => {
    const { wiki, diags } = await make({ downgraded: [], deleted: [{ id: 'f1', confidence: bad as any }], newFacts: [] }, AUTO(0.7));
    const r = await wiki.runHeal('e1');
    expect(r.deletedIds).toEqual(['f1']);
    expect(diags.find((d) => d.code === 'heal_deleted').detail.reason).toBe('applied_unscreened');
  });

  it('a non-offered id with low confidence does not lower an admitted duplicate', async () => {
    // Same id verdict in one batch cannot be non-offered, so use a foreign id plus admitted id.
    const { wiki, diags } = await make({ downgraded: [], deleted: [{ id: 'ghost', confidence: 0.1 }, { id: 'f1', confidence: 0.9 }], newFacts: [] }, AUTO(0.7));
    const r = await wiki.runHeal('e1');
    expect(r.deletedIds).toEqual(['f1']);
    expect(receipts(diags)).toHaveLength(1);
  });
});

describe('screen seam (§4)', () => {
  it('withholds a below-floor delete and downgrade from every reader', async () => {
    const { db, wiki, diags } = await make(
      { downgraded: [{ id: 'f1', confidence: 0.4 }], deleted: [{ id: 'f2', confidence: 0.4 }], newFacts: [] }, AUTO(0.7));
    const del = vi.spyOn(EntryRepository.prototype, 'softDeleteByIds');
    const down = vi.spyOn(EntryRepository.prototype, 'downgradeByIds');
    const sync = vi.spyOn(SearchService.prototype, 'syncEntries');
    const r = await wiki.runHeal('e1');
    expect(del.mock.calls[0][0]).toEqual([]);
    expect(down.mock.calls[0][0]).toEqual([]);
    expect(sync.mock.calls.flatMap((c) => c[1] as string[])).not.toContain('f1');
    expect(sync.mock.calls.flatMap((c) => c[1] as string[])).not.toContain('f2');
    expect(r.deletedIds).toEqual([]);
    expect(r.downgradedIds).toEqual([]);
    expect((await live(db, 'f2')).deleted_at).toBeNull();
    expect((await live(db, 'f1')).confidence).toBe('inferred');
    expect(receipts(diags).map((d) => d.detail.reason)).toEqual(['below_floor', 'below_floor']);
  });

  it('confidence equal to the floor applies; 0.999 vs floor 1 withholds', async () => {
    const a = await make({ downgraded: [], deleted: [{ id: 'f1', confidence: 0.7 }], newFacts: [] }, AUTO(0.7));
    expect((await a.wiki.runHeal('e1')).deletedIds).toEqual(['f1']);
    const b = await make({ downgraded: [], deleted: [{ id: 'f1', confidence: 0.999 }], newFacts: [] }, AUTO(1));
    expect((await b.wiki.runHeal('e1')).deletedIds).toEqual([]);
  });

  it('floor 1 still runs the SQL passes', async () => {
    const db = openTestDatabase();
    const wiki = createWiki(db, {
      llmProvider: { generateText: async () => JSON.stringify({ downgraded: [], deleted: [{ id: 'f1', confidence: 0.9 }], newFacts: [] }) },
      config: { orphanAfterDays: 0, staleInferredAfterDays: 0, systemOne: AUTO(1) },
    } as any);
    await wiki.setup();
    await seed(db, 'f1');
    await seed(db, 'f2', 1001);
    const r = await wiki.runHeal('e1');
    expect(r.deletedIds!.length + r.downgradedIds!.length).toBeGreaterThan(0);
    expect(r.deletedIds!.length).toBe(r.deleted);
    expect(r.downgradedIds!.length).toBe(r.downgraded);
  });

  it('screens each action independently for an id in both sets', async () => {
    const a = await make({ downgraded: [{ id: 'f1', confidence: 0.9 }], deleted: [{ id: 'f1', confidence: 0.4 }], newFacts: [] }, AUTO(0.7));
    const ra = await a.wiki.runHeal('e1');
    expect(ra.downgradedIds).toEqual(['f1']);
    expect(ra.deletedIds).toEqual([]);
    const b = await make({ downgraded: [{ id: 'f1', confidence: 0.4 }], deleted: [{ id: 'f1', confidence: 0.9 }], newFacts: [] }, AUTO(0.7));
    const rb = await b.wiki.runHeal('e1');
    expect(rb.downgradedIds).toEqual([]);
    expect(rb.deletedIds).toEqual(['f1']);
  });

  it('a withheld id keeps the heal_checked stamp and is not re-offered', async () => {
    const { db, wiki, generateText } = await make({ downgraded: [], deleted: [{ id: 'f1', confidence: 0.1 }], newFacts: [] }, AUTO(0.7), ['f1']);
    await wiki.runHeal('e1');
    expect((await live(db, 'f1')).heal_checked_at).not.toBeNull();
    const r2 = await wiki.runHeal('e1');
    expect(r2.scanned).toBe(0);
    expect(generateText).toHaveBeenCalledTimes(1);
  });
});

describe('receipts and id lists (§5, §6)', () => {
  it("'auto' + floor 0.7, verdicts 0.8/0.9: applied receipts, lists carry ids", async () => {
    const { wiki, diags } = await make({ downgraded: [{ id: 'f1', confidence: 0.8 }], deleted: [{ id: 'f2', confidence: 0.9 }], newFacts: [] }, AUTO(0.7));
    const r = await wiki.runHeal('e1');
    expect(r.downgradedIds).toEqual(['f1']);
    expect(r.deletedIds).toEqual(['f2']);
    const rc = receipts(diags);
    expect(rc).toHaveLength(2);
    expect(rc.map((d) => d.detail)).toEqual([{ factId: 'f1', reason: 'applied' }, { factId: 'f2', reason: 'applied' }]);
  });

  it('no systemOne keys: info-severity applied receipts only; list lengths match counts', async () => {
    const { wiki, diags } = await make({ downgraded: ['f1'], deleted: ['f2'], newFacts: [] });
    const r = await wiki.runHeal('e1');
    const rc = receipts(diags);
    expect(rc).toHaveLength(2);
    expect(rc.every((d) => d.detail.reason === 'applied' && d.severity === 'info')).toBe(true);
    expect(r.deletedIds!.length).toBe(r.deleted);
    expect(r.downgradedIds!.length).toBe(r.downgraded);
  });

  it('N model-directed moves → N receipts; heal_skipped count unchanged', async () => {
    const { wiki, diags } = await make({ downgraded: ['f1'], deleted: ['f2'], newFacts: [] });
    await wiki.runHeal('e1');
    expect(receipts(diags)).toHaveLength(2);
    expect(diags.filter((d) => d.code === 'heal_skipped')).toHaveLength(0);
  });

  it('a tx failure rejects the run and emits no receipts', async () => {
    const { wiki, diags } = await make({ downgraded: ['f1'], deleted: ['f2'], newFacts: [] });
    vi.spyOn(EntryRepository.prototype, 'downgradeByIds').mockRejectedValue(new Error('boom'));
    await expect(wiki.runHeal('e1')).rejects.toThrow('boom');
    expect(receipts(diags)).toHaveLength(0);
  });

  it('SQL-only run emits no receipts but populates the id lists', async () => {
    const db = openTestDatabase();
    const diags: any[] = [];
    const wiki = createWiki(db, {
      llmProvider: { generateText: async () => JSON.stringify({ downgraded: [], deleted: [], newFacts: [] }) },
      config: { orphanAfterDays: 0, staleInferredAfterDays: null },
      onDiagnostic: (d: any) => diags.push(d),
    } as any);
    await wiki.setup();
    await seed(db, 'f1');
    const r = await wiki.runHeal('e1');
    expect(receipts(diags)).toHaveLength(0);
    expect(r.deletedIds!.length).toBe(r.deleted);
  });

  it('keyword-outage early return carries both id lists', async () => {
    const { wiki } = await make({ downgraded: [], deleted: [], newFacts: [] });
    vi.spyOn(SearchService.prototype, 'isKeywordAvailable').mockReturnValue(false);
    const r = await wiki.runHeal('e1');
    expect(r.searchUnavailable).toBe(true);
    expect(r.downgradedIds).toEqual([]);
    expect(r.deletedIds).toEqual([]);
  });
});

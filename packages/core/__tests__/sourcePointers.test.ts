import { describe, it, expect, vi } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { ofCode } from './helpers/diagnosticsHarness';
import { formatOkfBundle } from '../src/utils/formatOkfBundle';
import { parseOkfBundle } from '../src/utils/parseOkfBundle';
import type { WikiDiagnostic, WikiFact } from '../src/types';
import { validateSourcePointerValue } from '../src/utils/sourcePointer';

// Source-pointer suite (specs/source-pointers §Test plan, tests 1–14).
// Test 1's CURRENT_SCHEMA_VERSION pin lives in setupBudget.test.ts (asserts 16).

type Response = (p: { systemPrompt: string; userPrompt: string }) => unknown;

function mk(responses: Response[], config: Record<string, unknown> = {}) {
  const db = openTestDatabase();
  const diagnostics: WikiDiagnostic[] = [];
  let i = 0;
  const generateText = vi.fn(async (p: { systemPrompt: string; userPrompt: string }) => JSON.stringify(responses[i++](p)));
  const embedSpy = vi.fn(async (t: string) => [0.1, 0.2, 0.3, 0.5]);
  const wiki = new WikiMemory(db, {
    llmProvider: { generateText, embed: embedSpy },
    config: { autoLibrarianThreshold: 1000, librarian: { strategy: 'ops' as const }, ...config },
    onDiagnostic: (d) => diagnostics.push(d),
  });
  return { db, wiki, generateText, diagnostics, embed: embedSpy };
}

function factWith(source_event: unknown, title = 'User has a dog named Rex', body = 'A beagle hound') {
  return { title, body, tags: [], confidence: 'certain', source_event };
}

async function insertEvents(db: ReturnType<typeof openTestDatabase>, summaries: string[]) {
  let at = 100;
  for (const [i, summary] of summaries.entries()) {
    await db.runAsync(
      `INSERT INTO llm_wiki_events (id, entity_id, event_type, summary, created_at, occurred_at)
       VALUES (?, 'u', 'observation', ?, ?, ?)`,
      [`evt_${i + 1}`, summary, at, at],
    );
    at += 10;
  }
}

const pointerOf = async (db: ReturnType<typeof openTestDatabase>, id: string) =>
  (await db.getFirstAsync<any>(`SELECT source_pointer FROM llm_wiki_entries WHERE id = ?`, [id]))?.source_pointer;

describe('source pointers — migration reads (test 1 remainder)', () => {
  it('a fresh store has the column; rows read null; a malformed stored value reads as null without throwing', async () => {
    const { db, wiki } = mk([]);
    await wiki.setup();
    const cols = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(llm_wiki_entries)`);
    expect(cols.map((c) => c.name)).toContain('source_pointer');
    await db.runAsync(
      `INSERT INTO llm_wiki_entries (id, entity_id, title, body, source_type, confidence, created_at, updated_at)
       VALUES ('pre','u','Pre pointer','b','user_stated','certain',1,1)`,
    );
    // Read through the repository mapper directly (bypasses the read cache a
    // raw SQL mutation cannot evict).
    const readFact = async () => (await (wiki as any).__testAccess.entryRepo.findByIds(['pre']))[0] as WikiFact;
    expect((await readFact()).source_pointer ?? null).toBeNull();
    await db.runAsync(`UPDATE llm_wiki_entries SET source_pointer = '{ not json' WHERE id = 'pre'`);
    expect((await readFact()).source_pointer ?? null).toBeNull();
    await db.runAsync(`UPDATE llm_wiki_entries SET source_pointer = '{"event_id":"e9"}' WHERE id = 'pre'`);
    expect((await readFact()).source_pointer).toEqual({ event_id: 'e9', ref: null, quote: null, position: null });
  });
});

describe('source pointers — ops write path (tests 2–3)', () => {
  it('test 2: a fact naming the second event of a three-event batch carries that event id; reads return the pointer', async () => {
    const { db, wiki, generateText } = mk([
      () => ({ facts: [factWith('e2')], tasks: [] }),
    ]);
    await wiki.setup();
    await insertEvents(db, ['first event summary', 'second event summary', 'third event summary']);
    await wiki.runLibrarian('u');
    expect(generateText).toHaveBeenCalledTimes(1);
    const id = (await db.getFirstAsync<any>(`SELECT id FROM llm_wiki_entries WHERE title = 'User has a dog named Rex'`))!.id;
    const pointer = JSON.parse(await pointerOf(db, id));
    expect(pointer).toEqual({ event_id: 'evt_2', ref: null, quote: null, position: null });
    const read = (await wiki.read('u', 'Rex')).facts.find((f) => f.id === id)!;
    expect(read.source_pointer).toEqual(pointer);
  });

  it('test 3: missing / null / unknown_label / non-string each emit one source_pointer_unresolved with reason + itemIndex and no fact text', async () => {
    for (const [name, source_event, reason] of [
      ['missing (absent)', undefined, 'missing'],
      ['missing (JSON null)', null, 'missing'],
      ['unknown label', 'e99', 'unknown_label'],
      ['non-string', 7, 'unknown_label'],
    ] as const) {
      const { db, wiki, diagnostics } = mk([() => ({ facts: [factWith(source_event as unknown)], tasks: [] })]);
      await wiki.setup();
      await insertEvents(db, ['only event summary']);
      await wiki.runLibrarian('u');
      const row = await db.getFirstAsync<any>(`SELECT id, source_pointer FROM llm_wiki_entries WHERE title = 'User has a dog named Rex'`);
      expect(row.source_pointer, name).toBeNull();
      const diag = ofCode(diagnostics, 'source_pointer_unresolved');
      expect(diag, name).toHaveLength(1);
      expect(diag[0].detail).toEqual({ factId: row.id, itemIndex: 0, reason });
      expect(JSON.stringify(diag)).not.toContain('Rex');
    }
  });
});

describe('source pointers — quote rule (test 6)', () => {
  const GROUNDING = { grounding: { mode: 'draft' as const, writers: ['librarian' as const] } };
  const E1 = 'Ada Lovelace wrote the first published algorithm for the engine.';
  const E2 = 'Charles Babbage assembled a trial section of the difference engine.';
  const E3 = 'The trial section computed sixth-order polynomial differences correctly.';

  it('grounded + named-event part: quote is the first retained quote the named part contains', async () => {
    const ev = E2.slice(0, 40);
    const { db, wiki } = mk([() => ({ facts: [{ ...factWith('e2'), evidence: [ev] }], tasks: [] })], GROUNDING);
    await wiki.setup();
    await insertEvents(db, [E1, E2, E3]);
    await wiki.runLibrarian('u');
    const id = (await db.getFirstAsync<any>(`SELECT id FROM llm_wiki_entries WHERE title = 'User has a dog named Rex'`))!.id;
    const pointer = JSON.parse(await pointerOf(db, id));
    expect(pointer.event_id).toBe('evt_2');
    expect(pointer.quote).toBe(ev);
    expect(pointer.ref).toBeNull();
    expect(pointer.position).toBeNull();
  });

  it('a quote from another event part yields quote null with the named event id still set', async () => {
    const ev = E1.slice(0, 40);
    const { db, wiki } = mk([() => ({ facts: [{ ...factWith('e2'), evidence: [ev] }], tasks: [] })], GROUNDING);
    await wiki.setup();
    await insertEvents(db, [E1, E2, E3]);
    await wiki.runLibrarian('u');
    const pointer = JSON.parse(await pointerOf(db, (await db.getFirstAsync<any>(`SELECT id FROM llm_wiki_entries`))!.id));
    expect(pointer.event_id).toBe('evt_2');
    expect(pointer.quote).toBeNull();
    // Grounded verdict is unchanged: the fact is stable, not a draft.
    const row = await db.getFirstAsync<any>(`SELECT lifecycle_status FROM llm_wiki_entries`);
    expect(row.lifecycle_status).toBe('stable');
  });

  it('retained[0] from another part: the named part quote wins when the retained list carries one', async () => {
    const evA = E3.slice(0, 40);
    const evB = E1.slice(0, 40);
    const { db, wiki } = mk([() => ({ facts: [{ ...factWith('e1'), evidence: [evA, evB] }], tasks: [] })], GROUNDING);
    await wiki.setup();
    await insertEvents(db, [E1, E2, E3]);
    await wiki.runLibrarian('u');
    const pointer = JSON.parse(await pointerOf(db, (await db.getFirstAsync<any>(`SELECT id FROM llm_wiki_entries`))!.id));
    expect(pointer.event_id).toBe('evt_1');
    expect(pointer.quote).toBe(evB);
  });

  it('grounding on + ungrounded: quote null, draft path, event_id still set; grounding off + evidence: quote null', async () => {
    const ev = E1.slice(0, 40) + ' fabricated tail';
    const a = mk([() => ({ facts: [{ ...factWith('e1'), evidence: [ev] }], tasks: [] })], GROUNDING);
    await a.wiki.setup();
    await insertEvents(a.db, [E1]);
    await a.wiki.runLibrarian('u');
    const rowA = await a.db.getFirstAsync<any>(`SELECT id, source_pointer, lifecycle_status FROM llm_wiki_entries`);
    const pointerA = JSON.parse(rowA.source_pointer);
    expect(pointerA.event_id).toBe('evt_1');
    expect(pointerA.quote).toBeNull();
    expect(rowA.lifecycle_status).toBe('draft');
    expect(ofCode(a.diagnostics, 'grounding_failed')).toHaveLength(1);

    const b = mk([() => ({ facts: [{ ...factWith('e1'), evidence: [E1.slice(0, 40)] }], tasks: [] })]);
    await b.wiki.setup();
    await insertEvents(b.db, [E1]);
    await b.wiki.runLibrarian('u');
    const pointerB = JSON.parse(await pointerOf(b.db, (await b.db.getFirstAsync<any>(`SELECT id FROM llm_wiki_entries`))!.id));
    expect(pointerB.event_id).toBe('evt_1');
    expect(pointerB.quote).toBeNull();
  });
});

describe('source pointers — legacy path (test 5)', () => {
  function mkLegacy(responses: Response[]) {
    return mk(responses, { librarian: { strategy: 'legacy' as const } });
  }

  it('a legacy model volunteering source_event stores a null pointer and emits unsupported_strategy; absent emits nothing', async () => {
    const withField = mkLegacy([() => ({ facts: [{ ...factWith('e1') }], tasks: [] })]);
    await withField.wiki.setup();
    await insertEvents(withField.db, ['legacy event summary']);
    await withField.wiki.runLibrarian('u');
    const idW = (await withField.db.getFirstAsync<any>(`SELECT id FROM llm_wiki_entries`))!.id;
    expect(await pointerOf(withField.db, idW)).toBeNull();
    const diag = ofCode(withField.diagnostics, 'source_pointer_unresolved');
    expect(diag).toHaveLength(1);
    expect(diag[0].detail).toEqual({ factId: idW, itemIndex: 0, reason: 'unsupported_strategy' });

    const without = mkLegacy([() => ({ facts: [{ title: 'User has a dog named Rex', body: 'A beagle hound', tags: [], confidence: 'certain' }], tasks: [] })]);
    await without.wiki.setup();
    await insertEvents(without.db, ['legacy event summary']);
    await without.wiki.runLibrarian('u');
    expect(ofCode(without.diagnostics, 'source_pointer_unresolved')).toHaveLength(0);
  });
});

describe('source pointers — UPDATE boundary (test 7)', () => {
  it('an ops UPDATE leaves the pointer byte-identical and the outbox payload carries it', async () => {
    const { db, wiki } = mk([
      () => ({ facts: [factWith('e1')], tasks: [] }),
      () => ({ facts: [{ title: "Rex is the user's beagle hound", body: 'Now a beagle hound named Rex', tags: [], confidence: 'certain', source_event: 'e2' }], tasks: [] }),
      () => ({ ops: [{ item: 0, op: 'UPDATE', target: 'n1', body: 'Now a beagle hound named Rex, officially' }] }),
    ], { enableOutbox: true });
    await wiki.setup();
    await insertEvents(db, ['first event summary', 'second event summary']);
    await wiki.runLibrarian('u');
    const id = (await db.getFirstAsync<any>(`SELECT id FROM llm_wiki_entries WHERE title = 'User has a dog named Rex'`))!.id;
    const before = await pointerOf(db, id);
    await db.runAsync(`INSERT INTO llm_wiki_events (id, entity_id, event_type, summary, created_at) VALUES ('evt_2b','u','observation','rex update',200)`);
    await wiki.runLibrarian('u');
    expect(await pointerOf(db, id)).toBe(before);
    const outbox = await db.getAllAsync<any>(
      `SELECT payload FROM llm_wiki_outbox WHERE record_id = ? AND table_name = 'entries' ORDER BY rowid DESC LIMIT 1`,
      [id],
    );
    expect(outbox).toHaveLength(1);
    expect(JSON.parse(outbox[0].payload).source_pointer).toEqual(JSON.parse(before!));
  });
});

describe('source pointers — dump round-trip (tests 8 + 12)', () => {
  it('exportDump → importDump restores the pointer exactly; malformed imports null + source_pointer_invalid; pre-release dump leaves pointers untouched; imported event ids are never dereferenced (test 12)', async () => {
    const source = mk([() => ({ facts: [factWith('e1')], tasks: [] })]);
    await source.wiki.setup();
    await insertEvents(source.db, ['first event summary']);
    await source.wiki.runLibrarian('u');
    const id = (await source.db.getFirstAsync<any>(`SELECT id FROM llm_wiki_entries`))!.id;
    const dump = await source.wiki.exportDump('u');
    const exportedPointer = (dump.entities['u'].facts as WikiFact[]).find((f) => f.id === id)!.source_pointer;
    expect(exportedPointer).toEqual({ event_id: 'evt_1', ref: null, quote: null, position: null });

    // Clean round-trip.
    const target1 = mk([]);
    await target1.wiki.setup();
    await target1.wiki.importDump(dump);
    expect(await pointerOf(target1.db, id)).toBe(JSON.stringify(exportedPointer));
    expect(ofCode(target1.diagnostics, 'source_pointer_invalid')).toHaveLength(0);

    // Malformed pointer: fact imports, pointer null, one content-free diagnostic.
    const dumpBad = JSON.parse(JSON.stringify(dump));
    (dumpBad.entities['u'].facts as any[]).find((f) => f.id === id)!.source_pointer = { event_id: 42, oops: true };
    const target2 = mk([]);
    await target2.wiki.setup();
    await target2.wiki.importDump(dumpBad);
    expect(await pointerOf(target2.db, id)).toBeNull();
    const invalid = ofCode(target2.diagnostics, 'source_pointer_invalid');
    expect(invalid).toHaveLength(1);
    expect(invalid[0].detail).toEqual({ factId: id });

    // Verbatim foreign event id (test 12): copied, never dereferenced, no diagnostic.
    const dumpForeign = JSON.parse(JSON.stringify(dump));
    (dumpForeign.entities['u'].facts as any[]).find((f) => f.id === id)!.source_pointer = { event_id: 'evt_of_another_entity' };
    const target3 = mk([]);
    await target3.wiki.setup();
    await target3.wiki.importDump(dumpForeign);
    expect(await pointerOf(target3.db, id)).toBe(JSON.stringify({ event_id: 'evt_of_another_entity', ref: null, quote: null, position: null }));
    expect(ofCode(target3.diagnostics, 'source_pointer_invalid')).toHaveLength(0);

    // Pre-release dump (key absent) over a stored pointer: untouched, zero diagnostics.
    const target4 = mk([]);
    await target4.wiki.setup();
    await target4.wiki.importDump(dump);
    const dumpPre = JSON.parse(JSON.stringify(dump));
    delete (dumpPre.entities['u'].facts as any[]).find((f) => f.id === id)!.source_pointer;
    const before = await pointerOf(target4.db, id);
    await target4.wiki.importDump(dumpPre);
    expect(await pointerOf(target4.db, id)).toBe(before);
    expect(ofCode(target4.diagnostics, 'source_pointer_invalid')).toHaveLength(0);
  });
});

describe('source pointers — OKF round-trip (test 9)', () => {
  const baseFact = (over: Partial<WikiFact>): WikiFact => ({
    id: 'fact_aaa', entity_id: 'alice', title: 'T', body: 'B', tags: [],
    confidence: 'inferred', source_type: 'librarian_inferred', source_hash: null, source_ref: null,
    created_at: 1, updated_at: 1, last_accessed_at: null, access_count: 0, deleted_at: null,
    ...over,
  });

  it('emits the map only for non-null pointers, omits null slots, round-trips hostile quote characters', async () => {
    const plain = baseFact({});
    const dumpPlain = formatOkfBundle({ generatedAt: 0, entities: { alice: { facts: [plain], tasks: [], events: [], edges: [] } } }, { profile: 'llm-wiki/1' });
    const plainFactFile = dumpPlain.files.find((f) => f.path === 'entities/alice/facts/fact_aaa.md')!;
    expect(plainFactFile.content).not.toContain('source_pointer');
    const backPlain = parseOkfBundle('alice', dumpPlain.files);
    expect((backPlain.entities['alice'].facts[0] as WikiFact).source_pointer).toBeUndefined();

    const hostile = ' weighed anchor: "early" #log -first light';
    const full = baseFact({ source_pointer: { event_id: 'evt_9', ref: null, quote: hostile, position: null } });
    const dumpFull = formatOkfBundle({ generatedAt: 0, entities: { alice: { facts: [full], tasks: [], events: [], edges: [] } } }, { profile: 'llm-wiki/1' });
    const fullFactFile = dumpFull.files.find((f) => f.path === 'entities/alice/facts/fact_aaa.md')!;
    expect(fullFactFile.content).toContain('source_pointer');
    const back = parseOkfBundle('alice', dumpFull.files);
    expect((back.entities['alice'].facts[0] as WikiFact).source_pointer).toEqual(full.source_pointer);
    expect(back.dropped_pointer_values).toBeUndefined();
  });

  it('a malformed key parses to null, omits the property, and reports entry id + reason only', async () => {
    const bad = baseFact({});
    const dump = formatOkfBundle({ generatedAt: 0, entities: { alice: { facts: [bad], tasks: [], events: [], edges: [] } } }, { profile: 'llm-wiki/1' });
    const factFile = dump.files.find((f) => f.path === 'entities/alice/facts/fact_aaa.md')!;
    factFile.content = factFile.content.replace('---\n', '---\nsource_pointer:\n  event_id: 42\n  rogue: true\n');
    const back = parseOkfBundle('alice', dump.files);
    const f = back.entities['alice'].facts[0] as WikiFact;
    expect(f.source_pointer).toBeUndefined();
    expect(back.dropped_pointer_values).toEqual([{ factId: 'fact_aaa', reason: 'malformed' }]);
    expect(JSON.stringify(back)).not.toContain('rogue');
    // Predicate spot checks (spec §Export, import, and OKF): null valid;
    // all-null/empty map valid; malformed rejected; absent slots read null.
    expect(validateSourcePointerValue(null)).toBeNull();
    expect(validateSourcePointerValue({})).toEqual({ event_id: null, ref: null, quote: null, position: null });
    expect(validateSourcePointerValue('garbage')).toBeUndefined();
    expect(validateSourcePointerValue({ position: { start: -1, length: 2 } })).toBeUndefined();
    expect(validateSourcePointerValue({ event_id: 'e1', rogue: 1 })).toBeUndefined();
    expect(validateSourcePointerValue({ event_id: 'e1' })).toEqual({ event_id: 'e1', ref: null, quote: null, position: null });
  });
});

describe('source pointers — prune semantics (test 10)', () => {
  it('prune deletes the event; the surviving fact pointer is unchanged; reads succeed with no event join', async () => {
    const { db, wiki } = mk([() => ({ facts: [factWith('e1')], tasks: [] })]);
    await wiki.setup();
    await insertEvents(db, ['an event the prune will delete later on']);
    await wiki.runLibrarian('u');
    const id = (await db.getFirstAsync<any>(`SELECT id FROM llm_wiki_entries`))!.id;
    const before = await pointerOf(db, id);
    await wiki.runPrune('u', { retainSoftDeletedFor: 0, retainEventsFor: 0 });
    expect(await db.getFirstAsync(`SELECT 1 FROM llm_wiki_events WHERE id = 'evt_1'`)).toBeNull();
    expect(await pointerOf(db, id)).toBe(before);
    const read = await wiki.read('u', 'Rex');
    expect(read.facts.map((f) => f.id)).toContain(id);
  });
});

describe('source pointers — forget boundary (test 11)', () => {
  it('forget({ sourceRef }) leaves librarian pointer rows; forget by entry id removes them', async () => {
    const { db, wiki } = mk([
      () => ({ facts: [factWith('e1')], tasks: [] }),
      // The ingest pass for doc.md (one chunk → one immutable_document fact).
      () => ({ facts: [{ title: 'Document note about the kennel club', body: 'from the document text', tags: [], confidence: 'certain' }], tasks: [] }),
    ]);
    await wiki.setup();
    await insertEvents(db, ['first event summary']);
    await wiki.runLibrarian('u');
    const pointerId = (await db.getFirstAsync<any>(`SELECT id FROM llm_wiki_entries`))!.id;
    const hexHash = 'a'.repeat(64);
    await wiki.ingestDocument('u', { sourceRef: 'doc.md', sourceHash: hexHash, documentChunk: 'document body text' });

    await wiki.forget('u', { sourceRef: 'doc.md' });
    expect(await db.getFirstAsync(`SELECT 1 FROM llm_wiki_entries WHERE id = ? AND deleted_at IS NULL`, [pointerId])).not.toBeNull();

    await wiki.forget('u', { entryId: pointerId });
    expect(await db.getFirstAsync(`SELECT 1 FROM llm_wiki_entries WHERE id = ? AND deleted_at IS NULL`, [pointerId])).toBeNull();
  });
});

describe('source pointers — heal gap (test 13)', () => {
  it('a heal restatement writes a null pointer and emits no source-pointer diagnostic', async () => {
    const db = openTestDatabase();
    const diagnostics: WikiDiagnostic[] = [];
    const recent = Date.now();
    const generateText = vi.fn(async (p: { systemPrompt: string; userPrompt: string }) => {
      if (p.userPrompt.startsWith('Heal Candidates')) {
        return JSON.stringify({ downgraded: [], deleted: [], newFacts: [{ title: 'Restated candidate', body: 'restated body text', tags: [] }] });
      }
      return JSON.stringify({ facts: [], tasks: [] });
    });
    const wiki = new WikiMemory(db, {
      llmProvider: { generateText, embed: async () => [0.1, 0.2, 0.3, 0.5] },
      config: { autoLibrarianThreshold: 1000 },
      onDiagnostic: (d) => diagnostics.push(d),
    });
    await wiki.setup();
    await db.runAsync(
      `INSERT INTO llm_wiki_entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at, source_pointer)
       VALUES ('cand', 'e1', 'Candidate', 'candidate body', '[]', 'inferred', 'librarian_inferred', ?, ?, ?)`,
      [recent, recent, JSON.stringify({ event_id: 'evt_1', ref: null, quote: null, position: null })],
    );
    await wiki.runHeal('e1');
    const restated = await db.getFirstAsync<any>(`SELECT id, source_pointer FROM llm_wiki_entries WHERE title = 'Restated candidate'`);
    expect(restated).not.toBeNull();
    expect(restated.source_pointer).toBeNull();
    expect(ofCode(diagnostics, 'source_pointer_unresolved')).toHaveLength(0);
    expect(ofCode(diagnostics, 'source_pointer_invalid')).toHaveLength(0);
  });
});

describe('source pointers — no-leak pin (test 14)', () => {
  const SENTINEL = 'sentinelquoteZQ';
  const E1 = `A beagle hound with ${SENTINEL} papers was registered at the kennel club show.`;
  const mkLeak = (indexStrategy: 'fts5' | 'minisearch') => {
    const db = openTestDatabase();
    const diagnostics: WikiDiagnostic[] = [];
    const embedInputs: string[] = [];
    const generateText = vi.fn(async (p: { systemPrompt: string; userPrompt: string }) => {
      return JSON.stringify({
        facts: [{ title: 'User has a dog named Rex', body: 'A beagle hound with papers', tags: [], confidence: 'certain', source_event: 'e1', evidence: [E1.slice(0, 55)] }],
        tasks: [],
      });
    });
    const embedSpy = vi.fn(async (t: string) => {
      embedInputs.push(t);
      return [0.1, 0.2, 0.3, 0.5];
    });
    const wiki = new WikiMemory(db, {
      llmProvider: { generateText, embed: embedSpy },
      config: {
        autoLibrarianThreshold: 1000,
        librarian: { strategy: 'ops' as const },
        indexStrategy,
        grounding: { mode: 'draft' as const, writers: ['librarian' as const] },
      },
      onDiagnostic: (d) => diagnostics.push(d),
    });
    return { db, wiki, diagnostics, embedInputs };
  };

  for (const indexStrategy of ['fts5', 'minisearch'] as const) {
    it(`the quote never reaches embed inputs, the keyword index, or stored body (${indexStrategy})`, async () => {
      const { db, wiki, diagnostics, embedInputs } = mkLeak(indexStrategy);
      await wiki.setup();
      await db.runAsync(
        `INSERT INTO llm_wiki_events (id, entity_id, event_type, summary, created_at, occurred_at)
         VALUES ('evt_1','u','observation', ?, 100, 90)`,
        [E1],
      );
      await wiki.runLibrarian('u');
      const id = (await db.getFirstAsync<any>(`SELECT id FROM llm_wiki_entries WHERE title = 'User has a dog named Rex'`))!.id;
      const pointer = JSON.parse(await pointerOf(db, id));
      expect(pointer.quote).toContain(SENTINEL);

      // Index-level keyword search: the sentinel matches nothing; a body token still hits.
      const kw = (w: WikiMemory, q: string) => (w as any).__testAccess.searchService.searchKeyword(q, ['u'], 10);
      expect(await kw(wiki, SENTINEL)).toEqual([]);
      expect((await kw(wiki, 'beagle')).map((r: any) => r.id)).toContain(id);

      // No embed input carried the sentinel.
      expect(embedInputs.length).toBeGreaterThan(0);
      for (const t of embedInputs) expect(t).not.toContain(SENTINEL);

      // The stored body never contained the quote.
      const row = await db.getFirstAsync<any>(`SELECT body FROM llm_wiki_entries WHERE id = ?`, [id]);
      expect(row.body).not.toContain(SENTINEL);
      expect(ofCode(diagnostics, 'source_pointer_unresolved')).toHaveLength(0);

      if (indexStrategy === 'fts5') {
        // Raw pointer-only UPDATE: the trigger's column list excludes
        // source_pointer, so no fts_pending row is queued.
        const beforeCount = (await db.getFirstAsync<any>(`SELECT count(*) AS n FROM llm_wiki_fts_pending`))!.n;
        await db.runAsync(`UPDATE llm_wiki_entries SET source_pointer = ? WHERE id = ?`, [JSON.stringify({ ...pointer, quote: 'x' }), id]);
        const afterCount = (await db.getFirstAsync<any>(`SELECT count(*) AS n FROM llm_wiki_fts_pending`))!.n;
        expect(afterCount).toBe(beforeCount);
        // And the index still has no sentinel match after the rewrite.
        expect(await kw(wiki, SENTINEL)).toEqual([]);
      }
    });
  }

  it('after a merge:false re-import whose pointer differs, the sentinel is still unsearchable (outcome check)', async () => {
    const src = mkLeak('fts5');
    await src.wiki.setup();
    await src.db.runAsync(
      `INSERT INTO llm_wiki_events (id, entity_id, event_type, summary, created_at, occurred_at)
       VALUES ('evt_1','u','observation', ?, 100, 90)`,
      [E1],
    );
    await src.wiki.runLibrarian('u');
    const id = (await src.db.getFirstAsync<any>(`SELECT id FROM llm_wiki_entries WHERE title = 'User has a dog named Rex'`))!.id;
    const dump = await src.wiki.exportDump('u');
    const factInDump = (dump.entities['u'].facts as any[]).find((f) => f.id === id)!;
    factInDump.source_pointer = { ...factInDump.source_pointer, quote: 'different quote entirely' };

    const target = mk([]);
    await target.wiki.setup();
    await target.wiki.importDump(dump);
    // importDump drained the ledger before returning; the rebuilt index has no sentinel.
    const kw = (w: WikiMemory, q: string) => (w as any).__testAccess.searchService.searchKeyword(q, ['u'], 10);
    expect(await kw(target.wiki, SENTINEL)).toEqual([]);
    expect((await target.db.getFirstAsync<any>(`SELECT count(*) AS n FROM llm_wiki_fts_pending`))!.n).toBe(0);
  });
});

import { describe, it, expect, vi, afterEach } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { PromptService } from '../src/services/PromptService';
import { LEAVE_OUT_RULE_SENTENCE } from '../src/prompts';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { ofCode } from './helpers/diagnosticsHarness';
import type { WikiConfig, WikiDiagnostic } from '../src/types';

afterEach(() => vi.restoreAllMocks());

const SENTINEL_TOKEN = 'SCHEDULER-GUIDANCE-SENTINEL';
const SENTINEL = `${SENTINEL_TOKEN} keep it terse`;
const SECTION_MARK = '--- Host guidance ---';
const GROUNDING_MARK = 'EVIDENCE REQUIREMENT:';
const embed = async (t: string) => [/seattle/i.test(t) ? 1 : 0, /san francisco/i.test(t) ? 1 : 0, /lives|moved/i.test(t) ? 1 : 0, 0.5];

type Prompt = { systemPrompt: string; userPrompt: string };

async function mk(config: WikiConfig, respond: (p: Prompt, n: number) => unknown) {
  const db = openTestDatabase();
  const diagnostics: WikiDiagnostic[] = [];
  const prompts: Prompt[] = [];
  const generateText = vi.fn(async (p: Prompt) => {
    prompts.push(p);
    return JSON.stringify(respond(p, prompts.length - 1));
  });
  const wiki = new WikiMemory(db, {
    llmProvider: { generateText, embed },
    config: { autoLibrarianThreshold: 1000, ...config },
    onDiagnostic: (d) => diagnostics.push(d),
  });
  await wiki.setup();
  return { db, wiki, diagnostics, prompts };
}

const addEvent = (db: any, summary: string, at = 100) =>
  db.runAsync(
    `INSERT INTO llm_wiki_events (id, entity_id, event_type, summary, created_at, occurred_at) VALUES ('evt_1','u','observation',?,?,?)`,
    [summary, at, at - 10],
  );
const addDoc = (db: any) =>
  db.runAsync(
    `INSERT INTO llm_wiki_entries (id, entity_id, title, body, source_type, confidence, created_at, updated_at)
     VALUES ('doc1','u','User lives in Seattle','Doc body about Seattle','immutable_document','certain',1,1)`,
  );
const addCandidate = (db: any, title = 'Other inferred fact') => {
  const now = Date.now();
  return db.runAsync(
    `INSERT INTO llm_wiki_entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at)
     VALUES ('cand','u',?,'b','[]','inferred','librarian_inferred',?,?)`,
    [title, now, now],
  );
};
const rowOf = (db: any, id = 'doc1') => db.getFirstAsync(`SELECT * FROM llm_wiki_entries WHERE id = ?`, [id]);
const SF_FACT = { title: 'User moved to San Francisco', body: 'Moved in March', tags: [], confidence: 'certain', source_event: 'e1' };

describe('scheduler path (spec test item 4)', () => {
  it('maintenanceScheduler.run() delivers guidance + leave-out rule to the librarian pass', async () => {
    const { db, wiki, prompts } = await mk({ prompts: { guidance: SENTINEL } }, () => ({ facts: [], tasks: [] }));
    await addEvent(db, 'I like tea');
    await wiki.maintenanceScheduler.run({ entityIds: ['u'], jobs: ['librarian'] });
    expect(prompts.length).toBeGreaterThan(0);
    const sys = prompts[0].systemPrompt;
    expect(sys).toContain(SECTION_MARK);
    expect(sys).toContain(SENTINEL);
    expect(sys).toContain(LEAVE_OUT_RULE_SENTENCE);
  });

  it('maintenanceScheduler.run() delivers the entity-specific (resolver) guidance, not the default', async () => {
    const { db, wiki, prompts } = await mk(
      {
        prompts: { guidance: 'DEFAULT-GUIDANCE-TOKEN' },
        librarian: { guidanceForEntity: (id: string) => (id === 'u' ? 'ENTITY-GUIDANCE-TOKEN' : undefined) },
      },
      () => ({ facts: [], tasks: [] }),
    );
    await addEvent(db, 'I like tea');
    await wiki.maintenanceScheduler.run({ entityIds: ['u'], jobs: ['librarian'] });
    expect(prompts.length).toBeGreaterThan(0);
    const sys = prompts[0].systemPrompt;
    expect(sys).toContain(SECTION_MARK);
    expect(sys).toContain('ENTITY-GUIDANCE-TOKEN');
    expect(sys).not.toContain('DEFAULT-GUIDANCE-TOKEN');
  });
});

describe('rule 5 — immutable_document is untouchable (spec test item 8)', () => {
  it('ops UPDATE targeting the document: contradicts_document, row byte-unchanged', async () => {
    const { db, wiki, diagnostics } = await mk({ librarian: { strategy: 'ops' } }, (_p, n) =>
      n === 0
        ? { facts: [SF_FACT], tasks: [] }
        : { ops: [{ item: 0, op: 'UPDATE', target: 'n1', title: 'REWRITE-TITLE', body: 'REWRITE-BODY' }] });
    await addDoc(db);
    await wiki.runReembed();
    const before = await rowOf(db);
    await addEvent(db, 'I moved to San Francisco');
    await wiki.runLibrarian('u');
    expect(ofCode(diagnostics, 'contradicts_document')).toHaveLength(1);
    expect(await rowOf(db)).toEqual(before);
  });

  it('ops SUPERSEDE targeting the document: contradicts_document, row byte-unchanged', async () => {
    const { db, wiki, diagnostics } = await mk({ librarian: { strategy: 'ops' } }, (_p, n) =>
      n === 0 ? { facts: [SF_FACT], tasks: [] } : { ops: [{ item: 0, op: 'SUPERSEDE', target: 'n1' }] });
    await addDoc(db);
    await wiki.runReembed();
    const before = await rowOf(db);
    await addEvent(db, 'I moved to San Francisco');
    await wiki.runLibrarian('u');
    expect(ofCode(diagnostics, 'contradicts_document')).toHaveLength(1);
    expect(await rowOf(db)).toEqual(before);
  });

  // Observed spec-vs-code nuance: legacy.ts fuzzy-dedupes only against
  // librarian_inferred rows, so a same-title fact is NOT deduplicated against a
  // document and no diagnostic fires; the legacy writer inserts a separate
  // row. Rule 5 still holds: the document row is never rewritten.
  it('legacy librarian emitting the document title: document row byte-unchanged, written as a separate fact', async () => {
    const { db, wiki, diagnostics } = await mk({ librarian: { strategy: 'legacy' } }, () => ({
      facts: [{ title: 'User lives in Seattle', body: 'REWRITE-BODY', tags: [], confidence: 'certain' }],
      tasks: [],
    }));
    await addDoc(db);
    const before = await rowOf(db);
    await addEvent(db, 'I live in Seattle');
    await wiki.runLibrarian('u');
    expect(ofCode(diagnostics, 'fact_deduplicated')).toEqual([]);
    expect(await rowOf(db)).toEqual(before);
    const rows = await db.getAllAsync(`SELECT id FROM llm_wiki_entries WHERE id != 'doc1'`);
    expect(rows).toHaveLength(1); // the stub genuinely wrote a fact, elsewhere
  });

  it('heal naming the document in downgraded and deleted: row byte-unchanged (guard drops silently)', async () => {
    const { db, wiki, prompts } = await mk({}, () => ({ downgraded: ['doc1'], deleted: ['doc1'], newFacts: [] }));
    await addDoc(db);
    await addCandidate(db, 'User lives in Seattle area'); // shares keywords so the document is selected as an anchor
    await (wiki as any).searchService.sync('u'); // rows were inserted via raw SQL; rebuild the keyword index
    const before = await rowOf(db);
    await wiki.runHeal('u');
    expect(prompts.length).toBeGreaterThan(0); // the stub really was asked to heal
    expect(prompts[0].userPrompt).toContain('doc1'); // the document was actually offered to the model
    expect(await rowOf(db)).toEqual(before);
  });
});

describe('grounding corpus excludes guidance (spec test item 3)', () => {
  const GROUNDED_CFG: WikiConfig = {
    prompts: { guidance: SENTINEL },
    grounding: { mode: 'draft', writers: ['ingest', 'librarian', 'heal'] },
  };

  function spyBuilders() {
    const corpora: string[][] = [];
    const systems: string[] = [];
    for (const name of ['buildLibrarianPrompt', 'buildOpsExtractPrompt', 'buildHealPrompt'] as const) {
      const orig = (PromptService.prototype as any)[name];
      vi.spyOn(PromptService.prototype as any, name).mockImplementation(function (this: unknown, ...args: unknown[]) {
        const out = orig.apply(this, args);
        if (out.groundingCorpus) corpora.push(out.groundingCorpus);
        systems.push(out.systemPrompt);
        return out;
      });
    }
    return { corpora, systems };
  }

  it.each(['ops', 'legacy'] as const)('%s librarian: corpus is guidance-free, grounding block last', async (strategy) => {
    const { corpora, systems } = spyBuilders();
    const { db, wiki } = await mk({ ...GROUNDED_CFG, librarian: { strategy } }, () => ({ facts: [], tasks: [] }));
    await addEvent(db, 'Observed the engine printing tables');
    await wiki.runLibrarian('u');
    expect(corpora.length).toBeGreaterThan(0);
    expect(JSON.stringify(corpora)).not.toContain(SENTINEL_TOKEN);
    const sys = systems[0];
    expect(sys).toContain(SENTINEL);
    expect(sys).toContain(GROUNDING_MARK);
    expect(sys.indexOf(LEAVE_OUT_RULE_SENTENCE)).toBeLessThan(sys.indexOf(GROUNDING_MARK));
    expect(sys.indexOf(SENTINEL)).toBeLessThan(sys.indexOf(GROUNDING_MARK));
    expect(sys.lastIndexOf(GROUNDING_MARK)).toBe(sys.indexOf(GROUNDING_MARK)); // block appears once, at the tail
  });

  it('heal: corpus is guidance-free', async () => {
    const { corpora } = spyBuilders();
    const { db, wiki } = await mk(GROUNDED_CFG, () => ({ downgraded: [], deleted: [], newFacts: [] }));
    await addCandidate(db);
    await wiki.write('u', { event_type: 'observation', summary: 'Operator observed the engine' });
    await wiki.runHeal('u');
    expect(corpora.length).toBeGreaterThan(0);
    expect(JSON.stringify(corpora)).not.toContain(SENTINEL_TOKEN);
  });
});

describe('ingest corpus excludes guidance (spec test item 3, ingest writer)', () => {
  it('a fact quoting the guidance sentinel as evidence fails grounding; the prompt did carry the guidance', async () => {
    const DOC = 'The Analytical Engine was designed by Charles Babbage in 1837.';
    const { wiki, diagnostics, prompts } = await mk(
      { prompts: { guidance: SENTINEL }, grounding: { mode: 'draft', writers: ['ingest'] } },
      () => ({ facts: [{ title: 'T', body: 'b', tags: [], confidence: 'certain', evidence: [SENTINEL] }] }),
    );
    await wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: 'a'.repeat(64), documentChunk: DOC });
    expect(prompts[0].systemPrompt).toContain(SENTINEL);
    expect(prompts[0].systemPrompt).toContain(GROUNDING_MARK);
    expect(ofCode(diagnostics, 'grounding_failed')).toHaveLength(1);
  });
});

describe('instructions surface read diagnostic (spec test item 7)', () => {
  it('over-cap guidance: guidance_too_long with operation read', async () => {
    const over = await mk({ prompts: { guidance: 'x'.repeat(2001) } }, () => ({}));
    const t = await over.wiki.getInstructions('e');
    const d = ofCode(over.diagnostics, 'guidance_too_long');
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ operation: 'read', detail: { guidanceLength: 2001, guidanceSource: 'default' } });
    for (const k of ['ingest', 'librarian'] as const) {
      expect(t[k]).not.toContain(SECTION_MARK);
      expect(t[k]).not.toContain(LEAVE_OUT_RULE_SENTENCE);
    }
  });

  it('within-cap guidance: no diagnostic; ingest/librarian carry the section; heal/backfill do not', async () => {
    const ok = await mk({ prompts: { guidance: SENTINEL } }, () => ({}));
    const t = await ok.wiki.getInstructions('e');
    expect(ok.diagnostics.filter((x) => x.code.startsWith('guidance_'))).toEqual([]);
    for (const k of ['ingest', 'librarian'] as const) {
      expect(t[k]).toContain(SECTION_MARK);
      expect(t[k]).toContain(SENTINEL);
    }
    for (const k of ['heal', 'ontologyBackfill'] as const) expect(t[k]).not.toContain(SECTION_MARK);
  });
});

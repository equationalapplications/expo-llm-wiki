import { describe, it, expect } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { classifyCandidate, resolveGateConfig, type Neighbour } from '../src/services/librarian/ops/gate';
import type { Candidate } from '../src/services/librarian/ops/extract';

const cfg = resolveGateConfig();
const n = (id: string, title: string, score: number | null, body = 'b'): Neighbour =>
  ({ id, ref: 'n1', title, body, source_type: 'librarian_inferred', score });

describe('classifyCandidate', () => {
  it('identical normalised text is NOOP in either mode', () => {
    expect(classifyCandidate({ title: 'User likes tea!', body: 'b' }, [n('f1', 'user likes TEA', null)], cfg, 'keyword'))
      .toEqual({ kind: 'noop', target: 'f1' });
  });
  it('no neighbours is ADD', () => {
    expect(classifyCandidate({ title: 't', body: 'b' }, [], cfg, 'vector')).toEqual({ kind: 'add' });
  });
  it('high cosine + similar title is NOOP', () => {
    expect(classifyCandidate({ title: 'User drinks green tea daily', body: 'x' }, [n('f1', 'User drinks green tea every day', 0.98)], cfg, 'vector'))
      .toEqual({ kind: 'noop', target: 'f1' });
  });
  it('high cosine but a contradicting title is AMBIGUOUS, not NOOP (the Seattle/SF case)', () => {
    expect(classifyCandidate({ title: 'User moved to San Francisco', body: 'x' }, [n('f1', 'User lives in Seattle area', 0.98)], cfg, 'vector'))
      .toEqual({ kind: 'ambiguous' });
  });
  it('low cosine is ADD', () => {
    expect(classifyCandidate({ title: 'User owns a cat', body: 'x' }, [n('f1', 'User lives in Seattle', 0.3)], cfg, 'vector')).toEqual({ kind: 'add' });
  });
  it('middle band is AMBIGUOUS', () => {
    expect(classifyCandidate({ title: 'User works at Acme', body: 'x' }, [n('f1', 'User works at Globex', 0.8)], cfg, 'vector')).toEqual({ kind: 'ambiguous' });
  });
  it('boundaries: exactly novelThreshold is not ADD; exactly dupThreshold can be NOOP', () => {
    expect(classifyCandidate({ title: 'a b c d', body: 'x' }, [n('f1', 'e f g h', 0.55)], cfg, 'vector')).toEqual({ kind: 'ambiguous' });
    expect(classifyCandidate({ title: 'user drinks green tea', body: 'x' }, [n('f1', 'user drinks green tea daily', 0.97)], cfg, 'vector'))
      .toEqual({ kind: 'noop', target: 'f1' });
  });
  it('keyword mode with hits is AMBIGUOUS', () => {
    expect(classifyCandidate({ title: 'User works at Acme', body: 'x' }, [n('f1', 'User works at Globex', null)], cfg, 'keyword')).toEqual({ kind: 'ambiguous' });
  });
});

describe('gateCandidates', () => {
  it('classifies candidates against current facts in vector mode', async () => {
    const db = openTestDatabase();
    const embed = async (t: string) => [t.includes('Seattle') ? 1 : 0, t.includes('tea') ? 1 : 0, 0.1];
    const wiki = new WikiMemory(db, {
      llmProvider: { generateText: async () => '{}', embed },
      config: { autoLibrarianThreshold: 1000 },
    });
    await wiki.setup();
    // Two live current facts (will be embedded by runReembed)
    await db.runAsync(`INSERT INTO llm_wiki_entries (id, entity_id, title, body, source_type, confidence, created_at, updated_at, valid_from, valid_to)
      VALUES ('seattle','u','User lives in Seattle','b','user_stated','certain',1,1,0,NULL)`);
    await db.runAsync(`INSERT INTO llm_wiki_entries (id, entity_id, title, body, source_type, confidence, created_at, updated_at, valid_from, valid_to)
      VALUES ('tea','u','User drinks green tea','b','user_stated','certain',1,1,0,NULL)`);
    // One superseded fact (should never be offered as a neighbour)
    await db.runAsync(`INSERT INTO llm_wiki_entries (id, entity_id, title, body, source_type, confidence, created_at, updated_at, valid_from, valid_to, superseded_by)
      VALUES ('old_seattle','u','User lived in Seattle','b','user_stated','certain',1,1,0,5,'seattle')`);
    await wiki.runReembed();
    await (wiki.__testAccess.searchService as any).sync();

    const ms = wiki.__testAccess.maintenanceService as any;
    const deps = ms.librarianDeps();

    const mkCandidate = (index: number, title: string): Candidate => ({
      index,
      fact: { title, body: 'b', tags: [], confidence: 'certain' },
      sourceLabel: null,
      validFrom: 0,
    });

    const candidates = [
      mkCandidate(0, 'User lives in Seattle'),         // exact duplicate -> gate NOOP
      mkCandidate(1, 'User drinks green tea daily'),   // tea variant -> vector neighbour
      mkCandidate(2, 'User lives in Seattle'),         // in-batch duplicate of candidate 0
    ];

    const out = await (await import('../src/services/librarian/ops/gate')).gateCandidates(
      deps,
      { entityId: 'u', trigger: 'call' },
      candidates,
      cfg,
    );

    // The superseded fact never appears in any neighbours list
    for (const g of out.gated) {
      for (const nb of g.neighbours) {
        expect(nb.id).not.toBe('old_seattle');
      }
    }

    // Neighbour refs are n1..nk in rank order
    for (const g of out.gated) {
      g.neighbours.forEach((nb, i) => expect(nb.ref).toBe(`n${i + 1}`));
    }

    // In-batch duplicate: the third candidate is in inBatchDuplicates
    expect(out.inBatchDuplicates).toHaveLength(1);
    expect(out.inBatchDuplicates[0].fact.title).toBe('User lives in Seattle');
    expect(out.inBatchDuplicates[0].index).toBe(2);

    // Decisions match classifyCandidate for the computed scores
    expect(out.gated).toHaveLength(2);
    const [dup, tea] = out.gated;
    expect(dup.decision).toEqual(classifyCandidate(dup.candidate.fact, dup.neighbours, cfg, 'vector'));
    expect(tea.decision).toEqual(classifyCandidate(tea.candidate.fact, tea.neighbours, cfg, 'vector'));

    // The duplicate candidate's title normalizes equal to its best neighbour
    expect(dup.decision.kind).toBe('noop');
    if (dup.decision.kind === 'noop') expect(dup.decision.target).toBe('seattle');

    // The tea variant's best score is the tea-driver neighbour
    expect(tea.decision.kind).toBe('noop');
    if (tea.decision.kind === 'noop') expect(tea.decision.target).toBe('tea');

    // gateDiagnostic counts add up
    expect(out.gateDiagnostic.code).toBe('librarian_gate');
    expect(out.gateDiagnostic.operation).toBe('librarian');
    expect(out.gateDiagnostic.trigger).toBe('call');
    expect(out.gateDiagnostic.entityId).toBe('u');
    const counts = out.gateDiagnostic.detail as { gateNoop?: number; gateAdd?: number; gateAmbiguous?: number };
    const sum = (counts.gateNoop ?? 0) + (counts.gateAdd ?? 0) + (counts.gateAmbiguous ?? 0);
    expect(sum).toBe(out.gated.length);
  });
});

import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeDiagnosticWiki, ofCode, expectNoContent, factRows, GROUNDED, HASH_A, HASH_B } from './helpers/groundingHarness';
import type { LLMProvider, WikiOptions } from '../src/types';
import { MaintenanceService } from '../src/services/MaintenanceService';

afterEach(() => vi.restoreAllMocks());

const ANCHOR_BODY = 'Babbage designed the difference engine to tabulate polynomial functions.';
const DRAFT_ANCHOR_BODY = 'The engine design drawings were archived in London for decades.';
const EVENT = 'Operator observed the engine printing tables at dawn.';
const CANDIDATE_BODY = 'Candidate claims the engine design used steam power throughout.';
const HEAL_ON = { grounding: { mode: 'draft' as const, writers: ['heal' as const] } };
const newFact = (title: string, evidence: string[]) => ({ title, body: `${title} body`, tags: [], confidence: 'inferred', evidence });
const isHeal = (p: { userPrompt: string }) => p.userPrompt.startsWith('Heal Candidates') || p.userPrompt === 'Please heal the memory graph.';

async function healWiki(config: object, onHeal: (p: { systemPrompt: string; userPrompt: string }, n: number) => string) {
  let healCalls = 0;
  const generateText: LLMProvider['generateText'] = async (p) => {
    if (isHeal(p)) return onHeal(p, ++healCalls);
    const body = p.userPrompt.includes('drawings') ? DRAFT_ANCHOR_BODY : ANCHOR_BODY;
    const title = p.userPrompt.includes('drawings') ? 'Engine design archive' : 'Engine design history';
    return JSON.stringify({ facts: [{ title, body, tags: [], confidence: 'certain' }] });
  };
  const h = await makeDiagnosticWiki({ config, generateText });
  await h.wiki.ingestDocument('e1', { sourceRef: 'history.md', sourceHash: HASH_A, documentChunk: 'history' });
  await h.wiki.ingestDocument('e1', { sourceRef: 'archive.md', sourceHash: HASH_B, documentChunk: 'drawings' });
  const now = Date.now();
  await h.db.runAsync(
    `INSERT INTO llm_wiki_entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at)
     VALUES ('cand', 'e1', 'Engine design notes', ?, '[]', 'inferred', 'librarian_inferred', ?, ?)`,
    [CANDIDATE_BODY, now, now],
  );
  await h.wiki.write('e1', { event_type: 'observation', summary: EVENT });
  const rows = await factRows(h.db);
  const draftAnchorId = rows.find((r) => r.title === 'Engine design archive')!.id;
  await h.wiki.setLifecycleStatus(draftAnchorId, 'e1', 'draft');
  return h;
}

const healRow = async (db: Parameters<typeof factRows>[0], title: string) => (await factRows(db)).find((r) => r.title === title)!;
const respond = (...facts: object[]) => JSON.stringify({ downgraded: [], deleted: [], newFacts: facts });

describe('heal grounding', () => {
  it('shows anchor bodies only when heal is a grounding writer', async () => {
    const seen: string[] = [];
    const off = await healWiki({}, (p) => { seen.push(p.userPrompt); return respond(); });
    await off.wiki.runHeal('e1');
    expect(seen[0]).not.toContain(ANCHOR_BODY);
    // Off-mode candidates keep their pre-grounding shape, trust fields included.
    expect(seen[0]).toContain('"lifecycle_status"');
    seen.length = 0;
    const on = await healWiki(HEAL_ON, (p) => { seen.push(p.userPrompt); return respond(); });
    await on.wiki.runHeal('e1');
    expect(seen[0]).toContain(ANCHOR_BODY);
    expect(seen[0]).not.toContain('lifecycle_status');
  });

  it('grounds on a non-draft anchor body and on an event summary; fails on a draft anchor and on a candidate', async () => {
    const prompts: string[] = [];
    const h = await healWiki(HEAL_ON, (p) => {
      prompts.push(p.userPrompt);
      return respond(
        newFact('Anchor quote', ['to tabulate polynomial functions']),
        newFact('Event quote', ['printing tables at dawn']),
        newFact('Draft anchor quote', ['archived in London for decades']),
        newFact('Candidate quote', ['used steam power throughout']),
      );
    });
    await h.wiki.runHeal('e1');
    expect(prompts[0]).toContain(DRAFT_ANCHOR_BODY); // shown to the model, but not corpus
    expect(await healRow(h.db, 'Anchor quote')).toMatchObject({ lifecycle_status: 'stable', okf_verified: GROUNDED });
    expect((await healRow(h.db, 'Event quote')).lifecycle_status).toBe('stable');
    const draftQuote = await healRow(h.db, 'Draft anchor quote');
    const candQuote = await healRow(h.db, 'Candidate quote');
    expect([draftQuote.lifecycle_status, candQuote.lifecycle_status]).toEqual(['draft', 'draft']);
    expect(ofCode(h.diagnostics, 'grounding_failed').map((d) => d.detail)).toEqual([
      { factId: draftQuote.id, itemIndex: 2, reason: 'quote_not_found' },
      { factId: candQuote.id, itemIndex: 3, reason: 'quote_not_found' },
    ]);
    for (const d of ofCode(h.diagnostics, 'grounding_failed')) expect(d).toMatchObject({ operation: 'heal', trigger: 'call' });
    expectNoContent(h.diagnostics, ['archived in London', 'steam power', 'Candidate quote body']);
  });

  it('at L2 and above only anchors remain in the corpus', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let l2Prompt = '';
    const h = await healWiki(HEAL_ON, (p, n) => {
      if (n <= 2) throw new Error('Model response truncated at the 16384-token limit');
      l2Prompt = p.userPrompt;
      return respond(newFact('L2 event', ['printing tables at dawn']), newFact('L2 anchor', ['to tabulate polynomial functions']));
    });
    await h.wiki.runHeal('e1');
    expect(l2Prompt).toContain(ANCHOR_BODY);
    expect(l2Prompt).not.toContain(EVENT);
    expect((await healRow(h.db, 'L2 event')).lifecycle_status).toBe('draft');
    expect((await healRow(h.db, 'L2 anchor')).lifecycle_status).toBe('stable');
  });

  it('placeholder template: block appended, bodies hydrated, grounding works', async () => {
    let system = '';
    const h = await healWiki(
      { ...HEAL_ON, prompts: { healSystemPrompt: 'Heal: {{healCandidates}} anchors {{documentAnchors}} events {{recentEvents}}' } },
      (p) => {
        system = p.systemPrompt;
        return respond(newFact('Placeholder anchor', ['to tabulate polynomial functions']));
      },
    );
    await h.wiki.runHeal('e1');
    expect(system).toContain(ANCHOR_BODY);
    expect(system).toContain('EVIDENCE REQUIREMENT');
    expect((await healRow(h.db, 'Placeholder anchor')).lifecycle_status).toBe('stable');
  });

  it('heal outside grounding.writers: new facts stable, trust untouched', async () => {
    const h = await healWiki({ grounding: { mode: 'draft' } }, () => respond(newFact('Ungated', [])));
    await h.wiki.runHeal('e1');
    expect(await healRow(h.db, 'Ungated')).toMatchObject({ lifecycle_status: 'stable', okf_verified: null });
  });
});

describe('MaintenanceService fallback PromptService', () => {
  it('honours config.grounding when constructed without a PromptService', () => {
    const options = { config: { grounding: { mode: 'draft', writers: ['librarian', 'heal'] } } } as unknown as WikiOptions;
    const args = [{}, 'llm_wiki_', options, {}, {}, {}, {}, {}, {}, {}, {}] as unknown as ConstructorParameters<typeof MaintenanceService>;
    const svc = new MaintenanceService(...args) as unknown as { promptService: { groundingFor(w: string): unknown } };
    expect(svc.promptService.groundingFor('heal')).not.toBeNull();
    expect(svc.promptService.groundingFor('librarian')).not.toBeNull();
  });
});

import { describe, it, expect, vi } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { ofCode } from './helpers/diagnosticsHarness';
import type { WikiDiagnostic } from '../src/types';

const embed = async (t: string) => [/seattle/i.test(t) ? 1 : 0, /san francisco/i.test(t) ? 1 : 0, /lives|moved/i.test(t) ? 1 : 0, 0.5];

function mk(responses: Array<(p: { systemPrompt: string; userPrompt: string }) => unknown>) {
  const db = openTestDatabase();
  const diagnostics: WikiDiagnostic[] = [];
  let i = 0;
  const generateText = vi.fn(async (p: { systemPrompt: string; userPrompt: string }) => JSON.stringify(responses[i++](p)));
  const embedSpy = vi.fn(embed);
  const wiki = new WikiMemory(db, {
    llmProvider: { generateText, embed: embedSpy },
    config: { autoLibrarianThreshold: 1000, librarian: { strategy: 'ops' } },
    onDiagnostic: (d) => diagnostics.push(d),
  });
  return { db, wiki, generateText, diagnostics, embed: embedSpy };
}

describe('ops librarian end to end', () => {
  it('SUPERSEDEs Seattle with San Francisco and advances the watermark', async () => {
    const { db, wiki, generateText } = mk([
      () => ({ facts: [{ title: 'User moved to San Francisco', body: 'Moved in March', tags: [], confidence: 'certain', source_event: 'e1' }], tasks: [] }),
      (p) => { expect(p.userPrompt).toContain('"ref":"n1"'); return { ops: [{ item: 0, op: 'SUPERSEDE', target: 'n1' }] }; },
    ]);
    await wiki.setup();
    await db.runAsync(`INSERT INTO llm_wiki_entries (id, entity_id, title, body, source_type, confidence, created_at, updated_at)
      VALUES ('seattle','u','User lives in Seattle','b','user_stated','certain',1,1)`);
    await wiki.runReembed();
    await db.runAsync(`INSERT INTO llm_wiki_events (id, entity_id, event_type, summary, created_at, occurred_at) VALUES ('evt_1','u','observation','I moved to San Francisco',100,90)`);
    await wiki.runLibrarian('u');
    expect(generateText).toHaveBeenCalledTimes(2);
    const old = await db.getFirstAsync<any>(`SELECT valid_to, superseded_by FROM llm_wiki_entries WHERE id='seattle'`);
    expect(old.valid_to).toBe(90);
    const sf = await db.getFirstAsync<any>(`SELECT id, valid_from FROM llm_wiki_entries WHERE id = ?`, [old.superseded_by]);
    expect(sf.valid_from).toBe(90);
    expect((await wiki.read('u', 'where does the user live')).facts.map((f) => f.id)).not.toContain('seattle');
    expect(await (wiki.__testAccess as any).metadataRepo.getLibrarianWatermark('u')).toEqual({ at: 100, id: 'evt_1' });
  });

  it('skips the resolve call entirely when every candidate is gated', async () => {
    const { db, wiki, generateText } = mk([
      () => ({ facts: [{ title: 'User has a dog named Rex', body: 'b', tags: [], confidence: 'certain', source_event: 'e1' }], tasks: [] }),
    ]);
    await wiki.setup();
    await db.runAsync(`INSERT INTO llm_wiki_events (id, entity_id, event_type, summary, created_at) VALUES ('evt_1','u','observation','dog',100)`);
    await wiki.runLibrarian('u');
    expect(generateText).toHaveBeenCalledTimes(1);
    expect((await db.getAllAsync(`SELECT 1 FROM llm_wiki_entries`)).length).toBe(1);
  });

  it('a resolve failure stores the candidate as a draft', async () => {
    const { db, wiki, diagnostics } = mk([
      () => ({ facts: [{ title: 'User lives in San Francisco now', body: 'b', tags: [], confidence: 'certain', source_event: 'e1' }], tasks: [] }),
      () => ({ nonsense: true }),
      () => ({ nonsense: true }),
      () => ({ nonsense: true }),
      () => ({ nonsense: true }),
    ]);
    await wiki.setup();
    await db.runAsync(`INSERT INTO llm_wiki_entries (id, entity_id, title, body, source_type, confidence, created_at, updated_at)
      VALUES ('seattle','u','User lives in Seattle','b','user_stated','certain',1,1)`);
    await wiki.runReembed();
    await db.runAsync(`INSERT INTO llm_wiki_events (id, entity_id, event_type, summary, created_at) VALUES ('evt_1','u','observation','x',100)`);
    await wiki.runLibrarian('u');
    const draft = await db.getFirstAsync<any>(`SELECT lifecycle_status FROM llm_wiki_entries WHERE id != 'seattle'`);
    expect(draft.lifecycle_status).toBe('draft');
    expect(ofCode(diagnostics, 'resolve_failed')).toHaveLength(1);
  });

  it('a transient resolve provider error aborts the pass without drafting or advancing the watermark', async () => {
    const { db, wiki } = mk([
      () => ({ facts: [{ title: 'User lives in San Francisco now', body: 'b', tags: [], confidence: 'certain', source_event: 'e1' }], tasks: [] }),
      () => { throw new Error('HTTP 429 Too Many Requests'); },
    ]);
    await wiki.setup();
    await db.runAsync(`INSERT INTO llm_wiki_entries (id, entity_id, title, body, source_type, confidence, created_at, updated_at)
      VALUES ('seattle','u','User lives in Seattle','b','user_stated','certain',1,1)`);
    await wiki.runReembed();
    await db.runAsync(`INSERT INTO llm_wiki_events (id, entity_id, event_type, summary, created_at) VALUES ('evt_1','u','observation','x',100)`);
    await expect(wiki.runLibrarian('u')).rejects.toThrow();
    expect(await db.getAllAsync(`SELECT id FROM llm_wiki_entries WHERE id != 'seattle'`)).toEqual([]);
    expect(await (wiki.__testAccess as any).metadataRepo.getLibrarianWatermark('u')).toBeNull();
  });

  it('re-embeds a superseding fact whose text came from UPDATE overrides', async () => {
    const { db, wiki, embed } = mk([
      () => ({ facts: [{ title: 'User lives in San Francisco now', body: 'b', tags: [], confidence: 'certain', source_event: 'e1' }], tasks: [] }),
      () => ({ ops: [{ item: 0, op: 'UPDATE', target: 'n1', title: 'User lives in San Francisco (merged)', body: 'merged body' }] }),
    ]);
    await wiki.setup();
    await db.runAsync(`INSERT INTO llm_wiki_entries (id, entity_id, title, body, source_type, confidence, created_at, updated_at)
      VALUES ('seattle','u','User lives in Seattle','b','user_stated','certain',1,1)`);
    await wiki.runReembed();
    await db.runAsync(`INSERT INTO llm_wiki_events (id, entity_id, event_type, summary, created_at) VALUES ('evt_1','u','observation','x',100)`);
    await wiki.runLibrarian('u');
    const old = await db.getFirstAsync<any>(`SELECT superseded_by FROM llm_wiki_entries WHERE id='seattle'`);
    expect(old.superseded_by).toEqual(expect.any(String));
    expect(embed.mock.calls.some(([t]) => t.includes('merged body'))).toBe(true);
  });

  it('an invented target falls back to ADD with librarian_op_rejected', async () => {
    const { db, wiki, diagnostics } = mk([
      () => ({ facts: [{ title: 'User lives in San Francisco now', body: 'b', tags: [], confidence: 'certain', source_event: 'e1' }], tasks: [] }),
      () => ({ ops: [{ item: 0, op: 'SUPERSEDE', target: 'n7' }] }),
    ]);
    await wiki.setup();
    await db.runAsync(`INSERT INTO llm_wiki_entries (id, entity_id, title, body, source_type, confidence, created_at, updated_at)
      VALUES ('seattle','u','User lives in Seattle','b','user_stated','certain',1,1)`);
    await wiki.runReembed();
    await db.runAsync(`INSERT INTO llm_wiki_events (id, entity_id, event_type, summary, created_at) VALUES ('evt_1','u','observation','x',100)`);
    await wiki.runLibrarian('u');
    expect((await db.getFirstAsync<any>(`SELECT superseded_by FROM llm_wiki_entries WHERE id='seattle'`)).superseded_by).toBeNull();
    expect(ofCode(diagnostics, 'librarian_op_rejected')).toHaveLength(1);
  });

  it('SUPERSEDE of an immutable document stores a draft and reports contradicts_document', async () => {
    const { db, wiki, diagnostics } = mk([
      () => ({ facts: [{ title: 'User lives in San Francisco now', body: 'b', tags: [], confidence: 'certain', source_event: 'e1' }], tasks: [] }),
      () => ({ ops: [{ item: 0, op: 'SUPERSEDE', target: 'n1' }] }),
    ]);
    await wiki.setup();
    await db.runAsync(`INSERT INTO llm_wiki_entries (id, entity_id, title, body, source_type, confidence, created_at, updated_at)
      VALUES ('doc','u','User lives in Seattle','b','immutable_document','certain',1,1)`);
    await wiki.runReembed();
    await db.runAsync(`INSERT INTO llm_wiki_events (id, entity_id, event_type, summary, created_at) VALUES ('evt_1','u','observation','x',100)`);
    await wiki.runLibrarian('u');
    expect((await db.getFirstAsync<any>(`SELECT superseded_by FROM llm_wiki_entries WHERE id='doc'`)).superseded_by).toBeNull();
    expect(ofCode(diagnostics, 'contradicts_document')).toHaveLength(1);
  });

  it('UPDATE on a librarian_inferred target edits title/body in place', async () => {
    const { db, wiki, generateText, diagnostics } = mk([
      // The candidate title must differ enough from the stored title (jaccard
      // < FUZZY_THRESHOLD) so the gate does not collapse it to NOOP; the
      // cosine stays 1 because both texts miss all three keyword dims, but
      // the title check breaks the noop tie.
      () => ({ facts: [{ title: 'User is a senior engineer at Acme', body: 'Staff engineer since 2020', tags: [], confidence: 'certain', source_event: 'e1' }], tasks: [] }),
      (p) => { expect(p.userPrompt).toContain('"ref":"n1"'); return { ops: [{ item: 0, op: 'UPDATE', target: 'n1', title: 'User is a principal engineer at Acme', body: 'Principal engineer since 2020' }] }; },
    ]);
    await wiki.setup();
    await db.runAsync(`INSERT INTO llm_wiki_entries (id, entity_id, title, body, source_type, confidence, created_at, updated_at)
      VALUES ('acme','u','User works at Acme','Engineer since 2020','librarian_inferred','certain',1,1)`);
    await wiki.runReembed();
    await db.runAsync(`INSERT INTO llm_wiki_events (id, entity_id, event_type, summary, created_at) VALUES ('evt_1','u','observation','promoted',100)`);
    await wiki.runLibrarian('u');
    expect(generateText).toHaveBeenCalledTimes(2);
    const row = await db.getFirstAsync<any>(`SELECT title, body, superseded_by FROM llm_wiki_entries WHERE id='acme'`);
    expect(row.title).toBe('User is a principal engineer at Acme');
    expect(row.body).toBe('Principal engineer since 2020');
    expect(row.superseded_by).toBeNull();
    // Single row still — UPDATE edits in place; no new fact_ row appended.
    expect((await db.getAllAsync(`SELECT id FROM llm_wiki_entries`)).map((r: any) => r.id)).toEqual(['acme']);
    expect(ofCode(diagnostics, 'librarian_op_rejected')).toHaveLength(0);
  });

  it('UPDATE on a user_stated target is applied as SUPERSEDE', async () => {
    const { db, wiki, generateText, diagnostics } = mk([
      () => ({ facts: [{ title: 'User is a senior engineer at Acme', body: 'Staff engineer since 2020', tags: [], confidence: 'certain', source_event: 'e1' }], tasks: [] }),
      (p) => { expect(p.userPrompt).toContain('"ref":"n1"'); return { ops: [{ item: 0, op: 'UPDATE', target: 'n1', title: 'User is a principal engineer at Acme', body: 'Principal engineer since 2020' }] }; },
    ]);
    await wiki.setup();
    await db.runAsync(`INSERT INTO llm_wiki_entries (id, entity_id, title, body, source_type, confidence, created_at, updated_at)
      VALUES ('acme','u','User works at Acme','Engineer since 2020','user_stated','certain',1,1)`);
    await wiki.runReembed();
    await db.runAsync(`INSERT INTO llm_wiki_events (id, entity_id, event_type, summary, created_at) VALUES ('evt_1','u','observation','promoted',100)`);
    await wiki.runLibrarian('u');
    expect(generateText).toHaveBeenCalledTimes(2);
    const old = await db.getFirstAsync<any>(`SELECT superseded_by FROM llm_wiki_entries WHERE id='acme'`);
    expect(old.superseded_by).not.toBeNull();
    const newRow = await db.getFirstAsync<any>(`SELECT title, body FROM llm_wiki_entries WHERE id=?`, [old.superseded_by]);
    expect(newRow.title).toBe('User is a principal engineer at Acme');
    expect(newRow.body).toBe('Principal engineer since 2020');
    expect(ofCode(diagnostics, 'librarian_op_rejected')).toHaveLength(0);
  });
});

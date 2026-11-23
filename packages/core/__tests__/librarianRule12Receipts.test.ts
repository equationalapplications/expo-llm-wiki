import { describe, it, expect, vi } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { ofCode } from './helpers/diagnosticsHarness';
import type { WikiDiagnostic } from '../src/types';

// specs/type-on-write §9: the librarian's per-fact pass report (INTENT rule 12).
const embed = async (t: string) => [/seattle/i.test(t) ? 1 : 0, /san francisco/i.test(t) ? 1 : 0, /lives|moved/i.test(t) ? 1 : 0, 0.5];

function mk(responses: Array<(p: { systemPrompt: string; userPrompt: string }) => unknown>, strategy: 'ops' | 'legacy' = 'ops') {
  const db = openTestDatabase();
  const diagnostics: WikiDiagnostic[] = [];
  let i = 0;
  const generateText = vi.fn(async (p: { systemPrompt: string; userPrompt: string }) => JSON.stringify(responses[i++](p)));
  const wiki = new WikiMemory(db, {
    llmProvider: { generateText, embed: vi.fn(embed) },
    config: { autoLibrarianThreshold: 1000, librarian: { strategy } },
    onDiagnostic: (d) => diagnostics.push(d),
  });
  return { db, wiki, diagnostics };
}
const seed = async (db: any, wiki: WikiMemory, id: string, title: string, source: string) => {
  await wiki.setup();
  await db.runAsync(`INSERT INTO llm_wiki_entries (id, entity_id, title, body, source_type, confidence, created_at, updated_at)
    VALUES (?, 'u', ?, 'b', ?, 'certain', 1, 1)`, [id, title, source]);
  await wiki.runReembed();
  await db.runAsync(`INSERT INTO llm_wiki_events (id, entity_id, event_type, summary, created_at, occurred_at) VALUES ('evt_1','u','observation','I moved to San Francisco',100,90)`);
};
const fact = (title: string) => ({ facts: [{ title, body: 'Moved in March', tags: [], confidence: 'certain', source_event: 'e1' }], tasks: [] });

describe('rule-12 librarian receipts (type-on-write §9)', () => {
  it('an in-place UPDATE of a librarian_inferred fact emits one librarian_rewritten naming the existing id', async () => {
    const { db, wiki, diagnostics } = mk([
      () => fact('User is a senior engineer at Acme'),
      () => ({ ops: [{ item: 0, op: 'UPDATE', target: 'n1', title: 'User is a principal engineer at Acme', body: 'Principal' }] }),
    ]);
    await seed(db, wiki, 'acme', 'User works at Acme', 'librarian_inferred');
    await wiki.runLibrarian('u');
    const r = ofCode(diagnostics, 'librarian_rewritten');
    expect(r).toHaveLength(1);
    expect(r[0].detail).toEqual({ factId: 'acme' });
    expect(r[0].severity).toBe('info');
    expect(r[0].operation).toBe('librarian');
    expect(JSON.stringify(r[0])).not.toContain('principal');
    expect(ofCode(diagnostics, 'librarian_superseded')).toHaveLength(0);
  });

  it('a SUPERSEDE emits one librarian_superseded with the old and new ids', async () => {
    const { db, wiki, diagnostics } = mk([
      () => fact('User moved to San Francisco'),
      () => ({ ops: [{ item: 0, op: 'SUPERSEDE', target: 'n1' }] }),
    ]);
    await seed(db, wiki, 'seattle', 'User lives in Seattle', 'user_stated');
    await wiki.runLibrarian('u');
    const old = await db.getFirstAsync<any>(`SELECT superseded_by FROM llm_wiki_entries WHERE id='seattle'`);
    const s = ofCode(diagnostics, 'librarian_superseded');
    expect(s).toHaveLength(1);
    expect(s[0].detail).toEqual({ factId: 'seattle', replacementId: old.superseded_by });
    expect(ofCode(diagnostics, 'librarian_rewritten')).toHaveLength(0);
  });

  it('UPDATE of a non-librarian target is applied as a supersede and receipts librarian_superseded only', async () => {
    const { db, wiki, diagnostics } = mk([
      () => fact('User is a senior engineer at Acme'),
      () => ({ ops: [{ item: 0, op: 'UPDATE', target: 'n1', title: 'User is a principal engineer', body: 'P' }] }),
    ]);
    await seed(db, wiki, 'acme', 'User works at Acme', 'user_stated');
    await wiki.runLibrarian('u');
    expect(ofCode(diagnostics, 'librarian_superseded')).toHaveLength(1);
    expect(ofCode(diagnostics, 'librarian_rewritten')).toHaveLength(0);
  });

  it('a WikiSupersedeError emits librarian_op_rejected and no librarian_superseded', async () => {
    let expire = () => {};
    let pending: Promise<unknown> = Promise.resolve();
    const { db, wiki, diagnostics } = mk([
      () => fact('User moved to San Francisco'),
      () => { expire(); return { ops: [{ item: 0, op: 'SUPERSEDE', target: 'n1' }] }; },
    ]);
    expire = () => { pending = db.runAsync(`UPDATE llm_wiki_entries SET valid_to = 50 WHERE id = 'seattle'`); };
    await seed(db, wiki, 'seattle', 'User lives in Seattle', 'user_stated');
    await wiki.runLibrarian('u');
    await pending;
    expect(ofCode(diagnostics, 'librarian_op_rejected')).toHaveLength(1);
    expect(ofCode(diagnostics, 'librarian_superseded')).toHaveLength(0);
  });

  it('an immutable_document target emits contradicts_document and neither rule-12 code', async () => {
    const { db, wiki, diagnostics } = mk([
      () => fact('User moved to San Francisco'),
      () => ({ ops: [{ item: 0, op: 'UPDATE', target: 'n1', title: 'x', body: 'y' }] }),
    ]);
    await seed(db, wiki, 'doc', 'User lives in Seattle', 'immutable_document');
    await wiki.runLibrarian('u');
    expect(ofCode(diagnostics, 'contradicts_document')).toHaveLength(1);
    expect(ofCode(diagnostics, 'librarian_rewritten')).toHaveLength(0);
    expect(ofCode(diagnostics, 'librarian_superseded')).toHaveLength(0);
  });

  it('a pass whose transaction throws emits neither code', async () => {
    const { db, wiki, diagnostics } = mk([
      () => fact('User is a senior engineer at Acme'),
      () => ({ ops: [{ item: 0, op: 'UPDATE', target: 'n1', title: 'User is a principal engineer at Acme', body: 'P' }] }),
    ]);
    await seed(db, wiki, 'acme', 'User works at Acme', 'librarian_inferred');
    const orig = db.withTransactionAsync.bind(db);
    db.withTransactionAsync = (async (fn: any) => orig(async (tx: any) => { await fn(tx); throw new Error('boom'); })) as any;
    await expect(wiki.runLibrarian('u')).rejects.toThrow('boom');
    expect(ofCode(diagnostics, 'librarian_rewritten')).toHaveLength(0);
    expect(ofCode(diagnostics, 'librarian_superseded')).toHaveLength(0);
  });

  it('the legacy strategy is add-only and emits neither code', async () => {
    const { db, wiki, diagnostics } = mk([
      () => ({ facts: [{ title: 'User moved to San Francisco', body: 'b', tags: [], confidence: 'certain' }], tasks: [] }),
    ], 'legacy');
    await seed(db, wiki, 'seattle', 'User lives in Seattle', 'user_stated');
    await wiki.runLibrarian('u');
    expect(ofCode(diagnostics, 'librarian_rewritten')).toHaveLength(0);
    expect(ofCode(diagnostics, 'librarian_superseded')).toHaveLength(0);
  });
});

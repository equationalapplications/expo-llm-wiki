import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { WikiStrictOntologyViolation } from '../src/types';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { OntologyManifest, SQLiteAdapter, WikiDiagnostic } from '../src/types';

let db: SQLiteAdapter;
let wiki: WikiMemory;

const row = (id: string) => db.getFirstAsync<any>(`SELECT * FROM llm_wiki_entries WHERE id = ?`, [id]);
const count = async () => (await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM llm_wiki_entries`))!.n;
const manifest: OntologyManifest = {
  node_types: [{ type: 'Person', description: 'a person' }],
  edge_types: [],
};

beforeEach(async () => {
  db = openTestDatabase();
  wiki = new WikiMemory(db, { llmProvider: { generateText: async () => '{}' } });
  await wiki.setup();
});

describe('remember(): storage', () => {
  it('stores a user_stated fact with defaults and returns the stored row', async () => {
    const before = Date.now();
    const fact = await wiki.remember('e1', { title: 'Prefers merge commits', body: 'Never squash.' });
    expect(fact.id.startsWith('fact_')).toBe(true);
    expect(fact).toMatchObject({
      entity_id: 'e1', title: 'Prefers merge commits', body: 'Never squash.', tags: [],
      confidence: 'certain', source_type: 'user_stated', source_ref: null, source_hash: null,
      access_count: 0, deleted_at: null, okf_type: null, lifecycle_status: 'stable',
      trustTier: 'unverified', isStale: false,
    });
    expect(fact.created_at).toBeGreaterThanOrEqual(before);
    // EntryRepository.upsert re-stamps updated_at with its own clock, so it can trail created_at by a few ms.
    expect(fact.updated_at).toBeGreaterThanOrEqual(fact.created_at);
    expect(fact).not.toHaveProperty('valid_from');
    const stored = await row(fact.id);
    expect(stored).toMatchObject({ entity_id: 'e1', title: 'Prefers merge commits', source_type: 'user_stated', confidence: 'certain' });
    expect(stored.valid_from).toBeNull();
    const [readBack] = await wiki.__testAccess.entryRepo.findByIds([fact.id], ['e1']);
    expect(fact).toEqual(readBack);
  });

  it('stores tags, confidence, source_type and valid_from as given', async () => {
    const fact = await wiki.remember('e1', {
      title: 'Lives in SF', body: 'Moved in March.', tags: ['Place', 'home'],
      confidence: 'inferred', source_type: 'user_confirmed', valid_from: 5_000,
    });
    expect(fact).toMatchObject({ tags: ['Place', 'home'], confidence: 'inferred', source_type: 'user_confirmed', valid_from: 5_000 });
    expect((await row(fact.id)).valid_from).toBe(5_000);
  });

  it('writes nothing when validation rejects', async () => {
    const before = await count();
    await expect(wiki.remember('e1', { title: '', body: 'B' })).rejects.toThrow(TypeError);
    await expect(wiki.remember('', { title: 'T', body: 'B' })).rejects.toThrow(TypeError);
    await expect(wiki.remember('e1', { title: 'T', body: 'B', source_type: 'immutable_document' as any })).rejects.toThrow(TypeError);
    expect(await count()).toBe(before);
  });

  it('stores two facts for two identical calls (not idempotent; spec §3.7)', async () => {
    const a = await wiki.remember('e1', { title: 'T', body: 'B' });
    const b = await wiki.remember('e1', { title: 'T', body: 'B' });
    expect(a.id).not.toBe(b.id);
    expect(await count()).toBe(2);
  });
});

describe('remember(): okf_type (spec §3.4)', () => {
  it('stores null and never reads the manifest when okf_type is absent', async () => {
    const spy = vi.spyOn(wiki.__testAccess.metadataRepo, 'getManifest');
    const fact = await wiki.remember('e1', { title: 'T', body: 'B' });
    expect(fact.okf_type).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('stores the canonical slug when the type is in the manifest (emergent)', async () => {
    await wiki.setOntologyManifest('e1', manifest, { mode: 'emergent' });
    const fact = await wiki.remember('e1', { title: 'Kurt', body: 'Owner.', okf_type: 'person' });
    expect(fact.okf_type).toBe('Person');
  });

  it('throws WikiStrictOntologyViolation and writes nothing for an unknown type under strict', async () => {
    await wiki.setOntologyManifest('e1', manifest, { mode: 'strict' });
    const before = await count();
    await expect(wiki.remember('e1', { title: 'T', body: 'B', okf_type: 'Spaceship' })).rejects.toBeInstanceOf(WikiStrictOntologyViolation);
    expect(await count()).toBe(before);
  });

  it('stores null for an unknown type under emergent, and for an entity with no manifest', async () => {
    await wiki.setOntologyManifest('e1', manifest, { mode: 'emergent' });
    expect((await wiki.remember('e1', { title: 'T', body: 'B', okf_type: 'Spaceship' })).okf_type).toBeNull();
    expect((await wiki.remember('e2', { title: 'T', body: 'B', okf_type: 'Person' })).okf_type).toBeNull();
  });
});

describe('remember(): no maintenance side effects (spec §3.6)', () => {
  it.each([['auto'], ['deferred']] as const)('%s mode: no events, no librarian, no heal, nothing pending', async (maintenance) => {
    const generateText = vi.fn(async () => '{}');
    const localDb = openTestDatabase();
    const local = new WikiMemory(localDb, {
      llmProvider: { generateText },
      config: { maintenance, autoLibrarianThreshold: 1, autoHealThreshold: 1 },
    });
    await local.setup();
    for (let i = 0; i < 3; i++) await local.remember('e1', { title: `T${i}`, body: 'B' });
    await local.drain();
    expect(generateText).not.toHaveBeenCalled();
    expect(await local.getPendingMaintenance(['e1'])).toEqual([]);
    const ev = await localDb.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM llm_wiki_events`);
    expect(ev!.n).toBe(0);
  });
});

describe('remember(): retrieval (spec §3.3 step 5, §3.5)', () => {
  it('is keyword-searchable as soon as remember() resolves, with no embed configured', async () => {
    const fact = await wiki.remember('e1', { title: 'Pet', body: 'The zebraphant sleeps upstairs.' });
    const bundle = await wiki.read('e1', 'zebraphant');
    expect(bundle.facts.map((f) => f.id)).toContain(fact.id);
  });

  it('honours valid_from on asOf reads', async () => {
    const fact = await wiki.remember('e1', { title: 'Pet', body: 'The zebraphant sleeps upstairs.', valid_from: 5_000 });
    expect((await wiki.read('e1', 'zebraphant', { asOf: 4_999 })).facts.map((f) => f.id)).not.toContain(fact.id);
    expect((await wiki.read('e1', 'zebraphant', { asOf: 5_000 })).facts.map((f) => f.id)).toContain(fact.id);
  });

  it('embeds once through llmProvider.embed when it exists', async () => {
    const embed = vi.fn(async (_text: string) => [0.1, 0.2, 0.3]);
    const localDb = openTestDatabase();
    const local = new WikiMemory(localDb, { llmProvider: { generateText: async () => '{}', embed } });
    await local.setup();
    const fact = await local.remember('e1', { title: 'Alpha', body: 'Beta gamma.' });
    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed.mock.calls[0][0]).toContain('Alpha');
    expect(embed.mock.calls[0][0]).toContain('Beta gamma.');
    const stored = await localDb.getFirstAsync<any>(`SELECT embedding_blob FROM llm_wiki_entries WHERE id = ?`, [fact.id]);
    expect(stored.embedding_blob).not.toBeNull();
  });

  it('reports an embed failure as embedding_failed with operation remember and still resolves', async () => {
    const diagnostics: WikiDiagnostic[] = [];
    const local = new WikiMemory(openTestDatabase(), {
      llmProvider: { generateText: async () => '{}', embed: async () => { throw new Error('down'); } },
      onDiagnostic: (d) => { diagnostics.push(d); },
    });
    await local.setup();
    const fact = await local.remember('e1', { title: 'T', body: 'B' });
    expect(fact.id.startsWith('fact_')).toBe(true);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: 'embedding_failed', operation: 'remember', trigger: 'call', entityId: 'e1',
      detail: expect.objectContaining({ factId: fact.id, reason: 'embed_threw' }),
    }));
  });

  it('leaves no failure marker when there is no embed function', async () => {
    const fact = await wiki.remember('e1', { title: 'T', body: 'B' });
    expect((await row(fact.id)).embedding_failed_at).toBeNull();
  });
});

describe('remember(): plays with the rest of the fact API', () => {
  it('can be superseded, shows in history, and can be forgotten', async () => {
    const fact = await wiki.remember('e1', { title: 'Lives in Seattle', body: 'Since 2020.' });
    expect((await wiki.history('e1', fact.id)).map((f) => f.id)).toEqual([fact.id]);
    const { newId } = await wiki.supersede('e1', fact.id, { title: 'Lives in SF', body: 'Moved.' });
    expect((await wiki.history('e1', fact.id)).map((f) => f.id)).toEqual([fact.id, newId]);
    const result = await wiki.forget('e1', { entryId: newId });
    expect(result.deleted.entries).toBe(1);
  });

  it('stages one INSERT outbox row, plus one UPDATE when valid_from is set', async () => {
    const local = new WikiMemory(openTestDatabase(), { llmProvider: { generateText: async () => '{}' }, config: { enableOutbox: true } });
    await local.setup();
    const plain = await local.remember('e1', { title: 'T', body: 'B' });
    const dated = await local.remember('e1', { title: 'T', body: 'B', valid_from: 5_000 });
    const events = await local.getUnprocessedOutboxEvents();
    expect(events.filter((e) => e.record_id === plain.id).map((e) => e.operation)).toEqual(['INSERT']);
    expect(events.filter((e) => e.record_id === dated.id).map((e) => e.operation)).toEqual(['INSERT', 'UPDATE']);
  });
});

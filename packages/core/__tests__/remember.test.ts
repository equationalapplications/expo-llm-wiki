import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { WikiStrictOntologyViolation } from '../src/types';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { OntologyManifest, SQLiteAdapter } from '../src/types';

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

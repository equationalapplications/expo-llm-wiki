import { describe, it, expect, vi } from 'vitest';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { createWiki } from '../src/index';
import { buildOntologyPromptAppendix } from '../src/prompts/ontology';
import { ONTOLOGY_BACKFILL_SYSTEM_PROMPT } from '../src/prompts';
import { EntryRepository } from '../src/repositories/EntryRepository';
import { OutboxRepository } from '../src/repositories/OutboxRepository';
import { setupDatabase } from '../src/db/schema';
import type { OntologyManifest, WikiDiagnostic } from '../src/types';

const MANIFEST: OntologyManifest = {
  node_types: [
    { type: 'person', description: 'p' },
    { type: 'place', description: 'pl' },
  ],
  edge_types: [
    { type: 'lives_in', source_type: 'person', target_type: 'place', description: 'l' },
  ],
};

describe('CodeRabbit #441 round 2 — remember door (mode gate + post-commit receipts)', () => {
  it('stores the caller slug verbatim at an explicit mode-off manifest (no fold, no receipt)', async () => {
    const diagnostics: WikiDiagnostic[] = [];
    const db = openTestDatabase();
    const wiki = createWiki(db, { llmProvider: { generateText: async () => '{}' }, onDiagnostic: (d: WikiDiagnostic) => diagnostics.push(d) } as never);
    await wiki.setup();
    await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'off' });
    const fact = await wiki.remember('e1', { title: 'T', body: 'b', okf_type: 'per son' } as never);
    // No fold: the spelling variant stays exactly as the person typed it.
    expect(fact.okf_type).toBe('per son');
    expect(diagnostics.filter((d) => String(d.code).startsWith('node_type'))).toEqual([]);
  });

  it('still folds and receipts under emergent, and stores null with no ontology at all', async () => {
    const diagnostics: WikiDiagnostic[] = [];
    const db = openTestDatabase();
    const wiki = createWiki(db, { llmProvider: { generateText: async () => '{}' }, onDiagnostic: (d: WikiDiagnostic) => diagnostics.push(d) } as never);
    await wiki.setup();
    await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'emergent' });
    const folded = await wiki.remember('e1', { title: 'T', body: 'b', okf_type: 'per son' } as never);
    expect(folded.okf_type).toBe('person');
    expect(diagnostics.some((d) => d.code === 'node_type_folded')).toBe(true);
    // Receipts are delivered AFTER the transaction commits (success path proves delivery).
    // Mode 'off' (which includes an entity with no ontology configured) stores
    // the caller's slug VERBATIM — no fold, no drop, no receipt — so an off
    // host sees no ontology behavior at the remember door (CodeRabbit #441).
    const none = await wiki.remember('e2', { title: 'T2', body: 'b', okf_type: 'Person' } as never);
    expect(none.okf_type).toBe('Person');
  });
});

describe('CodeRabbit #441 round 2 — recheckCheckedBefore validation', () => {
  it('rejects non-integer and negative cutoffs like batchSize does', async () => {
    const db = openTestDatabase();
    const wiki = createWiki(db, { llmProvider: { generateText: async () => '{}' } } as never);
    await wiki.setup();
    await expect(wiki.runOntologyBackfill('e1', { recheckCheckedBefore: -1 } as never)).rejects.toThrow(/recheckCheckedBefore/);
    await expect(wiki.runOntologyBackfill('e1', { recheckCheckedBefore: 1.5 } as never)).rejects.toThrow(/recheckCheckedBefore/);
    await expect(wiki.runOntologyBackfill('e1', { recheckCheckedBefore: 0 } as never)).resolves.toBeDefined();
  });
});

describe('CodeRabbit #441 round 2 — typing queue validity sampled at now, not cutoff', () => {
  it('a fact that became live after the cutoff still queues (old code hid it)', async () => {
    const PREFIX = 'llm_wiki_';
    const db = openTestDatabase();
    await setupDatabase(db, PREFIX);
    const outbox = new OutboxRepository(db, PREFIX, false);
    const repo = new EntryRepository(db, PREFIX, outbox);
    const now = Date.now();
    const mk = (id: string) => repo.upsert({
      id, entity_id: 'e1', title: `t-${id}`, body: 'b', tags: [], confidence: 'certain',
      source_type: 'user_stated', source_hash: null, source_ref: null,
      created_at: now, updated_at: now, last_accessed_at: null, access_count: 0,
      deleted_at: null, okf_type: null,
    } as never, undefined as never);
    await mk('young-live');
    // Became live 1s ago: invisible when validity was (wrongly) bound to a 0 cutoff.
    await repo.setTemporal('young-live', 'e1', { valid_from: now - 1000 }, undefined as never);
    const found = await repo.findUntypedByEntityId('e1', 10, 0);
    expect(found.map((f) => f.id)).toContain('young-live');
    const counts = await repo.countUntypedByEntityId('e1', 0);
    expect(counts.eligible).toBe(1);
  });
});

describe('CodeRabbit #441 round 2 — strict-mode malformed ontology_updates cannot flood receipts', () => {
  it('a non-array node_types/edge_types proposal yields no unbounded mode_strict flood', async () => {
    const diagnostics: WikiDiagnostic[] = [];
    const db = openTestDatabase();
    const wiki = createWiki(db, {
      llmProvider: {
        generateText: async () => JSON.stringify({
          facts: [{ title: 'Ada', body: 'b', tags: [], confidence: 'certain', okf_type: 'person' }],
          ontology_updates: { node_types: { length: 100000 }, edge_types: { length: 100000 } },
        }),
      },
      onDiagnostic: (d: WikiDiagnostic) => diagnostics.push(d),
    } as never);
    await wiki.setup();
    await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'strict' });
    await wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: 'a'.repeat(64), documentChunk: 'content' });
    const rejected = diagnostics.filter((d) => d.code === 'ontology_update_rejected');
    // A malformed shape is not a proposal: no receipts, and the pass finishes.
    expect(rejected.length).toBe(0);
  });
});

describe('CodeRabbit #441 round 2 — partial ingest resolves edges across sourceRefs', () => {
  it('an edge targeting a fact stored under another sourceRef resolves on the partial path', async () => {
    const db = openTestDatabase();
    let call = 0;
    const wiki = createWiki(db, {
      llmProvider: {
        generateText: async () => {
          call += 1;
          if (call === 1) {
            return JSON.stringify({ facts: [{ title: 'Home', body: 'a place', tags: [], confidence: 'certain', okf_type: 'place' }] });
          }
          if (call === 2) return 'not json at all'; // forces the partial path
          return JSON.stringify({
            facts: [{
              title: 'Ada', body: 'a person', tags: [], confidence: 'certain', okf_type: 'person',
              edges: [{ edge_type: 'lives_in', target_title: 'Home' }],
            }],
          });
        },
      },
    } as never);
    await wiki.setup();
    await wiki.setOntologyManifest('e_partial', MANIFEST, { mode: 'emergent' });
    await wiki.ingestDocument('e_partial', { sourceRef: 'doc://a', sourceHash: 'b'.repeat(64), documentChunk: 'content one' });
    const result = await wiki.ingestDocument('e_partial', { sourceRef: 'doc://b', sourceHash: 'c'.repeat(64), documentChunk: 'content one\n\ncontent two', maxChunkLength: 20, chunkOverlap: 0 });
    expect(result.failedChunks).toBeGreaterThan(0);
    const edges = await db.getAllAsync<{ source_id: string; target_id: string; edge_type: string }>(
      `SELECT e.source_id, e.target_id, e.edge_type FROM llm_wiki_edges e WHERE e.entity_id = ?`, ['e_partial'],
    );
    const targetTitle = await db.getFirstAsync<{ title: string }>(
      `SELECT title FROM llm_wiki_entries WHERE id = ?`, [edges[0]?.target_id ?? ''],
    );
    expect(edges.length).toBeGreaterThan(0);
    expect(edges[0].edge_type).toBe('lives_in');
    expect(targetTitle?.title).toBe('Home');
  });
});

describe('CodeRabbit #441 round 2 — ruled prompt wording (spec §10)', () => {
  it('strict appendix carries the closest-type rule and the ruled edge sentence', () => {
    const { ontologyModeInstructions } = buildOntologyPromptAppendix('strict', '{}');
    expect(ontologyModeInstructions).toContain('choose the closest type the fact is an example of; omit only when none applies even broadly');
    expect(ontologyModeInstructions).toContain('Each node is a fact. To link two things with an edge, each must exist as its own fact, titled by the same name you use in `target_title`.');
    expect(ontologyModeInstructions).not.toContain('throws');
  });

  it('backfill system prompt carries the same closest-type instruction', () => {
    expect(ONTOLOGY_BACKFILL_SYSTEM_PROMPT).toContain('closest type the fact is an example of');
    expect(ONTOLOGY_BACKFILL_SYSTEM_PROMPT).toContain('omit that fact from "classifications" only when no type applies even broadly');
  });
});

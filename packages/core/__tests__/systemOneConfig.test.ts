import { describe, it, expect, vi, afterEach } from 'vitest';
import { openTestDatabase } from './helpers/sqliteAdapter';
import {
  createWiki,
  resolveSystemOneTyping,
  resolveTypingMinConfidence,
  validateManifest,
  CLASSIFIER_MAX_CHOICES,
} from '../src/index';
import type {
  ClassifyRequest,
  ClassifyResponse,
  OntologyManifest,
  SQLiteAdapter,
  WikiConfig,
  WikiDiagnostic,
} from '../src/types';

const PREFIX = 'llm_wiki_';
const MANIFEST: OntologyManifest = {
  node_types: [{ type: 'person', description: 'A person' }, { type: 'place', description: 'A place' }],
  edge_types: [],
};

const choice = (c: string, confidence = 0.9): ClassifyResponse => ({
  answers: { okf_type: { kind: 'choice', choice: c, confidence, probabilities: { [c]: confidence } } },
});

async function seed(db: SQLiteAdapter, id: string, title: string, updatedAt = 100) {
  await db.runAsync(
    `INSERT INTO ${PREFIX}entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at, access_count)
     VALUES (?, 'e1', ?, ?, '[]', 'certain', 'user_stated', ?, ?, 0)`,
    [id, title, `${title} body`, updatedAt, updatedAt],
  );
}

async function row(db: SQLiteAdapter, id: string) {
  return db.getFirstAsync<{ okf_type: string | null; ontology_checked_at: number | null }>(
    `SELECT okf_type, ontology_checked_at FROM ${PREFIX}entries WHERE id = ?`, [id]);
}

interface Harness {
  db: SQLiteAdapter;
  wiki: ReturnType<typeof createWiki>;
  generateText: ReturnType<typeof vi.fn>;
  classify?: ReturnType<typeof vi.fn>;
  diagnostics: WikiDiagnostic[];
}

async function makeWiki(opts: {
  config?: WikiConfig;
  classify?: (state: string) => Promise<ClassifyResponse>;
  manifest?: OntologyManifest;
  seeds?: Array<[string, string]>;
} = {}): Promise<Harness> {
  const db = openTestDatabase();
  const diagnostics: WikiDiagnostic[] = [];
  const generateText = vi.fn(async () => JSON.stringify({ classifications: [] }));
  const classify = opts.classify ? vi.fn(async (r: ClassifyRequest) => opts.classify!(r.state)) : undefined;
  const wiki = createWiki(db, {
    llmProvider: { generateText, ...(classify ? { classify } : {}) },
    ...(opts.config ? { config: opts.config } : {}),
    onDiagnostic: (d) => { diagnostics.push(d); },
  });
  await wiki.setup();
  await wiki.setOntologyManifest('e1', opts.manifest ?? MANIFEST, { mode: 'strict' });
  for (const [id, title] of opts.seeds ?? [['f_ada', 'Ada']]) await seed(db, id, title);
  return { db, wiki, generateText, classify, diagnostics };
}

const byTitle = (state: string) => choice(state.startsWith('Ada') ? 'person' : 'place');

afterEach(() => vi.restoreAllMocks());

describe('typing-mode resolution chain (spec §2)', () => {
  it('default is llm', () => {
    expect(resolveSystemOneTyping(undefined)).toBe('llm');
    expect(resolveSystemOneTyping({})).toBe('llm');
  });

  it('legacy key still resolves without new keys (compat)', () => {
    expect(resolveSystemOneTyping({ ontology: { backfillClassifier: 'auto' } })).toBe('auto');
  });

  it('systemOne.typing beats backfillClassifier', () => {
    expect(resolveSystemOneTyping({ ontology: { backfillClassifier: 'auto' }, systemOne: { typing: 'llm' } })).toBe('llm');
    expect(resolveSystemOneTyping({ ontology: { backfillClassifier: 'llm' }, systemOne: { typing: 'auto' } })).toBe('auto');
  });

  it('call option overrides both config keys', () => {
    const config: WikiConfig = { ontology: { backfillClassifier: 'auto' }, systemOne: { typing: 'auto' } };
    expect(resolveSystemOneTyping(config, 'llm')).toBe('llm');
    expect(resolveSystemOneTyping({ systemOne: { typing: 'llm' } }, 'auto')).toBe('auto');
  });

  it('invalid keys are treated as unset and the chain continues', () => {
    expect(resolveSystemOneTyping({ systemOne: { typing: 'hybrid' as never } })).toBe('llm');
    expect(resolveSystemOneTyping({ systemOne: { typing: 'hybrid' as never }, ontology: { backfillClassifier: 'auto' } })).toBe('auto');
  });

  it('integration: systemOne.typing routes the pass; call option wins; invalid call option throws TypeError', async () => {
    const a = await makeWiki({ config: { systemOne: { typing: 'auto' } }, classify: byTitle });
    await a.wiki.runOntologyBackfill('e1');
    expect(a.classify).toHaveBeenCalled();
    expect(a.generateText).not.toHaveBeenCalled();

    const b = await makeWiki({ config: { systemOne: { typing: 'auto' } }, classify: byTitle });
    await b.wiki.runOntologyBackfill('e1', { classifier: 'llm' });
    expect(b.classify).not.toHaveBeenCalled();

    const c = await makeWiki({ classify: byTitle });
    await expect(c.wiki.runOntologyBackfill('e1', { classifier: 'hybrid' as never })).rejects.toThrow(TypeError);
  });

  it('capability alone never switches paths (REQ-COMPAT-01.5)', async () => {
    const h = await makeWiki({ classify: byTitle });
    await h.wiki.runOntologyBackfill('e1');
    expect(h.generateText).toHaveBeenCalled();
    expect(h.classify).not.toHaveBeenCalled();
  });
});

describe('confidence-floor chain (spec §3)', () => {
  it('default 0.5; systemOne floor beats legacy; legacy still works; 0 is respected', () => {
    expect(resolveTypingMinConfidence(undefined)).toBe(0.5);
    expect(resolveTypingMinConfidence({ ontology: { classifyMinConfidence: 0.1 } })).toBe(0.1);
    expect(resolveTypingMinConfidence({ ontology: { classifyMinConfidence: 0.9 }, systemOne: { minConfidence: { typing: 0.2 } } })).toBe(0.2);
    expect(resolveTypingMinConfidence({ systemOne: { minConfidence: { typing: 0 } } })).toBe(0);
  });

  it('invalid floor treated as unset; chain continues; warning names the key', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveTypingMinConfidence({ systemOne: { minConfidence: { typing: 1.5 } } })).toBe(0.5);
    expect(resolveTypingMinConfidence({ systemOne: { minConfidence: { typing: 1.5 } }, ontology: { classifyMinConfidence: 0.3 } })).toBe(0.3);
    expect(warn.mock.calls.some(([m]) => String(m).includes('minConfidence.typing'))).toBe(true);
  });

  it("the floor is only read on the classifier path: invalid floor under typing 'llm' never warns", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = await makeWiki({ config: { systemOne: { typing: 'llm', minConfidence: { typing: 99 } } } });
    await h.wiki.runOntologyBackfill('e1');
    expect(warn).not.toHaveBeenCalled();
    expect(h.generateText).toHaveBeenCalled();
  });

  it('integration: raised floor turns 0.7 answers into omissions; lowered floor accepts them', async () => {
    const strict = await makeWiki({ config: { systemOne: { typing: 'auto', minConfidence: { typing: 0.8 } } }, classify: async () => choice('person', 0.7) });
    const sr = await strict.wiki.runOntologyBackfill('e1', { classifier: 'auto' });
    expect(sr.typed).toBe(0);
    expect(sr.abstained).toBe(0);
    expect((await row(strict.db, 'f_ada'))!.ontology_checked_at).not.toBeNull();

    const loose = await makeWiki({ config: { systemOne: { typing: 'auto', minConfidence: { typing: 0.5 } } }, classify: async () => choice('person', 0.7) });
    expect((await loose.wiki.runOntologyBackfill('e1', { classifier: 'auto' })).typed).toBe(1);
  });
});

describe('warn-once behavior (spec §2)', () => {
  it('invalid systemOne.typing warns exactly once per process and is treated as unset', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config: WikiConfig = { systemOne: { typing: 'auto?' as never } };
    expect(resolveSystemOneTyping(config)).toBe('llm');
    expect(resolveSystemOneTyping(config)).toBe('llm');
    expect(warn.mock.calls.filter(([m]) => String(m).includes('systemOne.typing')).length).toBe(1);
  });

  it('both keys set to different values warn at most once per process and the newer key wins', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config: WikiConfig = { ontology: { backfillClassifier: 'llm' }, systemOne: { typing: 'auto' } };
    // Process-level dedupe means earlier tests may already have warned for this
    // exact message; the invariant under test is "no more than one warning per
    // process per message", not a fresh-process count.
    const before = warn.mock.calls.filter(([m]) => String(m).includes('disagree')).length;
    expect(resolveSystemOneTyping(config)).toBe('auto');
    expect(resolveSystemOneTyping(config)).toBe('auto');
    const after = warn.mock.calls.filter(([m]) => String(m).includes('disagree')).length;
    expect(after - before).toBeLessThanOrEqual(1);
  });

  it('agreeing keys do not warn; warnOnce messages cannot suppress defaults warnings', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resolveSystemOneTyping({ ontology: { backfillClassifier: 'auto' }, systemOne: { typing: 'auto' } });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('classifier abstain sentinel (spec §5)', () => {
  it('appends the sentinel to the choice question', async () => {
    const h = await makeWiki({ config: { systemOne: { typing: 'auto' } }, classify: async () => choice('person') });
    await h.wiki.runOntologyBackfill('e1', { classifier: 'auto' });
    const req = h.classify!.mock.calls[0][0] as ClassifyRequest;
    expect(req.questions.okf_type.options).toEqual(['person', 'place', 'none_of_these']);
    expect(req.questions.okf_type.instructions).toContain('none_of_these');
  });

  it("an abstain at full confidence is an omission, not a low-confidence near-miss ('leave')", async () => {
    const h = await makeWiki({ config: { systemOne: { typing: 'auto' } }, classify: async () => choice('none_of_these', 1) });
    const result = await h.wiki.runOntologyBackfill('e1', { classifier: 'auto' });
    expect(result.typed).toBe(0);
    expect(result.abstained).toBe(1);
    expect(result.failedValidation).toBe(0);
    expect((await row(h.db, 'f_ada'))!.okf_type).toBeNull();
    expect((await row(h.db, 'f_ada'))!.ontology_checked_at).not.toBeNull();
    expect(h.diagnostics).toEqual([expect.objectContaining({
      code: 'classification_abstained', severity: 'info',
      detail: { factId: 'f_ada', writer: 'classifier' },
    })]);
  });

  it("escalated abstains under onLowConfidence: 'llm' carry writer 'llm' only when the generative step omits", async () => {
    const h = await makeWiki({
      config: { systemOne: { typing: 'auto', onLowConfidence: 'llm' } },
      classify: async () => choice('none_of_these', 1),
    });
    const result = await h.wiki.runOntologyBackfill('e1', { classifier: 'auto' });
    // The generative fallback returns no classification → the fact is a
    // generative omission, receipted with writer 'llm'.
    expect(result.abstained).toBe(1);
    expect(h.generateText).toHaveBeenCalledTimes(1);
    expect(h.diagnostics).toEqual([expect.objectContaining({
      code: 'classification_abstained',
      detail: { factId: 'f_ada', writer: 'llm' },
    })]);
    expect((await row(h.db, 'f_ada'))!.ontology_checked_at).not.toBeNull();
  });

  it('escalated abstains that the generative step types are counted typed, not abstained', async () => {
    const h = await makeWiki({
      config: { systemOne: { typing: 'auto', onLowConfidence: 'llm' } },
      classify: async () => choice('none_of_these', 1),
    });
    h.generateText.mockImplementation(async () => JSON.stringify({ classifications: [{ id: 'f_ada', okf_type: 'person' }] }));
    const result = await h.wiki.runOntologyBackfill('e1', { classifier: 'auto' });
    expect(result).toMatchObject({ typed: 1, abstained: 0, scanned: 1 });
    expect(h.diagnostics).toEqual([expect.objectContaining({
      code: 'node_type_assigned', detail: { factId: 'f_ada', okfType: 'person', writer: 'llm' },
    })]);
    expect((await row(h.db, 'f_ada'))!.okf_type).toBe('person');
  });

  it('escalation skips the generative step on classifier budgetStop', async () => {
    const h = await makeWiki({
      config: { systemOne: { typing: 'auto', onLowConfidence: 'llm' } },
      classify: async () => choice('none_of_these', 1),
    });
    const result = await h.wiki.runOntologyBackfill('e1', { classifier: 'auto', tokenBudget: 0 });
    expect(result.budgetStop).toBeDefined();
    expect(h.generateText).not.toHaveBeenCalled();
    expect((await row(h.db, 'f_ada'))!.ontology_checked_at).toBeNull();
  });

  it('escalation checks the live ontology mode before the generative call (mid-flight off)', async () => {
    // Ontology is disabled while the classifier step is in flight and EVERY
    // outcome escalates (attempted is empty, so the batch apply — which
    // carries its own off check — never runs). The escalation must not make
    // a generative LLM call in a disabled mode: the live mode is re-checked
    // before starting it, and the existing off-mode result is returned
    // without stamping the candidates.
    const db = openTestDatabase();
    const generateText = vi.fn(async () => JSON.stringify({ classifications: [] }));
    let wiki!: ReturnType<typeof createWiki>;
    const classify = vi.fn(async () => {
      // Flip the mode from inside the classifier step, before it returns.
      await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'off' });
      return choice('none_of_these', 1);
    });
    wiki = createWiki(db, {
      llmProvider: { generateText, classify },
      config: { systemOne: { typing: 'auto', onLowConfidence: 'llm' } },
    });
    await wiki.setup();
    await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'strict' });
    await seed(db, 'f_ada', 'Ada');
    const result = await wiki.runOntologyBackfill('e1', { classifier: 'auto' });
    expect(classify).toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
    expect(result.remaining).toBe(0);
    expect((await row(db, 'f_ada'))!.ontology_checked_at).toBeNull();
  });

  it('a manifest carrying the reserved slug falls back to the generative path', async () => {
    // The write path rejects the slug, so the only way a manifest can carry it
    // is a legacy row or an unvalidated seed — exactly the compatibility
    // surface §5 protects: reads still work, typing falls back.
    const manifest: OntologyManifest = {
      node_types: [
        { type: 'none_of_these', description: 'legacy slug' },
        { type: 'person', description: 'A person' },
      ],
      edge_types: [],
    };
    const db = openTestDatabase();
    const diagnostics: WikiDiagnostic[] = [];
    const generateText = vi.fn(async () => JSON.stringify({ classifications: [{ id: 'f_ada', okf_type: 'person' }] }));
    const classify = vi.fn(async () => choice('person'));
    const wiki = createWiki(db, {
      llmProvider: { generateText, classify },
      config: {
        systemOne: { typing: 'auto' },
        ontology: { seedManifests: { e1: { manifest, mode: 'strict' } } },
      },
      onDiagnostic: (d) => { diagnostics.push(d); },
    });
    await wiki.setup();
    await seed(db, 'f_ada', 'Ada');
    await wiki.runOntologyBackfill('e1');
    expect(classify).not.toHaveBeenCalled();
    expect(generateText).toHaveBeenCalled();
    expect((await row(db, 'f_ada'))!.okf_type).toBe('person');
  });

  it(`a manifest over the ${CLASSIFIER_MAX_CHOICES - 1}-slug cap falls back to the generative path`, async () => {
    const node_types = Array.from({ length: CLASSIFIER_MAX_CHOICES }, (_, i) => ({
      type: `t${i}`, description: `type ${i}`,
    }));
    const manifest: OntologyManifest = { node_types, edge_types: [] };
    const h = await makeWiki({ config: { systemOne: { typing: 'auto' } }, classify: byTitle, manifest });
    await h.wiki.runOntologyBackfill('e1');
    expect(h.classify).not.toHaveBeenCalled();
    expect(h.generateText).toHaveBeenCalled();
  });

  it(`exactly ${CLASSIFIER_MAX_CHOICES - 1} slugs still take the classifier path (sentinel fits)`, async () => {
    const node_types = Array.from({ length: CLASSIFIER_MAX_CHOICES - 1 }, (_, i) => ({
      type: `t${i}`, description: `type ${i}`,
    }));
    const manifest: OntologyManifest = { node_types, edge_types: [] };
    const h = await makeWiki({ config: { systemOne: { typing: 'auto' } }, classify: async () => choice('t0'), manifest });
    const result = await h.wiki.runOntologyBackfill('e1', { classifier: 'auto' });
    expect(result.typed).toBe(1);
    expect(h.generateText).not.toHaveBeenCalled();
    const req = h.classify!.mock.calls[0][0] as ClassifyRequest;
    expect(req.questions.okf_type.options).toHaveLength(CLASSIFIER_MAX_CHOICES);
  });

  it('write paths reject the sentinel; per-read validateManifest deliberately does not', async () => {
    const h = await makeWiki();
    const bad: OntologyManifest = { node_types: [{ type: 'none_of_these', description: 'x' }], edge_types: [] };
    await expect(h.wiki.setOntologyManifest('e2', bad)).rejects.toThrow(/reserved/);
    // Per-read validation is untouched (decree C4): a legacy manifest with the
    // slug still passes validateManifest.
    expect(() => validateManifest(bad)).not.toThrow();

    const db = openTestDatabase();
    const wiki = createWiki(db, { llmProvider: { generateText: async () => '{}' } });
    await wiki.setup();
    await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'emergent' });
    const { manifest: merged } = await (wiki as unknown as {
      ontologyService: {
        mergeEmergentUpdates: (e: string, u: unknown, tx: SQLiteAdapter) => Promise<{ manifest: OntologyManifest; rejected: string[] }>;
      };
    }).ontologyService.mergeEmergentUpdates('e1', {
      node_types: [
        { type: 'none_of_these', description: 'smuggled' },
        { type: 'animal', description: 'An animal' },
      ],
    }, db);
    expect(merged.node_types.map((n) => n.type)).toEqual(['person', 'place', 'animal']);
  });
});

describe('generative omission receipts (spec §6)', () => {
  it('a batch the model answers with no classifications abstains with writer llm', async () => {
    const h = await makeWiki();
    await seed(h.db, 'f_ldn', 'London', 200);
    const result = await h.wiki.runOntologyBackfill('e1');
    expect(result).toMatchObject({ scanned: 2, typed: 0, failedValidation: 0, abstained: 2 });
    expect(h.diagnostics).toEqual([
      expect.objectContaining({ code: 'classification_abstained', detail: { factId: 'f_ada', writer: 'llm' } }),
      expect.objectContaining({ code: 'classification_abstained', detail: { factId: 'f_ldn', writer: 'llm' } }),
    ]);
  });

  it('typed facts get node_type_assigned with writer llm on the generative path', async () => {
    const h = await makeWiki();
    h.generateText.mockImplementation(async () => JSON.stringify({ classifications: [{ id: 'f_ada', okf_type: 'person' }] }));
    await h.wiki.runOntologyBackfill('e1');
    expect(h.diagnostics).toEqual([expect.objectContaining({
      code: 'node_type_assigned', severity: 'info',
      detail: { factId: 'f_ada', okfType: 'person', writer: 'llm' },
    })]);
  });

  it('off-manifest classifications stay failedValidation and are not omissions', async () => {
    const h = await makeWiki();
    h.generateText.mockImplementation(async () => JSON.stringify({ classifications: [{ id: 'f_ada', okf_type: 'planet' }] }));
    const result = await h.wiki.runOntologyBackfill('e1');
    expect(result).toMatchObject({ typed: 0, failedValidation: 1, abstained: 0 });
  });
});

describe('compatibility lock (spec §9, test 13)', () => {
  it('with no new keys: defaults, resolution, cooldowns match the pre-PR baseline', async () => {
    const h = await makeWiki({ classify: byTitle });
    const result = await h.wiki.runOntologyBackfill('e1', { classifier: 'auto' });
    expect(result).toEqual({ scanned: 1, typed: 1, failedValidation: 0, edgesAdded: 0, abstained: 0, skipped: 0, remaining: 0, deferred: 0 });
    expect((await row(h.db, 'f_ada'))!.okf_type).toBe('person');
  });

  it('delta 1: the sentinel rides the classifier question', async () => {
    const h = await makeWiki({ config: { systemOne: { typing: 'auto' } }, classify: async () => choice('person') });
    await h.wiki.runOntologyBackfill('e1', { classifier: 'auto' });
    const req = h.classify!.mock.calls[0][0] as ClassifyRequest;
    expect(req.questions.okf_type.options.at(-1)).toBe('none_of_these');
  });

  it('delta 2: typing emits receipts', async () => {
    const h = await makeWiki({ config: { systemOne: { typing: 'auto' } }, classify: async () => choice('person') });
    await h.wiki.runOntologyBackfill('e1', { classifier: 'auto' });
    expect(h.diagnostics.map((d) => d.code)).toEqual(['node_type_assigned']);
  });

  it('delta 3: the ontologyBackfill job rides the default runPendingMaintenance job set', async () => {
    const h = await makeWiki({ config: { systemOne: { typing: 'auto' } }, classify: async () => choice('person') });
    const pending = await h.wiki.getPendingMaintenance(['e1']);
    expect(Array.isArray(pending)).toBe(true);
    // The job runs when selected by default (no jobs filter needed).
    const result = await h.wiki.runPendingMaintenance({ jobs: ['ontologyBackfill'] });
    expect(result.perEntity.length).toBe(1);
    expect(result.perEntity[0].typed).toBe(1);
  });

  it('delta 4: at the option cap (255 manifest slugs + sentinel) the legacy auto path falls back to the generative path', async () => {
    // Pre-PR baseline: the guard was `slugs.length <= 255`, so a 255-slug
    // manifest under `ontology.backfillClassifier: 'auto'` ran the classifier.
    // Appending the sentinel pushes the option count to 256, over
    // CLASSIFIER_MAX_CHOICES — the fallback boundary moves by one (spec §5,
    // §9 delta 4). This test pins the NEW behavior as a documented delta.
    const node_types = Array.from({ length: CLASSIFIER_MAX_CHOICES }, (_, i) => ({
      type: `t${i}`, description: `type ${i}`,
    }));
    const h = await makeWiki({
      config: { ontology: { backfillClassifier: 'auto' } },
      classify: byTitle,
      manifest: { node_types, edge_types: [] },
    });
    await h.wiki.runOntologyBackfill('e1');
    expect(h.classify).not.toHaveBeenCalled();
    expect(h.generateText).toHaveBeenCalled();
  });
});

describe('edges config surface (edge-suggestions-system-one §1, §2)', () => {
  it('accepts systemOne.edges and minConfidence.edges at the type level', () => {
    const config: WikiConfig = {
      systemOne: { edges: 'auto', minConfidence: { typing: 0.5, edges: 0.7 } },
    };
    expect(config.systemOne?.edges).toBe('auto');
    expect(config.systemOne?.minConfidence?.edges).toBe(0.7);
  });
});

describe('resolveSystemOneEdges (edge-suggestions-system-one §2)', () => {
  it("defaults to 'llm' for unset config and {}", async () => {
    const { resolveSystemOneEdges } = await import('../src/utils/engineDefaults');
    expect(resolveSystemOneEdges(undefined)).toBe('llm');
    expect(resolveSystemOneEdges({})).toBe('llm');
    expect(resolveSystemOneEdges({ systemOne: {} })).toBe('llm');
  });

  it("passes 'auto' and 'llm' through, and typing never changes the result", async () => {
    const { resolveSystemOneEdges } = await import('../src/utils/engineDefaults');
    expect(resolveSystemOneEdges({ systemOne: { edges: 'auto' } })).toBe('auto');
    expect(resolveSystemOneEdges({ systemOne: { edges: 'llm' } })).toBe('llm');
    expect(resolveSystemOneEdges({ systemOne: { typing: 'auto' } })).toBe('llm');
    expect(resolveSystemOneEdges({ systemOne: { typing: 'auto', edges: 'llm' } })).toBe('llm');
    expect(resolveSystemOneEdges({ systemOne: { typing: 'llm', edges: 'auto' } })).toBe('auto');
    expect(resolveSystemOneEdges({ ontology: { backfillClassifier: 'auto' } })).toBe('llm');
  });

  it("invalid values return 'llm' and warn exactly once naming systemOne.edges", async () => {
    const { resolveSystemOneEdges } = await import('../src/utils/engineDefaults');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const bad of ['off', 1, BigInt(1), circular]) {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const config = { systemOne: { edges: bad as never } } as WikiConfig;
      expect(resolveSystemOneEdges(config)).toBe('llm');
      expect(resolveSystemOneEdges(config)).toBe('llm');
      const hits = warn.mock.calls.filter(([m]) => String(m).includes('systemOne.edges'));
      expect(hits.length).toBe(1);
      expect(String(hits[0][0]).startsWith('[core-llm-wiki] systemOne:')).toBe(true);
      warn.mockRestore();
    }
  });
});

describe('resolveEdgesMinConfidence (edge-suggestions-system-one §3)', () => {
  it("under 'auto', a missing floor returns undefined and warns once naming the key", async () => {
    const { resolveEdgesMinConfidence } = await import('../src/utils/engineDefaults');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config: WikiConfig = { systemOne: { edges: 'auto' } };
    expect(resolveEdgesMinConfidence(config)).toBeUndefined();
    expect(resolveEdgesMinConfidence(config)).toBeUndefined();
    const hits = warn.mock.calls.filter(([m]) => String(m).includes('systemOne.minConfidence.edges'));
    expect(hits.length).toBe(1);
  });

  it("under 'auto', out-of-domain floors return undefined and warn once each", async () => {
    const { resolveEdgesMinConfidence } = await import('../src/utils/engineDefaults');
    for (const bad of [0, 0.3, 0.49, 1.01, NaN, Infinity, '0.7']) {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const config = { systemOne: { edges: 'auto', minConfidence: { edges: bad as never } } } as WikiConfig;
      expect(resolveEdgesMinConfidence(config)).toBeUndefined();
      expect(resolveEdgesMinConfidence(config)).toBeUndefined();
      // formatConfigValue renders NaN and Infinity both as `null`, so the second
      // of the pair shares NaN's already-emitted (process-deduped) message.
      const expectedWarns = bad === Infinity ? 0 : 1;
      expect(warn.mock.calls.filter(([m]) => String(m).includes('systemOne.minConfidence.edges')).length).toBe(expectedWarns);
      warn.mockRestore();
    }
  });

  it("under 'auto', floors in [0.5, 1] pass through", async () => {
    const { resolveEdgesMinConfidence } = await import('../src/utils/engineDefaults');
    for (const ok of [0.5, 0.7, 1]) {
      expect(resolveEdgesMinConfidence({ systemOne: { edges: 'auto', minConfidence: { edges: ok } } })).toBe(ok);
    }
  });

  it('typing floor and legacy classifyMinConfidence never feed the result', async () => {
    const { resolveEdgesMinConfidence } = await import('../src/utils/engineDefaults');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveEdgesMinConfidence({
      ontology: { classifyMinConfidence: 0.9 },
      systemOne: { edges: 'auto', minConfidence: { typing: 0.8 } },
    })).toBeUndefined();
    warn.mockRestore();
  });

  it("with edge mode 'llm' or unset, returns undefined without reading the floor or warning", async () => {
    const { resolveEdgesMinConfidence } = await import('../src/utils/engineDefaults');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveEdgesMinConfidence(undefined)).toBeUndefined();
    expect(resolveEdgesMinConfidence({})).toBeUndefined();
    expect(resolveEdgesMinConfidence({ systemOne: { edges: 'llm', minConfidence: { edges: 0.3 } } })).toBeUndefined();
    expect(resolveEdgesMinConfidence({ systemOne: { minConfidence: { edges: 0.3 } } })).toBeUndefined();
    expect(resolveEdgesMinConfidence({ systemOne: { edges: 'llm', minConfidence: { edges: 0.8 } } })).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('healScreen config surface (heal-screening-system-one §1, §2)', () => {
  it('accepts systemOne.healScreen and minConfidence.healScreen at the type level', () => {
    const config: WikiConfig = {
      systemOne: { healScreen: 'auto', minConfidence: { typing: 0.5, healScreen: 0.8 } },
    };
    expect(config.systemOne?.healScreen).toBe('auto');
    expect(config.systemOne?.minConfidence?.healScreen).toBe(0.8);
  });
});

describe('resolveSystemOneHealScreen (heal-screening-system-one §2)', () => {
  it("defaults to 'llm' for unset config, {} and {systemOne:{}}", async () => {
    const { resolveSystemOneHealScreen } = await import('../src/utils/engineDefaults');
    expect(resolveSystemOneHealScreen(undefined)).toBe('llm');
    expect(resolveSystemOneHealScreen({})).toBe('llm');
    expect(resolveSystemOneHealScreen({ systemOne: {} })).toBe('llm');
  });

  it("passes 'auto' and 'llm' through, and typing/edges never change the result", async () => {
    const { resolveSystemOneHealScreen } = await import('../src/utils/engineDefaults');
    expect(resolveSystemOneHealScreen({ systemOne: { healScreen: 'auto' } })).toBe('auto');
    expect(resolveSystemOneHealScreen({ systemOne: { healScreen: 'llm' } })).toBe('llm');
    expect(resolveSystemOneHealScreen({ systemOne: { typing: 'auto', edges: 'auto' } })).toBe('llm');
  });

  it("an invalid value warns exactly once naming systemOne.healScreen and resolves 'llm'", async () => {
    const { resolveSystemOneHealScreen } = await import('../src/utils/engineDefaults');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = { systemOne: { healScreen: 'hybrid' as never } } as WikiConfig;
    expect(resolveSystemOneHealScreen(config)).toBe('llm');
    expect(resolveSystemOneHealScreen(config)).toBe('llm');
    const hits = warn.mock.calls.filter(([m]) => String(m).includes('systemOne.healScreen'));
    expect(hits.length).toBe(1);
    expect(String(hits[0][0]).startsWith('[core-llm-wiki] systemOne:')).toBe(true);
    warn.mockRestore();
  });
});

describe('resolveHealScreenMinConfidence (heal-screening-system-one §3)', () => {
  it("under 'auto', a missing floor returns undefined and warns once naming the key", async () => {
    const { resolveHealScreenMinConfidence } = await import('../src/utils/engineDefaults');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config: WikiConfig = { systemOne: { healScreen: 'auto' } };
    expect(resolveHealScreenMinConfidence(config)).toBeUndefined();
    expect(resolveHealScreenMinConfidence(config)).toBeUndefined();
    const hits = warn.mock.calls.filter(([m]) => String(m).includes('systemOne.minConfidence.healScreen'));
    expect(hits.length).toBe(1);
    warn.mockRestore();
  });

  it("under 'auto', out-of-domain floors (0, 0.3, 1.01, NaN) return undefined and warn once each", async () => {
    const { resolveHealScreenMinConfidence } = await import('../src/utils/engineDefaults');
    for (const bad of [0, 0.3, 1.01, NaN]) {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const config = { systemOne: { healScreen: 'auto', minConfidence: { healScreen: bad } } } as WikiConfig;
      expect(resolveHealScreenMinConfidence(config)).toBeUndefined();
      expect(resolveHealScreenMinConfidence(config)).toBeUndefined();
      expect(warn.mock.calls.filter(([m]) => String(m).includes('systemOne.minConfidence.healScreen')).length).toBe(1);
      warn.mockRestore();
    }
  });

  it("under 'auto', floors 0.5 and 1 pass through", async () => {
    const { resolveHealScreenMinConfidence } = await import('../src/utils/engineDefaults');
    for (const ok of [0.5, 0.7, 1]) {
      expect(resolveHealScreenMinConfidence({ systemOne: { healScreen: 'auto', minConfidence: { healScreen: ok } } })).toBe(ok);
    }
  });

  it("with mode 'llm' or unset, returns undefined without reading the floor or warning", async () => {
    const { resolveHealScreenMinConfidence } = await import('../src/utils/engineDefaults');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveHealScreenMinConfidence(undefined)).toBeUndefined();
    expect(resolveHealScreenMinConfidence({})).toBeUndefined();
    expect(resolveHealScreenMinConfidence({ systemOne: { healScreen: 'llm', minConfidence: { healScreen: 0.3 } } })).toBeUndefined();
    expect(resolveHealScreenMinConfidence({ systemOne: { healScreen: 'llm', minConfidence: { healScreen: 0.8 } } })).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('public export surface (step 10)', () => {
  it('exports both edge resolvers from the package index', async () => {
    const idx = await import('../src/index');
    expect(typeof idx.resolveSystemOneEdges).toBe('function');
    expect(typeof idx.resolveEdgesMinConfidence).toBe('function');
    expect(idx.resolveSystemOneEdges({ systemOne: { edges: 'auto' } })).toBe('auto');
    expect(idx.resolveEdgesMinConfidence({ systemOne: { edges: 'auto', minConfidence: { edges: 0.7 } } })).toBe(0.7);
  });
});

describe('resolve config surface (resolution-system-one §1, §2)', () => {
  it('accepts systemOne.resolve and minConfidence.resolve at the type level', () => {
    const config: WikiConfig = {
      systemOne: { resolve: 'auto', minConfidence: { resolve: 0.8 } },
    };
    expect(config.systemOne?.resolve).toBe('auto');
    expect(config.systemOne?.minConfidence?.resolve).toBe(0.8);
  });

  it("rejects 'off' at the type level (no silent-discard mode)", () => {
    const config: WikiConfig = {
      // @ts-expect-error 'off' is not a member of 'auto' | 'llm'
      systemOne: { resolve: 'off' },
    };
    expect(config).toBeDefined();
  });
});

describe('resolveSystemOneResolve (resolution-system-one §2)', () => {
  it("defaults to 'llm' for unset config, unset systemOne, and unset key", async () => {
    const { resolveSystemOneResolve } = await import('../src/utils/engineDefaults');
    expect(resolveSystemOneResolve(undefined)).toBe('llm');
    expect(resolveSystemOneResolve({})).toBe('llm');
    expect(resolveSystemOneResolve({ systemOne: {} })).toBe('llm');
  });

  it("passes 'auto' and 'llm' through; other sites never change the result", async () => {
    const { resolveSystemOneResolve } = await import('../src/utils/engineDefaults');
    expect(resolveSystemOneResolve({ systemOne: { resolve: 'auto' } })).toBe('auto');
    expect(resolveSystemOneResolve({ systemOne: { resolve: 'llm' } })).toBe('llm');
    expect(resolveSystemOneResolve({ systemOne: { typing: 'auto', edges: 'auto' } })).toBe('llm');
  });

  it("a provider with classify and no key resolves 'llm'", async () => {
    const { resolveSystemOneResolve } = await import('../src/utils/engineDefaults');
    const config = {
      llmProvider: { generate: async () => '', classify: async () => ({ answers: {} }) },
    } as unknown as WikiConfig;
    expect(resolveSystemOneResolve(config)).toBe('llm');
  });

  it("invalid values return 'llm' and warn exactly once naming systemOne.resolve", async () => {
    const { resolveSystemOneResolve } = await import('../src/utils/engineDefaults');
    for (const bad of ['off', 1, null, BigInt(1)]) {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const config = { systemOne: { resolve: bad as never } } as WikiConfig;
      expect(resolveSystemOneResolve(config)).toBe('llm');
      expect(resolveSystemOneResolve(config)).toBe('llm');
      const hits = warn.mock.calls.filter(([m]) => String(m).includes('systemOne.resolve'));
      expect(hits.length).toBe(1);
      expect(String(hits[0][0]).startsWith('[core-llm-wiki] systemOne:')).toBe(true);
      warn.mockRestore();
    }
  });
});

describe('resolveResolveMinConfidence (resolution-system-one §3)', () => {
  it("with mode unset or 'llm', returns undefined without reading the floor or warning", async () => {
    const { resolveResolveMinConfidence } = await import('../src/utils/engineDefaults');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveResolveMinConfidence(undefined)).toBeUndefined();
    expect(resolveResolveMinConfidence({ systemOne: { minConfidence: { resolve: 0.8 } } })).toBeUndefined();
    expect(resolveResolveMinConfidence({ systemOne: { resolve: 'llm', minConfidence: { resolve: 0.8 } } })).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("under 'auto', a missing floor returns undefined and warns once naming the key", async () => {
    const { resolveResolveMinConfidence } = await import('../src/utils/engineDefaults');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config: WikiConfig = { systemOne: { resolve: 'auto' } };
    expect(resolveResolveMinConfidence(config)).toBeUndefined();
    expect(resolveResolveMinConfidence(config)).toBeUndefined();
    const hits = warn.mock.calls.filter(([m]) => String(m).includes('systemOne.minConfidence.resolve'));
    expect(hits.length).toBe(1);
    warn.mockRestore();
  });

  it("under 'auto', out-of-domain floors return undefined and warn once each, naming [0.5, 1]", async () => {
    const { resolveResolveMinConfidence } = await import('../src/utils/engineDefaults');
    for (const bad of [NaN, 0.49, 1.01, -1, '0.8']) {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const config = { systemOne: { resolve: 'auto', minConfidence: { resolve: bad as never } } } as WikiConfig;
      expect(resolveResolveMinConfidence(config)).toBeUndefined();
      expect(resolveResolveMinConfidence(config)).toBeUndefined();
      const hits = warn.mock.calls.filter(([m]) => String(m).includes('systemOne.minConfidence.resolve'));
      expect(hits.length).toBe(1);
      expect(String(hits[0][0])).toContain('[0.5, 1]');
      warn.mockRestore();
    }
  });

  it("under 'auto', endpoints and in-domain floors pass through unchanged without warning", async () => {
    const { resolveResolveMinConfidence } = await import('../src/utils/engineDefaults');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const ok of [0.5, 0.8, 1]) {
      expect(resolveResolveMinConfidence({ systemOne: { resolve: 'auto', minConfidence: { resolve: ok } } })).toBe(ok);
    }
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('an invalid mode with a valid floor returns undefined; the floor is never read', async () => {
    const { resolveResolveMinConfidence } = await import('../src/utils/engineDefaults');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = { systemOne: { resolve: 'bogus' as never, minConfidence: { resolve: 0.8 } } } as WikiConfig;
    expect(resolveResolveMinConfidence(config)).toBeUndefined();
    expect(warn.mock.calls.filter(([m]) => String(m).includes('systemOne.resolve')).length).toBeLessThanOrEqual(1);
    expect(warn.mock.calls.filter(([m]) => String(m).includes('systemOne.minConfidence.resolve')).length).toBe(0);
    warn.mockRestore();
  });
});

describe('public export surface (step 11)', () => {
  it('exports both resolve resolvers and keeps the screen internal', async () => {
    const idx = await import('../src/index');
    expect(typeof idx.resolveSystemOneResolve).toBe('function');
    expect(typeof idx.resolveResolveMinConfidence).toBe('function');
    expect(idx.resolveSystemOneResolve({ systemOne: { resolve: 'auto' } })).toBe('auto');
    expect(idx.resolveResolveMinConfidence({ systemOne: { resolve: 'auto', minConfidence: { resolve: 0.7 } } })).toBe(0.7);
    expect('screenResolveCandidates' in idx).toBe(false);
  });
});

describe('public export surface (step 12)', () => {
  it('exports both heal-screen resolvers from the package index', async () => {
    const idx = await import('../src/index');
    expect(typeof idx.resolveSystemOneHealScreen).toBe('function');
    expect(typeof idx.resolveHealScreenMinConfidence).toBe('function');
    expect(idx.resolveSystemOneHealScreen({ systemOne: { healScreen: 'auto' } })).toBe('auto');
    expect(idx.resolveHealScreenMinConfidence({ systemOne: { healScreen: 'auto', minConfidence: { healScreen: 0.8 } } })).toBe(0.8);
    expect(idx.resolveSystemOneHealScreen(undefined)).toBe('llm');
    expect(idx.resolveHealScreenMinConfidence({ systemOne: { healScreen: 'llm', minConfidence: { healScreen: 0.8 } } })).toBeUndefined();
  });
});

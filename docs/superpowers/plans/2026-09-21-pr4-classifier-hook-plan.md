# PR 4 — Optional Classifier Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional, vendor-neutral `LLMProvider.classify` for System-One classifiers (Jev, OpenJev, local ONNX), and use it for ontology backfill's node typing. Hosts opt in through configuration; nothing changes by default.

**Architecture:**
- **Types.** `types.ts` gains the vendor-neutral classifier types. `utils/classifier.ts` treats every provider answer as untrusted and validates it.
- **Backfill.** In classifier mode, `runOntologyBackfill` asks one `choice` question per untyped fact. Accepted answers become ordinary backfill classifications, applied through the existing `_applyOntologyBackfillBatch`, so manifest normalization, cooldown stamping and the abort-when-ontology-is-off check are reused unchanged.
- **Diagnostics.** Emitted only after PR 1 merges (Task 5, gated).

**Tech Stack:** TypeScript 5.9 (strict), vitest 5, pnpm workspace, better-sqlite3 in tests.

**Spec:** `docs/superpowers/specs/2026-09-21-grounding-diagnostics-classifier-design.md` (rev 6). §7 is this PR; REQ-COMPAT-01 (especially .5) applies. If this plan and the spec disagree, the spec wins; stop and report.

## Global Constraints

- Worktree: `.worktrees/pr4-classifier`, branch `feat/classifier-hook`. Run every command from the worktree root.
- One-time setup: `pnpm install --frozen-lockfile && pnpm --filter @equationalapplications/core-okf build`.
- Run one test file: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/<file>.test.ts`. Full core suite: `pnpm --filter @equationalapplications/core-llm-wiki test`. Typecheck: `pnpm --filter @equationalapplications/core-llm-wiki typecheck`.
- **REQ-COMPAT-01.5:** adding `classify` to a provider never changes behavior by itself. The backfill classifier resolves as call option → `WikiConfig.ontology.backfillClassifier` → `'llm'`.
- Core imports no vendor SDK and no ontology package. Options come from the entity's effective manifest.
- Classifier mode never proposes edges (`edgesAdded: 0`). A classifier cannot extract target titles.
- Counting (spec §7.3):
  - an invalid answer adds to `failedValidation` and gets the cooldown stamp;
  - a low-confidence answer is an omission (not typed, stamped);
  - a thrown `classify` adds to `skipped` and is **not** stamped.
- Commits: conventional commits. End every message with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`. **Never** start a body line with `BREAKING CHANGE`. This PR is a `feat` minor release.
- Merge convention: regular merge commit, never squash.
- Do not edit the spec file in this PR.
- **Task 5 is gated.** Start it only after PR 1 (`feat/diagnostics-stream`) has merged to `main`. Tasks 1–4 are independent of PR 1 and may be opened for review before then, but the PR must not merge until Task 5 is done.

## File map

| File | Change |
|---|---|
| `packages/core/src/types.ts` | classifier types; `LLMProvider.classify`; `OntologyConfig.backfillClassifier` / `classifyMinConfidence` |
| `packages/core/src/utils/classifier.ts` | **new** — `validateClassifierAnswer`, `classifierStateForFact` |
| `packages/core/src/services/MaintenanceService.ts` | classifier path in `doRunOntologyBackfill`; `_runClassifierBackfill` |
| `packages/core/src/WikiMemory.ts` | `runOntologyBackfill` option type gains `classifier` |
| `packages/core/__tests__/classifier*.test.ts` | **new** tests |
| `packages/core/README.md` | classifier subsection under `### Ontology backfill` |

---

### Task 1: Classifier types and answer validation

**Files:**
- Modify: `packages/core/src/types.ts` (types directly after `export interface LLMProvider { ... }`; one member inside `LLMProvider`; two members in `OntologyConfig`)
- Create: `packages/core/src/utils/classifier.ts`
- Test: `packages/core/__tests__/classifierValidation.test.ts`

**Interfaces:**
- Produces:
  - Types: `ClassifierQuestion`, `ClassifyRequest`, `ClassifierAnswer`, `ClassifyResponse`.
  - `LLMProvider.classify?: (request: ClassifyRequest) => Promise<ClassifyResponse>`.
  - `OntologyConfig.backfillClassifier?: 'auto' | 'llm'`, `OntologyConfig.classifyMinConfidence?: number`.
  - `validateClassifierAnswer(response: unknown, key: string, question: ClassifierQuestion): { ok: true; answer: ClassifierAnswer } | { ok: false; reason: ClassifierRejection }`
  - `type ClassifierRejection = 'malformed' | 'missing_answer' | 'kind_mismatch' | 'choice_not_offered' | 'score_out_of_range' | 'invalid_probability'`
  - `classifierStateForFact(fact: { title: string; body: string; tags: string[] }): string`

- [ ] **Step 1: Write failing tests** in `packages/core/__tests__/classifierValidation.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { validateClassifierAnswer, classifierStateForFact } from '../src/utils/classifier';
import type { ClassifierQuestion } from '../src/types';

const choice: ClassifierQuestion = { kind: 'choice', options: ['person', 'place'] };
const binary: ClassifierQuestion = { kind: 'binary', instructions: 'Is it true?' };
const score: ClassifierQuestion = { kind: 'score', levels: ['low', 'mid', 'high'] };
const wrap = (answer: unknown) => ({ answers: { q: answer } });

describe('validateClassifierAnswer', () => {
  it('accepts a well-formed choice', () => {
    const r = validateClassifierAnswer(wrap({ kind: 'choice', choice: 'place', confidence: 0.9, probabilities: { person: 0.1, place: 0.9 } }), 'q', choice);
    expect(r).toEqual({ ok: true, answer: { kind: 'choice', choice: 'place', confidence: 0.9, probabilities: { person: 0.1, place: 0.9 } } });
  });

  it.each([
    ['non-object response', 42, 'malformed'],
    ['missing answers map', {}, 'missing_answer'],
    ['missing key', { answers: {} }, 'missing_answer'],
    ['kind mismatch', wrap({ kind: 'binary', probability: 0.5 }), 'kind_mismatch'],
    ['off-list choice', wrap({ kind: 'choice', choice: 'planet', confidence: 0.9, probabilities: {} }), 'choice_not_offered'],
    ['NaN confidence', wrap({ kind: 'choice', choice: 'place', confidence: Number.NaN, probabilities: {} }), 'invalid_probability'],
    ['confidence > 1', wrap({ kind: 'choice', choice: 'place', confidence: 1.5, probabilities: {} }), 'invalid_probability'],
    ['bad probability value', wrap({ kind: 'choice', choice: 'place', confidence: 0.5, probabilities: { place: -0.1 } }), 'invalid_probability'],
  ])('rejects %s', (_label, response, reason) => {
    expect(validateClassifierAnswer(response, 'q', choice)).toEqual({ ok: false, reason });
  });

  it('validates binary', () => {
    expect(validateClassifierAnswer(wrap({ kind: 'binary', probability: 0.2 }), 'q', binary)).toEqual({ ok: true, answer: { kind: 'binary', probability: 0.2 } });
    expect(validateClassifierAnswer(wrap({ kind: 'binary', probability: 2 }), 'q', binary)).toEqual({ ok: false, reason: 'invalid_probability' });
  });

  it('validates score range [0, levels-1]', () => {
    expect(validateClassifierAnswer(wrap({ kind: 'score', score: 1.04, confidence: 0.9, probabilities: [0, 0.96, 0.04] }), 'q', score).ok).toBe(true);
    expect(validateClassifierAnswer(wrap({ kind: 'score', score: 2.5, confidence: 0.9, probabilities: [0, 0, 1] }), 'q', score)).toEqual({ ok: false, reason: 'score_out_of_range' });
    expect(validateClassifierAnswer(wrap({ kind: 'score', score: 1, confidence: 0.9, probabilities: [0, 'x', 1] }), 'q', score)).toEqual({ ok: false, reason: 'invalid_probability' });
  });

  it('never throws on hostile input', () => {
    const hostile = new Proxy({}, { get() { throw new Error('trap'); } });
    expect(validateClassifierAnswer(hostile, 'q', choice)).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('classifierStateForFact', () => {
  it('joins title, body and tags', () => {
    expect(classifierStateForFact({ title: 'Ada', body: 'Mathematician', tags: ['history', 'math'] }))
      .toBe('Ada\n\nMathematician\n\nTags: history, math');
    expect(classifierStateForFact({ title: 'Ada', body: 'Mathematician', tags: [] })).toBe('Ada\n\nMathematician');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/classifierValidation.test.ts`. Expected: FAIL, because `../src/utils/classifier` does not exist.

- [ ] **Step 3: Add the types** in `packages/core/src/types.ts`.
  - Inside `LLMProvider`, after `maxOutputTokens?: number;`, add:

```ts
  /**
   * Optional non-generative classifier (System-One models such as Jev,
   * OpenJev, or a local ONNX classifier). Core never calls it unless the host
   * opts in (e.g. `WikiConfig.ontology.backfillClassifier: 'auto'`); merely
   * providing it changes nothing (REQ-COMPAT-01.5). Output is validated as
   * untrusted.
   */
  classify?: (request: ClassifyRequest) => Promise<ClassifyResponse>;
```

  - Directly after the closing `}` of `LLMProvider`, add:

```ts
/** One typed question for a classifier. Vendor-neutral (Jev `noul` ↔ `binary`). */
export type ClassifierQuestion =
  | { kind: 'choice'; options: string[]; instructions?: string }
  | { kind: 'binary'; instructions: string }
  | { kind: 'score'; levels: string[]; instructions?: string };

/** One state evaluated against a map of questions (many questions per state, one state per call). */
export interface ClassifyRequest {
  state: string;
  questions: Record<string, ClassifierQuestion>;
}

export type ClassifierAnswer =
  | { kind: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
  | { kind: 'binary'; probability: number }
  | { kind: 'score'; score: number; confidence: number; probabilities: number[] };

export interface ClassifyResponse {
  answers: Record<string, ClassifierAnswer>;
}
```

  - In `OntologyConfig`, after `seedManifests?`, add:

```ts
  /**
   * Engine default for `runOntologyBackfill`'s `classifier` option.
   * `'auto'` uses `llmProvider.classify` for node typing when present
   * (no edges are proposed); `'llm'` always uses `generateText`. Default `'llm'`.
   */
  backfillClassifier?: 'auto' | 'llm';
  /** Minimum classifier confidence to apply a node type. Finite, in [0, 1]. Default 0.5. */
  classifyMinConfidence?: number;
```

- [ ] **Step 4: Implement** `packages/core/src/utils/classifier.ts`:

```ts
import type { ClassifierAnswer, ClassifierQuestion } from '../types';

export type ClassifierRejection =
  | 'malformed'
  | 'missing_answer'
  | 'kind_mismatch'
  | 'choice_not_offered'
  | 'score_out_of_range'
  | 'invalid_probability';

type Checked = { ok: true; answer: ClassifierAnswer } | { ok: false; reason: ClassifierRejection };

const isUnit = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

/**
 * Validate one answer from an untrusted classifier response (spec REQ-CLASS-02).
 * Never throws: hostile objects (throwing getters, Proxies) yield `malformed`.
 * Returns a fresh plain object, never the provider's own reference.
 */
export function validateClassifierAnswer(response: unknown, key: string, question: ClassifierQuestion): Checked {
  try {
    if (response === null || typeof response !== 'object') return { ok: false, reason: 'malformed' };
    const answers = (response as { answers?: unknown }).answers;
    if (answers === null || typeof answers !== 'object') return { ok: false, reason: 'missing_answer' };
    if (!Object.prototype.hasOwnProperty.call(answers, key)) return { ok: false, reason: 'missing_answer' };
    const raw = (answers as Record<string, unknown>)[key];
    if (raw === null || typeof raw !== 'object') return { ok: false, reason: 'missing_answer' };
    const a = raw as Record<string, unknown>;
    if (a.kind !== question.kind) return { ok: false, reason: 'kind_mismatch' };

    if (question.kind === 'choice') {
      if (typeof a.choice !== 'string' || !question.options.includes(a.choice)) return { ok: false, reason: 'choice_not_offered' };
      if (!isUnit(a.confidence)) return { ok: false, reason: 'invalid_probability' };
      const probs = a.probabilities;
      if (probs === null || typeof probs !== 'object' || Array.isArray(probs)) return { ok: false, reason: 'invalid_probability' };
      const probabilities: Record<string, number> = {};
      for (const [k, v] of Object.entries(probs as Record<string, unknown>)) {
        if (!isUnit(v)) return { ok: false, reason: 'invalid_probability' };
        probabilities[k] = v;
      }
      return { ok: true, answer: { kind: 'choice', choice: a.choice, confidence: a.confidence, probabilities } };
    }

    if (question.kind === 'binary') {
      if (!isUnit(a.probability)) return { ok: false, reason: 'invalid_probability' };
      return { ok: true, answer: { kind: 'binary', probability: a.probability } };
    }

    const maxScore = question.levels.length - 1;
    if (typeof a.score !== 'number' || !Number.isFinite(a.score) || a.score < 0 || a.score > maxScore) {
      return { ok: false, reason: 'score_out_of_range' };
    }
    if (!isUnit(a.confidence)) return { ok: false, reason: 'invalid_probability' };
    if (!Array.isArray(a.probabilities) || !a.probabilities.every(isUnit)) return { ok: false, reason: 'invalid_probability' };
    return { ok: true, answer: { kind: 'score', score: a.score, confidence: a.confidence, probabilities: a.probabilities.slice() } };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}

/** The classifier `state` for a fact: title, body, and tags when present. */
export function classifierStateForFact(fact: { title: string; body: string; tags: string[] }): string {
  const parts = [fact.title, fact.body];
  if (Array.isArray(fact.tags) && fact.tags.length > 0) parts.push(`Tags: ${fact.tags.join(', ')}`);
  return parts.join('\n\n');
}
```

- [ ] **Step 5: Run the tests.** Run: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/classifierValidation.test.ts`. Expected: PASS. Then run typecheck; expected exit 0.

- [ ] **Step 6: Commit.**

```bash
git add packages/core/src/types.ts packages/core/src/utils/classifier.ts packages/core/__tests__/classifierValidation.test.ts
git commit -m "feat(core): add optional LLMProvider.classify types and answer validation

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Classifier-mode ontology backfill

**Files:**
- Modify: `packages/core/src/services/MaintenanceService.ts` (`runOntologyBackfill` ~329, `doRunOntologyBackfill` ~1052; new private `_runClassifierBackfill`)
- Modify: `packages/core/src/WikiMemory.ts` (`runOntologyBackfill` options type, ~492)
- Test: `packages/core/__tests__/classifierBackfill.test.ts`

**Interfaces:**
- Consumes: `validateClassifierAnswer`, `classifierStateForFact`, the classifier types (Task 1), and the existing `_applyOntologyBackfillBatch(entityId, { batch, classifications, ontologyUpdates }, now)`.
- Produces: `runOntologyBackfill(entityId, options?: { promptOverride?: string; batchSize?: number; classifier?: 'auto' | 'llm' })` on both `WikiMemory` and `MaintenanceService`.
- Task 5 hook: `_runClassifierBackfill` keeps an `outcomes` array whose elements are `{ fact: WikiFact; kind: 'accepted' | 'low_confidence' | 'invalid' | 'threw'; okfType?: string; reason?: ClassifierRejection }`.

- [ ] **Step 1: Write failing tests** in `packages/core/__tests__/classifierBackfill.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { createWiki } from '../src/index';
import type { ClassifyRequest, ClassifyResponse, OntologyConfig, OntologyManifest, SQLiteAdapter } from '../src/types';

const PREFIX = 'llm_wiki_';
const MANIFEST: OntologyManifest = {
  node_types: [{ type: 'person', description: 'A person' }, { type: 'place', description: 'A place' }],
  edge_types: [{ type: 'lives_in', source_type: 'person', target_type: 'place', description: 'Person lives in place' }],
};

async function seed(db: SQLiteAdapter, id: string, title: string, updatedAt: number) {
  await db.runAsync(
    `INSERT INTO ${PREFIX}entries (id, entity_id, title, body, tags, confidence, source_type, created_at, updated_at, access_count)
     VALUES (?, 'e1', ?, ?, '["t1"]', 'certain', 'user_stated', ?, ?, 0)`,
    [id, title, `${title} body`, updatedAt, updatedAt],
  );
}

async function row(db: SQLiteAdapter, id: string) {
  return db.getFirstAsync<{ okf_type: string | null; ontology_checked_at: number | null }>(
    `SELECT okf_type, ontology_checked_at FROM ${PREFIX}entries WHERE id = ?`, [id]);
}

const choice = (c: string, confidence = 0.9): ClassifyResponse => ({
  answers: { okf_type: { kind: 'choice', choice: c, confidence, probabilities: { [c]: confidence } } },
});

async function makeWiki(opts: {
  classify?: (r: ClassifyRequest) => Promise<ClassifyResponse>;
  ontology?: Partial<OntologyConfig>;
  manifest?: OntologyManifest;
} = {}) {
  const db = openTestDatabase();
  const generateText = vi.fn(async () => JSON.stringify({ classifications: [] }));
  const classify = opts.classify ? vi.fn(opts.classify) : undefined;
  const wiki = createWiki(db, {
    llmProvider: { generateText, ...(classify ? { classify } : {}) },
    ...(opts.ontology ? { config: { ontology: opts.ontology } } : {}),
  });
  await wiki.setup();
  await wiki.setOntologyManifest('e1', opts.manifest ?? MANIFEST, { mode: 'strict' });
  await seed(db, 'f_ada', 'Ada', 100);
  await seed(db, 'f_ldn', 'London', 200);
  return { db, wiki, generateText, classify };
}

const byTitle = async (r: ClassifyRequest) => choice(r.state.startsWith('Ada') ? 'person' : 'place');

describe('runOntologyBackfill classifier mode', () => {
  it('REQ-COMPAT-01.5: a provider with classify still uses the LLM path by default', async () => {
    const { wiki, generateText, classify } = await makeWiki({ classify: byTitle });
    await wiki.runOntologyBackfill('e1');
    expect(generateText).toHaveBeenCalled();
    expect(classify).not.toHaveBeenCalled();
  });

  it("classifier: 'auto' types each fact with one choice question over the manifest slugs", async () => {
    const { db, wiki, generateText, classify } = await makeWiki({ classify: byTitle });
    const result = await wiki.runOntologyBackfill('e1', { classifier: 'auto' });
    expect(generateText).not.toHaveBeenCalled();
    expect(classify).toHaveBeenCalledTimes(2);
    const req = classify!.mock.calls[0][0] as ClassifyRequest;
    expect(Object.keys(req.questions)).toEqual(['okf_type']);
    expect(req.questions.okf_type).toMatchObject({ kind: 'choice', options: ['person', 'place'] });
    expect(req.state).toBe('Ada\n\nAda body\n\nTags: t1');
    expect(result).toEqual({ scanned: 2, typed: 2, failedValidation: 0, edgesAdded: 0, skipped: 0, remaining: 0, deferred: 0 });
    expect((await row(db, 'f_ada'))!.okf_type).toBe('person');
    expect((await row(db, 'f_ldn'))!.okf_type).toBe('place');
  });

  it('config default ontology.backfillClassifier applies; call option llm overrides it', async () => {
    const a = await makeWiki({ classify: byTitle, ontology: { backfillClassifier: 'auto' } });
    await a.wiki.runOntologyBackfill('e1');
    expect(a.classify).toHaveBeenCalled();
    const b = await makeWiki({ classify: byTitle, ontology: { backfillClassifier: 'auto' } });
    await b.wiki.runOntologyBackfill('e1', { classifier: 'llm' });
    expect(b.classify).not.toHaveBeenCalled();
    expect(b.generateText).toHaveBeenCalled();
  });

  it('low confidence → omission: untyped, cooldown-stamped, not failedValidation', async () => {
    const { db, wiki } = await makeWiki({ classify: async () => choice('person', 0.2) });
    const result = await wiki.runOntologyBackfill('e1', { classifier: 'auto' });
    expect(result).toMatchObject({ scanned: 2, typed: 0, failedValidation: 0, skipped: 0, remaining: 0, deferred: 2 });
    expect((await row(db, 'f_ada'))!.okf_type).toBeNull();
    expect((await row(db, 'f_ada'))!.ontology_checked_at).not.toBeNull();
  });

  it('respects classifyMinConfidence', async () => {
    const { wiki } = await makeWiki({ classify: async () => choice('person', 0.2), ontology: { classifyMinConfidence: 0.1 } });
    expect((await wiki.runOntologyBackfill('e1', { classifier: 'auto' })).typed).toBe(2);
  });

  it('off-manifest choice and NaN probability → failedValidation, stamped', async () => {
    let n = 0;
    const { db, wiki } = await makeWiki({
      classify: async () => (n++ === 0
        ? choice('planet')
        : { answers: { okf_type: { kind: 'choice', choice: 'place', confidence: Number.NaN, probabilities: {} } } }),
    });
    const result = await wiki.runOntologyBackfill('e1', { classifier: 'auto' });
    expect(result).toMatchObject({ scanned: 2, typed: 0, failedValidation: 2, skipped: 0 });
    expect((await row(db, 'f_ada'))!.ontology_checked_at).not.toBeNull();
  });

  it('thrown classify → skipped, not stamped, siblings still applied', async () => {
    const { db, wiki } = await makeWiki({
      classify: async (r) => { if (r.state.startsWith('Ada')) throw new Error('down'); return choice('place'); },
    });
    const result = await wiki.runOntologyBackfill('e1', { classifier: 'auto' });
    expect(result).toMatchObject({ scanned: 2, typed: 1, skipped: 1, failedValidation: 0 });
    expect((await row(db, 'f_ada'))!.ontology_checked_at).toBeNull();
    expect((await row(db, 'f_ldn'))!.okf_type).toBe('place');
  });

  it('falls back to the LLM path for more than 255 node types', async () => {
    const big: OntologyManifest = {
      node_types: Array.from({ length: 256 }, (_, i) => ({ type: `t${i}`, description: 'x' })),
      edge_types: [],
    };
    const { wiki, generateText, classify } = await makeWiki({ classify: byTitle, manifest: big });
    await wiki.runOntologyBackfill('e1', { classifier: 'auto' });
    expect(classify).not.toHaveBeenCalled();
    expect(generateText).toHaveBeenCalled();
  });

  it("falls back to the LLM path when 'auto' is requested but classify is absent", async () => {
    const { wiki, generateText } = await makeWiki();
    await wiki.runOntologyBackfill('e1', { classifier: 'auto' });
    expect(generateText).toHaveBeenCalled();
  });
});
```

> `setOntologyManifest` may require `description` on node and edge types. The fixtures include them. If `validateManifest` rejects the 256-type manifest for another reason (for example, a size cap), shrink the test to the smallest manifest that exceeds 255 types and still validates. If no such manifest can be persisted, delete that single test and record why in the task report.

- [ ] **Step 2: Run it and confirm it fails.** Run: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/classifierBackfill.test.ts`. Expected: FAIL. The classifier-mode tests fail; the two LLM-path tests may pass.

- [ ] **Step 3: Widen the option types.** In both `WikiMemory.runOntologyBackfill` and `MaintenanceService.runOntologyBackfill`/`doRunOntologyBackfill`, change `options?: { promptOverride?: string; batchSize?: number }` to:

```ts
options?: { promptOverride?: string; batchSize?: number; classifier?: 'auto' | 'llm' }
```

- [ ] **Step 4: Route to the classifier.** In `doRunOntologyBackfill`:
  - Change `const { mode } = await ontologyService.getEffectiveState(entityId);` to `const { mode, manifest: effectiveManifest } = await ontologyService.getEffectiveState(entityId);`.
  - Directly after the `if (candidates.length === 0) { ... }` early return, insert:

```ts
    // Spec §7.3 / REQ-COMPAT-01.5: capability alone never switches paths.
    const classifierMode = options?.classifier ?? this.options.config?.ontology?.backfillClassifier ?? 'llm';
    const classify = this.options.llmProvider.classify;
    if (classifierMode === 'auto' && typeof classify === 'function') {
      const slugs = effectiveManifest.node_types.map((n) => n.type);
      if (slugs.length > 0 && slugs.length <= 255) {
        return this._runClassifierBackfill(entityId, candidates, effectiveManifest, now, recheckCutoff);
      }
    }
```

- [ ] **Step 5: Implement `_runClassifierBackfill`.** Add these imports at the top of the file:
  - `import { validateClassifierAnswer, classifierStateForFact, type ClassifierRejection } from '../utils/classifier';`
  - `ClassifierQuestion` and `OntologyManifest` in the `../types` type import, if not already present
  - `withConcurrency` in the `../utils/pure` import

Then add this method directly above `_applyOntologyBackfillBatch`:

```ts
  /**
   * Classifier-mode backfill (spec §7.3): one `choice` question per untyped
   * fact over the effective manifest's node-type slugs. Accepted answers go
   * through `_applyOntologyBackfillBatch` exactly like LLM classifications.
   * No edges are proposed.
   */
  private async _runClassifierBackfill(
    entityId: string,
    candidates: WikiFact[],
    manifest: OntologyManifest,
    now: number,
    recheckCutoff: number,
  ): Promise<OntologyBackfillResult> {
    const classify = this.options.llmProvider.classify!;
    const rawMin = this.options.config?.ontology?.classifyMinConfidence;
    const minConfidence = typeof rawMin === 'number' && Number.isFinite(rawMin) && rawMin >= 0 && rawMin <= 1 ? rawMin : 0.5;
    const rawConcurrency = this.options.config?.chunkConcurrency ?? 1;
    const concurrency = Number.isFinite(rawConcurrency) && rawConcurrency >= 1 ? Math.floor(rawConcurrency) : 1;

    // Manifest descriptions are host-authored ontology vocabulary, not fact content.
    const question: ClassifierQuestion = {
      kind: 'choice',
      options: manifest.node_types.map((n) => n.type),
      instructions:
        'Choose the ontology node type that best describes this fact.\n' +
        manifest.node_types.map((n) => `- ${n.type}: ${n.description}`).join('\n'),
    };

    type Outcome =
      | { fact: WikiFact; kind: 'accepted'; okfType: string }
      | { fact: WikiFact; kind: 'low_confidence' }
      | { fact: WikiFact; kind: 'invalid'; reason: ClassifierRejection }
      | { fact: WikiFact; kind: 'threw' };

    const outcomes = await withConcurrency<Outcome>(
      candidates.map((fact) => async (): Promise<Outcome> => {
        let response: unknown;
        try {
          response = await classify({ state: classifierStateForFact(fact), questions: { okf_type: question } });
        } catch {
          return { fact, kind: 'threw' };
        }
        const checked = validateClassifierAnswer(response, 'okf_type', question);
        if (!checked.ok) return { fact, kind: 'invalid', reason: checked.reason };
        if (checked.answer.kind !== 'choice') return { fact, kind: 'invalid', reason: 'kind_mismatch' };
        if (checked.answer.confidence < minConfidence) return { fact, kind: 'low_confidence' };
        return { fact, kind: 'accepted', okfType: checked.answer.choice };
      }),
      concurrency,
    );

    // Thrown calls are transient (like `call_error`): no cooldown stamp.
    const attempted = outcomes.filter((o) => o.kind !== 'threw').map((o) => o.fact);
    const skipped = outcomes.length - attempted.length;
    const classifications = outcomes
      .filter((o): o is Extract<Outcome, { kind: 'accepted' }> => o.kind === 'accepted')
      .map((o) => ({ id: o.fact.id, okf_type: o.okfType }));
    const invalidCount = outcomes.filter((o) => o.kind === 'invalid').length;

    let typed = 0;
    let failedValidation = 0;
    let edgesAdded = 0;
    let aborted = false;
    if (attempted.length > 0) {
      const applied = await this._applyOntologyBackfillBatch(
        entityId,
        { batch: attempted, classifications, ontologyUpdates: undefined },
        now,
      );
      aborted = applied.abortedOntologyOff;
      if (!aborted) {
        typed = applied.typed;
        failedValidation = invalidCount + applied.failedValidation;
        edgesAdded = applied.edgesAdded;
      }
    }

    const counts = await this.entryRepo.countUntypedByEntityId(entityId, recheckCutoff);
    if (aborted) {
      // Mirrors the LLM path: nothing from the aborted batch was written; the host loop terminates.
      return { scanned: 0, typed: 0, failedValidation: 0, edgesAdded: 0, skipped, remaining: 0, deferred: counts.deferred };
    }
    this.searchService.evictCache(entityId);
    return {
      scanned: candidates.length,
      typed,
      failedValidation,
      edgesAdded,
      skipped,
      remaining: counts.eligible,
      deferred: counts.deferred,
    };
  }
```

`_applyOntologyBackfillBatch` stamps the cooldown on every fact in `batch`, which yields the stamping rules for accepted, low-confidence and invalid facts. Check that `withConcurrency`'s signature matches `withConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number)` (`src/utils/pure.ts:794`).

- [ ] **Step 6: Run the tests.** Run `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/classifierBackfill.test.ts __tests__/ontologyBackfill.test.ts`. Expected: PASS; the existing backfill suite is unchanged. Then run typecheck; expected exit 0.

- [ ] **Step 7: Commit.**

```bash
git add packages/core/src/services/MaintenanceService.ts packages/core/src/WikiMemory.ts packages/core/__tests__/classifierBackfill.test.ts
git commit -m "feat(core): classifier-mode ontology backfill behind backfillClassifier

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Abort-when-off and concurrency coverage

**Files:**
- Test: `packages/core/__tests__/classifierBackfill.test.ts` (append)

- [ ] **Step 1: Append tests.**

```ts
describe('classifier backfill — edge cases', () => {
  it('aborts without writes when ontology is disabled while classify is in flight', async () => {
    let wikiRef: Awaited<ReturnType<typeof makeWiki>>['wiki'] | undefined;
    const { db, wiki } = await makeWiki({
      classify: async () => {
        await wikiRef!.setOntologyManifest('e1', MANIFEST, { mode: 'off' });
        return choice('person');
      },
    });
    wikiRef = wiki;
    const result = await wiki.runOntologyBackfill('e1', { classifier: 'auto' });
    expect(result).toMatchObject({ scanned: 0, typed: 0, remaining: 0 });
    expect((await row(db, 'f_ada'))!.okf_type).toBeNull();
    expect((await row(db, 'f_ada'))!.ontology_checked_at).toBeNull();
  });

  it('honors chunkConcurrency as the classify concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const db = openTestDatabase();
    const wiki = createWiki(db, {
      llmProvider: {
        generateText: async () => '{}',
        classify: async () => {
          inFlight++; peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight--;
          return choice('person');
        },
      },
      config: { chunkConcurrency: 2, ontology: { backfillClassifier: 'auto' } },
    });
    await wiki.setup();
    await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'strict' });
    for (let i = 0; i < 6; i++) await seed(db, `f${i}`, `Fact ${i}`, i);
    await wiki.runOntologyBackfill('e1');
    expect(peak).toBe(2);
  });
});
```

> The abort test calls `setOntologyManifest` from inside `classify`. If that deadlocks because the backfill holds a lock that `setOntologyManifest` needs, the existing LLM-path test `aborts without writes when ontology is disabled mid-flight` in `__tests__/ontologyBackfill.test.ts` (~line 377) shows the working technique. Copy its mechanism and keep these assertions.

- [ ] **Step 2: Run the tests.** Run: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/classifierBackfill.test.ts`. Expected: PASS. If a test fails, fix the implementation from Task 2, not the assertions.

- [ ] **Step 3: Commit.**

```bash
git add packages/core/__tests__/classifierBackfill.test.ts
git commit -m "test(core): cover classifier backfill abort and concurrency

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Documentation

**Files:**
- Modify: `packages/core/README.md` (append a `#### Classifier mode (optional)` subsection at the end of `### Ontology backfill`, before `## OKF Import/Export`)

- [ ] **Step 1: Write the docs.** Grep `src/types.ts` for `ClassifyRequest`, `ClassifierQuestion`, `backfillClassifier` and `classifyMinConfidence` so the names match. Insert:

````markdown
#### Classifier mode (optional)

A System-One classifier (for example TypeSafe's Jev, an OpenJev-style open model, or a local ONNX classifier) can type facts during backfill without generating text. Add `classify` to your provider and opt in:

```ts
const wiki = createWiki(db, {
  llmProvider: { generateText, classify },
  config: { ontology: { backfillClassifier: 'auto', classifyMinConfidence: 0.5 } },
});
await wiki.runOntologyBackfill('user-1');                        // uses classify
await wiki.runOntologyBackfill('user-1', { classifier: 'llm' }); // force the generative path
```

- Providing `classify` changes nothing by itself. The default is `'llm'`.
- Each untyped fact gets one `choice` question over the entity manifest's node types. Answers below `classifyMinConfidence` (default 0.5) are left untyped and retried after the cooldown.
- **No edges are proposed in classifier mode** (`edgesAdded: 0`): a classifier cannot extract edge targets. Run with `classifier: 'llm'` when you want edges.
- Manifests with more than 255 node types, or providers without `classify`, use the generative path.
- Answers are validated as untrusted. Off-list choices and out-of-range probabilities count toward `failedValidation`. A thrown `classify` counts toward `skipped` and is retried on the next pass.

Example adapter for Cloudflare Workers AI's `typesafe/jev`. This is illustrative, not a supported package; check the provider's current API reference before use.

```ts
const classify: LLMProvider['classify'] = async ({ state, questions }) => {
  const jevQuestions = Object.fromEntries(Object.entries(questions).map(([key, q]) => [key,
    q.kind === 'choice' ? { type: 'choice', instructions: q.instructions, criteria: Object.fromEntries(q.options.map((o) => [o, o])) }
    : q.kind === 'score' ? { type: 'score', instructions: q.instructions, criteria: q.levels }
    : { type: 'noul', instructions: q.instructions },
  ]));
  const res = await env.AI.run('typesafe/jev', { state, questions: jevQuestions });
  const answers = Object.fromEntries(Object.entries(res.answers).map(([key, a]: [string, any]) => [key,
    a.type === 'choice' ? { kind: 'choice', choice: a.choice, confidence: a.confidence, probabilities: a.probabilities }
    : a.type === 'score' ? {
        kind: 'score', score: a.score, confidence: a.confidence,
        probabilities: Object.keys(a.probabilities).sort((x, y) => Number(x) - Number(y)).map((k) => a.probabilities[k]),
      }
    : { kind: 'binary', probability: a.noul },
  ]));
  return { answers };
};
```
````

- [ ] **Step 2: Full verification.** Run `pnpm --filter @equationalapplications/core-llm-wiki test`, `pnpm --filter @equationalapplications/core-llm-wiki typecheck` and `pnpm test`. Expected: all pass.

- [ ] **Step 3: Commit.**

```bash
git add packages/core/README.md
git commit -m "docs(core): document classifier-mode ontology backfill

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5 (GATED on PR 1 merged): classification diagnostics

**Precondition:** `feat/diagnostics-stream` (PR 1) has merged to `main`. Confirm with `git fetch origin && git log origin/main --oneline | grep -i "diagnostic"` and check that `packages/core/src/utils/diagnostics.ts` exists on `origin/main`. **If it does not, stop and report.**

**Files:**
- Modify: `packages/core/src/services/MaintenanceService.ts` (`_runClassifierBackfill`)
- Test: `packages/core/__tests__/classifierDiagnostics.test.ts`

**Interfaces:**
- Consumes (from PR 1): `DiagnosticBuffer` and `emitDiagnostic` from `../utils/diagnostics`; `WikiOptions.onDiagnostic`; the codes `classification_low_confidence` (severity `info`) and `classification_invalid` (`warn`); `operation: 'ontologyBackfill'`.

- [ ] **Step 1: Bring in `main`.** Run `git fetch origin && git merge origin/main`, creating a merge commit with no rebase. Resolve any conflicts by keeping both sides' additions. Expected hotspots are `types.ts` (PR 1 added diagnostic types above `WikiOptions`; this PR edited `LLMProvider` and `OntologyConfig`) and `MaintenanceService.ts`. Then run `pnpm --filter @equationalapplications/core-llm-wiki test` and expect PASS before continuing.

- [ ] **Step 2: Write failing tests** in `packages/core/__tests__/classifierDiagnostics.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { createWiki } from '../src/index';
import type { ClassifyResponse, OntologyManifest, WikiDiagnostic } from '../src/types';

const MANIFEST: OntologyManifest = {
  node_types: [{ type: 'person', description: 'A person' }, { type: 'place', description: 'A place' }],
  edge_types: [],
};

async function run(classify: (state: string) => Promise<ClassifyResponse>) {
  const db = openTestDatabase();
  const diagnostics: WikiDiagnostic[] = [];
  const wiki = createWiki(db, {
    llmProvider: { generateText: async () => '{}', classify: async (r) => classify(r.state) },
    config: { ontology: { backfillClassifier: 'auto' } },
    onDiagnostic: (d) => { diagnostics.push(d); },
  });
  await wiki.setup();
  await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'strict' });
  await db.runAsync(
    `INSERT INTO llm_wiki_entries (id, entity_id, title, body, confidence, source_type, created_at, updated_at)
     VALUES ('f1', 'e1', 'Secret Title', 'secret body', 'certain', 'user_stated', 1, 1)`,
  );
  await wiki.runOntologyBackfill('e1');
  return diagnostics;
}

describe('classification diagnostics', () => {
  it('low confidence → classification_low_confidence (info)', async () => {
    const d = await run(async () => ({ answers: { okf_type: { kind: 'choice', choice: 'person', confidence: 0.1, probabilities: {} } } }));
    expect(d).toEqual([expect.objectContaining({
      code: 'classification_low_confidence', severity: 'info', operation: 'ontologyBackfill', trigger: 'call', entityId: 'e1',
      detail: { factId: 'f1', reason: 'below_threshold' },
    })]);
  });

  it('invalid answer → classification_invalid with the rejection reason', async () => {
    const d = await run(async () => ({ answers: { okf_type: { kind: 'choice', choice: 'planet', confidence: 0.9, probabilities: {} } } }));
    expect(d).toEqual([expect.objectContaining({ code: 'classification_invalid', severity: 'warn', detail: { factId: 'f1', reason: 'choice_not_offered' } })]);
  });

  it('thrown classify → classification_invalid/classify_threw without the provider message', async () => {
    const d = await run(async () => { throw new Error('provider leaked secret body'); });
    expect(d).toEqual([expect.objectContaining({ code: 'classification_invalid', detail: { factId: 'f1', reason: 'classify_threw' } })]);
    expect(JSON.stringify(d)).not.toContain('secret');
  });

  it('accepted answers emit nothing', async () => {
    const d = await run(async () => ({ answers: { okf_type: { kind: 'choice', choice: 'person', confidence: 0.9, probabilities: {} } } }));
    expect(d).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it and confirm it fails.** Run: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/classifierDiagnostics.test.ts`. Expected: FAIL; nothing is emitted.

- [ ] **Step 4: Implement.** In `_runClassifierBackfill`, add `import { DiagnosticBuffer } from '../utils/diagnostics';` if it is not already imported. Directly before `const counts = await this.entryRepo.countUntypedByEntityId(...)`, add:

```ts
    const diagBuffer = new DiagnosticBuffer();
    const diagBase = { entityId, operation: 'ontologyBackfill' as const, trigger: 'call' as const };
    for (const o of outcomes) {
      if (o.kind === 'low_confidence') {
        diagBuffer.push({ ...diagBase, code: 'classification_low_confidence', detail: { factId: o.fact.id, reason: 'below_threshold' } });
      } else if (o.kind === 'invalid') {
        diagBuffer.push({ ...diagBase, code: 'classification_invalid', detail: { factId: o.fact.id, reason: o.reason } });
      } else if (o.kind === 'threw') {
        diagBuffer.push({ ...diagBase, code: 'classification_invalid', detail: { factId: o.fact.id, reason: 'classify_threw' } });
      }
    }
    // After the apply transaction committed (spec §4.2.4). Classifier answers
    // are reported even on an ontology-off abort: they describe the provider,
    // not a write.
    diagBuffer.flush(this.options);
```

- [ ] **Step 5: Run the tests.** Run `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/classifierDiagnostics.test.ts __tests__/classifierBackfill.test.ts`, then the full core suite, typecheck and `pnpm test`. Expected: all pass.

- [ ] **Step 6: Commit.**

```bash
git add packages/core/src/services/MaintenanceService.ts packages/core/__tests__/classifierDiagnostics.test.ts
git commit -m "feat(core): emit classification diagnostics from classifier backfill

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Self-review against the spec

| Spec | Covered by |
|---|---|
| §7.1 vendor-neutral types, optional `classify` | Task 1 |
| §7.2 untrusted output (missing key, kind mismatch, off-list choice, non-finite or out-of-range values, score range; a thrown call is per-item) | Task 1 validator; Task 2 thrown-call handling |
| §7.3 option resolution (call → config → `'llm'`), REQ-COMPAT-01.5 | Task 2 tests 1 and 3 |
| §7.3 one `choice` per fact over manifest slugs; `classifyMinConfidence` default 0.5 | Task 2 |
| §7.3 >255 types / absent `classify` → LLM path | Task 2 |
| §7.3 no edges (`edgesAdded: 0`); reuse of batch apply; counting rules | Task 2 |
| §7.3 `chunkConcurrency`; no ontology-package import | Tasks 2–3 |
| §7.5 adapter mapping (docs only) | Task 4 |
| §7.6 fake-provider test matrix | Tasks 1–3 |
| §4.4 `classification_*` codes (PR 1 dependency) | Task 5 (gated) |

§7.4's deferred uses (edge typing, entailment, heal) are out of scope.

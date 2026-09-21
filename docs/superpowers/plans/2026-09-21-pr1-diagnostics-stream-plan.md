# PR 1 — Diagnostics Stream (`onDiagnostic`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a typed, content-free `onDiagnostic` callback to `WikiOptions`. It reports what core currently drops silently or only logs: chunk failures, rejected facts and tasks, dedupe drops, dropped edges, embedding and hook failures, heal skips, and background-job failures.

**Architecture:** One small module, `src/utils/diagnostics.ts`, owns emission:
- It supplies each diagnostic's severity, message and timestamp from its code.
- It isolates the host hook, so a throwing or rejecting hook can't break the calling operation.
- It provides an operation-scoped `DiagnosticBuffer` that is flushed after the operation's transaction commits.

Services already receive `WikiOptions`, so no constructor changes are needed. `OntologyService` edge validation gains an optional `drops` collector so callers can report dropped edges.

**Tech Stack:** TypeScript 5.9 (strict), vitest 5, pnpm workspace, better-sqlite3 in tests.

**Spec:** `docs/superpowers/specs/2026-09-21-grounding-diagnostics-classifier-design.md` (rev 6). §4 is this PR; REQ-COMPAT-01 applies. If this plan and the spec disagree, the spec wins; stop and report.

## Global Constraints

- Worktree: `.worktrees/pr1-diagnostics`, branch `feat/diagnostics-stream`. Run every command from the worktree root.
- One-time setup: `pnpm install --frozen-lockfile && pnpm --filter @equationalapplications/core-okf build`.
- Run one test file: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/<file>.test.ts`.
- Full core suite: `pnpm --filter @equationalapplications/core-llm-wiki test`. Typecheck: `pnpm --filter @equationalapplications/core-llm-wiki typecheck`.
- REQ-COMPAT-01.4: every existing `console.warn`/`console.error` line stays **byte-identical**, and no new console output appears when `onDiagnostic` is unset. The only new console lines are the hook-failure warnings inside `emitDiagnostic`.
- REQ-DIAG-03: diagnostics never carry titles, bodies, target titles, evidence, LLM output, provider error messages, or hashes of any of these. `detail` carries only IDs, counts, indexes, manifest slugs and reason slugs.
- Severity is fixed per code (spec §4.2.6). Only `ingest_chunk_failed` aggregates (§4.2.5).
- Commits: conventional commits. End every message with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`. **Never** start a body line with `BREAKING CHANGE`. This whole PR is a `feat` minor release.
- Merge convention: regular merge commit, never squash.
- Do not edit the spec file in this PR (identical copies live on sibling branches).

## File map

| File | Change |
|---|---|
| `packages/core/src/types.ts` | Diagnostic types above `WikiOptions`; `onDiagnostic` in `WikiOptions` |
| `packages/core/src/utils/diagnostics.ts` | **new** — `emitDiagnostic`, `DiagnosticBuffer`, `edgeDropDiagnostic` |
| `packages/core/src/utils/pure.ts` | `factRejectionReason`, `taskRejectionReason` |
| `packages/core/src/utils/ontology.ts` | `EdgeDrop` type; `validateInlineEdges` gains `drops` |
| `packages/core/src/services/OntologyService.ts` | `drops` on `validateAndNormalizeFact`, `resolveEdges`, `resolveAndPersistEdges` |
| `packages/core/src/services/IngestionService.ts` | ingest + `upsertGraphCore` emissions |
| `packages/core/src/WikiMemory.ts` | `upsertGraph` flushes on resolve |
| `packages/core/src/services/EmbeddingService.ts` | optional diagnostic context on `tryEmbedFact`/`embedFact` |
| `packages/core/src/services/MaintenanceService.ts` | librarian, heal, backfill, reembed emissions; `trigger` threading |
| `packages/core/src/services/ImportExportService.ts` | embed context `importDump` |
| `packages/core/src/services/WriteService.ts` | `background_job_failed`; `trigger: 'auto'` |
| `packages/core/__tests__/helpers/diagnosticsHarness.ts` | **new** test harness |
| `packages/core/__tests__/diagnostics*.test.ts` | **new** tests |
| `packages/core/README.md` | new `## Diagnostics` section |

---

### Task 1: Diagnostic types, emitter, buffer, test harness

**Files:**
- Modify: `packages/core/src/types.ts` (insert before `export interface WikiOptions {`; add a field at the end of `WikiOptions`)
- Create: `packages/core/src/utils/diagnostics.ts`
- Create: `packages/core/__tests__/helpers/diagnosticsHarness.ts`
- Test: `packages/core/__tests__/diagnostics.test.ts`

**Interfaces:**
- Produces:
  - Types: `WikiDiagnostic`, `WikiDiagnosticCode`, `WikiDiagnosticSeverity`, `WikiDiagnosticOperation`, `WikiDiagnosticTrigger`, `WikiDiagnosticDetail`.
  - `WikiOptions.onDiagnostic`.
  - `emitDiagnostic(options, input)`, `DiagnosticBuffer` (`push`, `flush`, `discard`, `size`), `type WikiDiagnosticInput`.
  - Harness: `makeDiagnosticWiki`, `ofCode`, `expectNoContent`, `HASH_A`, `HASH_B`.

- [ ] **Step 1: Add the types.** In `packages/core/src/types.ts`, insert this block immediately above `export interface WikiOptions {`:

```ts
/** Severity is fixed per code (spec §4.2.6). */
export type WikiDiagnosticSeverity = 'info' | 'warn' | 'error';

/**
 * Closed for this release series, but new codes are added in minor versions:
 * hosts must tolerate codes they do not recognize.
 */
export type WikiDiagnosticCode =
  | 'ingest_chunk_failed'
  | 'fact_rejected'
  | 'task_rejected'
  | 'fact_deduplicated'
  | 'edge_dropped'
  | 'embedding_failed'
  | 'hook_failed'
  | 'background_job_failed'
  | 'heal_skipped'
  | 'grounding_missing'
  | 'grounding_failed'
  | 'classification_low_confidence'
  | 'classification_invalid';

/** The service run that emitted the diagnostic. */
export type WikiDiagnosticOperation =
  | 'ingest' | 'upsertGraph' | 'librarian' | 'heal' | 'ontologyBackfill' | 'reembed' | 'importDump' | 'write';

/** `'auto'` when a write threshold started the run (auto-librarian / auto-heal); `'call'` when the host did. */
export type WikiDiagnosticTrigger = 'call' | 'auto';

/** Identifiers only — never titles, bodies, quotes, LLM output, provider messages, or hashes of content. */
export interface WikiDiagnosticDetail {
  factId?: string;
  sourceRef?: string;
  chunkIndex?: number;
  edgeType?: string;
  /** Manifest slug of the edge source, when resolved. */
  sourceNodeType?: string;
  /** Manifest slug of the edge target, when resolved. */
  targetNodeType?: string;
  /** Position of a rejected item in the LLM response array. */
  itemIndex?: number;
  /** Machine-readable sub-reason, e.g. `'target_not_found'`. */
  reason?: string;
  /** Aggregated `ingest_chunk_failed` only; the first 20 failed chunk indexes. */
  chunkIndexes?: number[];
  /** Aggregated emissions only. */
  count?: number;
}

export interface WikiDiagnostic {
  code: WikiDiagnosticCode;
  severity: WikiDiagnosticSeverity;
  operation: WikiDiagnosticOperation;
  trigger: WikiDiagnosticTrigger;
  entityId: string;
  /** Epoch ms, sampled at emission. */
  at: number;
  /** Fixed template per code. Never contains content. */
  message: string;
  detail?: WikiDiagnosticDetail;
}
```

Then add this field as the **last** member of `WikiOptions`, after `forceDeleteIgnoreRankerHook?: boolean;`:

```ts

  /**
   * Receives typed, content-free diagnostics for events core previously
   * dropped silently or only logged (spec §4). Synchronous; a returned promise
   * is ignored. A throwing or rejecting hook never affects the operation that
   * emitted the diagnostic. Existing console output is unchanged whether or
   * not this is set.
   */
  onDiagnostic?: (diagnostic: WikiDiagnostic) => void;
```

- [ ] **Step 2: Create the test harness** `packages/core/__tests__/helpers/diagnosticsHarness.ts`:

```ts
import { vi } from 'vitest';
import { WikiMemory } from '../../src/WikiMemory';
import { openTestDatabase } from './sqliteAdapter';
import type { LLMProvider, SQLiteAdapter, WikiConfig, WikiDiagnostic, WikiOptions } from '../../src/types';

export const HASH_A = 'a'.repeat(64);
export const HASH_B = 'b'.repeat(64);

export async function makeDiagnosticWiki(opts: {
  generateText?: LLMProvider['generateText'];
  embed?: LLMProvider['embed'];
  config?: WikiConfig;
  extra?: Partial<WikiOptions>;
  /** Default true. False builds the wiki with no onDiagnostic at all. */
  withHook?: boolean;
} = {}): Promise<{
  wiki: WikiMemory;
  db: SQLiteAdapter;
  diagnostics: WikiDiagnostic[];
  generateText: ReturnType<typeof vi.fn>;
}> {
  const db = openTestDatabase();
  const diagnostics: WikiDiagnostic[] = [];
  const generateText = vi.fn(opts.generateText ?? (async () => JSON.stringify({ facts: [] })));
  const llmProvider: LLMProvider = {
    generateText,
    ...(opts.embed ? { embed: opts.embed } : {}),
  };
  const wiki = new WikiMemory(db, {
    llmProvider,
    ...(opts.config ? { config: opts.config } : {}),
    ...(opts.withHook === false ? {} : { onDiagnostic: (d: WikiDiagnostic) => { diagnostics.push(d); } }),
    ...(opts.extra ?? {}),
  });
  await wiki.setup();
  return { wiki, db, diagnostics, generateText };
}

export function ofCode(diagnostics: WikiDiagnostic[], code: WikiDiagnostic['code']): WikiDiagnostic[] {
  return diagnostics.filter((d) => d.code === code);
}

/** Throws if any forbidden fixture string appears anywhere in the serialized diagnostics (REQ-DIAG-03). */
export function expectNoContent(diagnostics: WikiDiagnostic[], forbidden: string[]): void {
  const serialized = JSON.stringify(diagnostics);
  for (const s of forbidden) {
    if (serialized.includes(s)) {
      throw new Error(`diagnostic leaked content: ${JSON.stringify(s)}`);
    }
  }
}
```

- [ ] **Step 3: Write the failing unit tests** in `packages/core/__tests__/diagnostics.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { emitDiagnostic, DiagnosticBuffer, type WikiDiagnosticInput } from '../src/utils/diagnostics';
import type { WikiDiagnostic } from '../src/types';

const base: WikiDiagnosticInput = {
  code: 'edge_dropped',
  operation: 'ingest',
  trigger: 'call',
  entityId: 'e1',
  detail: { factId: 'fact_1', reason: 'target_not_found' },
};

afterEach(() => vi.restoreAllMocks());

describe('emitDiagnostic', () => {
  it('derives severity, message and timestamp from the code', () => {
    const seen: WikiDiagnostic[] = [];
    const before = Date.now();
    emitDiagnostic({ onDiagnostic: (d) => { seen.push(d); } }, base);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ ...base, severity: 'warn' });
    expect(typeof seen[0].message).toBe('string');
    expect(seen[0].message.length).toBeGreaterThan(0);
    expect(seen[0].at).toBeGreaterThanOrEqual(before);
  });

  it('uses fixed severities: info for dedupe/low-confidence, error for background jobs', () => {
    const seen: WikiDiagnostic[] = [];
    const hook = { onDiagnostic: (d: WikiDiagnostic) => { seen.push(d); } };
    emitDiagnostic(hook, { ...base, code: 'fact_deduplicated' });
    emitDiagnostic(hook, { ...base, code: 'classification_low_confidence' });
    emitDiagnostic(hook, { ...base, code: 'background_job_failed' });
    expect(seen.map((d) => d.severity)).toEqual(['info', 'info', 'error']);
  });

  it('is a silent no-op without a hook', () => {
    const warn = vi.spyOn(console, 'warn');
    const error = vi.spyOn(console, 'error');
    emitDiagnostic({}, base);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('isolates a throwing hook', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => emitDiagnostic({ onDiagnostic: () => { throw new Error('boom'); } }, base)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('isolates a rejecting async hook', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const hook = (async () => { throw new Error('async boom'); }) as unknown as (d: WikiDiagnostic) => void;
    expect(() => emitDiagnostic({ onDiagnostic: hook }, base)).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('warns once per options object for a non-function hook and never throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const options = { onDiagnostic: 42 as unknown as (d: WikiDiagnostic) => void };
    emitDiagnostic(options, base);
    emitDiagnostic(options, base);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('hands the hook a copy of detail so host mutation cannot reach core', () => {
    const input: WikiDiagnosticInput = { ...base, detail: { chunkIndexes: [1, 2] } };
    emitDiagnostic({ onDiagnostic: (d) => { d.detail!.chunkIndexes!.push(99); } }, input);
    expect(input.detail!.chunkIndexes).toEqual([1, 2]);
  });
});

describe('DiagnosticBuffer', () => {
  it('flushes in insertion order and empties itself', () => {
    const seen: WikiDiagnostic[] = [];
    const options = { onDiagnostic: (d: WikiDiagnostic) => { seen.push(d); } };
    const buffer = new DiagnosticBuffer();
    buffer.push({ ...base, detail: { itemIndex: 0 } });
    buffer.push({ ...base, detail: { itemIndex: 1 } });
    expect(buffer.size).toBe(2);
    buffer.flush(options);
    buffer.flush(options);
    expect(seen.map((d) => d.detail?.itemIndex)).toEqual([0, 1]);
    expect(buffer.size).toBe(0);
  });

  it('discard drops everything', () => {
    const seen: WikiDiagnostic[] = [];
    const buffer = new DiagnosticBuffer();
    buffer.push(base);
    buffer.discard();
    buffer.flush({ onDiagnostic: (d) => { seen.push(d); } });
    expect(seen).toEqual([]);
  });
});
```

- [ ] **Step 4: Run it and confirm it fails.** Run: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/diagnostics.test.ts`. Expected: FAIL, because `../src/utils/diagnostics` cannot be resolved.

- [ ] **Step 5: Implement** `packages/core/src/utils/diagnostics.ts`:

```ts
import type {
  WikiDiagnostic,
  WikiDiagnosticCode,
  WikiDiagnosticDetail,
  WikiDiagnosticSeverity,
  WikiOptions,
} from '../types';

/** What a call site supplies; severity, message and timestamp are derived from `code`. */
export type WikiDiagnosticInput = Omit<WikiDiagnostic, 'severity' | 'message' | 'at'>;

type DiagnosticTarget = Pick<WikiOptions, 'onDiagnostic'>;

const SEVERITY: Record<WikiDiagnosticCode, WikiDiagnosticSeverity> = {
  ingest_chunk_failed: 'warn',
  fact_rejected: 'warn',
  task_rejected: 'warn',
  fact_deduplicated: 'info',
  edge_dropped: 'warn',
  embedding_failed: 'warn',
  hook_failed: 'warn',
  background_job_failed: 'error',
  heal_skipped: 'warn',
  grounding_missing: 'warn',
  grounding_failed: 'warn',
  classification_low_confidence: 'info',
  classification_invalid: 'warn',
};

// Fixed templates (REQ-DIAG-03): never interpolate content into these.
const MESSAGE: Record<WikiDiagnosticCode, string> = {
  ingest_chunk_failed: 'One or more document chunks failed to parse or generate.',
  fact_rejected: 'An extracted fact failed validation and was not written.',
  task_rejected: 'An extracted task failed validation and was not written.',
  fact_deduplicated: 'An extracted fact duplicated an existing fact and was not written.',
  edge_dropped: 'An extracted edge could not be resolved against the ontology and was not written.',
  embedding_failed: 'A fact could not be embedded.',
  hook_failed: 'A host hook threw or rejected.',
  background_job_failed: 'A background maintenance job failed.',
  heal_skipped: 'Heal skipped a candidate fact.',
  grounding_missing: 'A fact carried no qualifying evidence and was stored as a draft.',
  grounding_failed: 'A fact carried evidence not found in its source and was stored as a draft.',
  classification_low_confidence: 'A classifier answer was below the confidence threshold and was not applied.',
  classification_invalid: 'A classifier answer was invalid and was not applied.',
};

const warnedNonFunction = new WeakSet<object>();

function copyDetail(detail: WikiDiagnosticDetail): WikiDiagnosticDetail {
  const copy: WikiDiagnosticDetail = { ...detail };
  if (detail.chunkIndexes) copy.chunkIndexes = detail.chunkIndexes.slice();
  return copy;
}

/**
 * Deliver one diagnostic to the host hook. Never throws, never awaits, and
 * never writes to the console unless the hook itself misbehaves (REQ-DIAG-02).
 */
export function emitDiagnostic(options: DiagnosticTarget, input: WikiDiagnosticInput): void {
  const hook: unknown = options.onDiagnostic;
  if (hook === undefined || hook === null) return;
  if (typeof hook !== 'function') {
    if (!warnedNonFunction.has(options)) {
      warnedNonFunction.add(options);
      console.warn('[WikiMemory] onDiagnostic is not a function; diagnostics are disabled.');
    }
    return;
  }
  const diagnostic: WikiDiagnostic = {
    code: input.code,
    severity: SEVERITY[input.code],
    operation: input.operation,
    trigger: input.trigger,
    entityId: input.entityId,
    at: Date.now(),
    message: MESSAGE[input.code],
    ...(input.detail ? { detail: copyDetail(input.detail) } : {}),
  };
  try {
    const returned: unknown = (hook as (d: WikiDiagnostic) => unknown)(diagnostic);
    if (returned !== undefined) {
      // Promise.resolve never throws synchronously; a hostile thenable rejects instead.
      Promise.resolve(returned).catch((err: unknown) => {
        console.warn('[WikiMemory] onDiagnostic hook rejected:', err);
      });
    }
  } catch (err) {
    console.warn('[WikiMemory] onDiagnostic hook threw:', err);
  }
}

/**
 * Operation-scoped buffer (spec §4.2.4): push while the operation's
 * transaction is open, `flush` after it commits, `discard` (or simply drop the
 * buffer) when the operation throws.
 */
export class DiagnosticBuffer {
  private items: WikiDiagnosticInput[] = [];

  push(input: WikiDiagnosticInput): void {
    this.items.push(input);
  }

  get size(): number {
    return this.items.length;
  }

  flush(options: DiagnosticTarget): void {
    const pending = this.items;
    this.items = [];
    for (const input of pending) emitDiagnostic(options, input);
  }

  discard(): void {
    this.items = [];
  }
}
```

- [ ] **Step 6: Run the tests.** Run: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/diagnostics.test.ts`. Expected: PASS (9 tests). Then run `pnpm --filter @equationalapplications/core-llm-wiki typecheck`. Expected: exit 0.

- [ ] **Step 7: Commit.**

```bash
git add packages/core/src/types.ts packages/core/src/utils/diagnostics.ts packages/core/__tests__/helpers/diagnosticsHarness.ts packages/core/__tests__/diagnostics.test.ts
git commit -m "feat(core): add onDiagnostic types, emitter and operation buffer

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Rejection reasons and edge-drop collection

**Files:**
- Modify: `packages/core/src/utils/pure.ts` (next to `validateFact` / `validateTask`, ~line 831)
- Modify: `packages/core/src/utils/ontology.ts` (`validateInlineEdges`, ~line 219)
- Modify: `packages/core/src/services/OntologyService.ts` (`validateAndNormalizeFact` ~102, `resolveEdges` ~125, `resolveAndPersistEdges` ~169)
- Modify: `packages/core/src/utils/diagnostics.ts` (add `edgeDropDiagnostic`)
- Test: `packages/core/__tests__/diagnosticsEdgeDrops.test.ts`

**Interfaces:**
- Consumes: `WikiDiagnosticInput`, `WikiDiagnosticOperation`, `WikiDiagnosticTrigger` (Task 1).
- Produces:
  - `factRejectionReason(raw: unknown): 'invalid_shape' | 'missing_title' | 'missing_body'`
  - `taskRejectionReason(raw: unknown): 'invalid_shape' | 'missing_description'`
  - `type EdgeDropReason = 'no_source_type' | 'invalid_shape' | 'type_not_in_manifest' | 'target_not_found' | 'target_type_mismatch'`
  - `interface EdgeDrop { reason: EdgeDropReason; sourceId: string | null; edgeType: string | null; sourceNodeType: string | null; targetNodeType: string | null }` (exported from `utils/ontology.ts`)
  - an optional `drops?: EdgeDrop[]` on `validateInlineEdges`'s opts, `validateAndNormalizeFact`'s opts, and as the trailing parameter of `resolveEdges(..., now, drops?)` and `resolveAndPersistEdges(..., now, drops?)`
  - `edgeDropDiagnostic(drop, ctx: { entityId: string; operation: WikiDiagnosticOperation; trigger: WikiDiagnosticTrigger; sourceRef?: string; factId?: string }): WikiDiagnosticInput`

- [ ] **Step 1: Write failing tests** in `packages/core/__tests__/diagnosticsEdgeDrops.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { factRejectionReason, taskRejectionReason, validateFact, validateTask } from '../src/utils/pure';
import { validateInlineEdges, type EdgeDrop } from '../src/utils/ontology';
import { OntologyService } from '../src/services/OntologyService';
import { edgeDropDiagnostic } from '../src/utils/diagnostics';
import type { OntologyManifest } from '../src/types';

const MANIFEST: OntologyManifest = {
  node_types: [
    { type: 'person', description: 'A person' },
    { type: 'place', description: 'A place' },
  ],
  edge_types: [
    { type: 'lives_in', source_type: 'person', target_type: 'place', description: 'Person lives in place' },
  ],
};

describe('rejection reasons', () => {
  it('classifies facts that validateFact rejects', () => {
    expect(validateFact({ title: 5, body: 'b' })).toBeNull();
    expect(factRejectionReason({ title: 5, body: 'b' })).toBe('invalid_shape');
    expect(factRejectionReason(null)).toBe('invalid_shape');
    expect(factRejectionReason({ title: '   ', body: 'b' })).toBe('missing_title');
    expect(factRejectionReason({ title: 't', body: '' })).toBe('missing_body');
  });

  it('classifies tasks that validateTask rejects', () => {
    expect(validateTask({ description: 7 })).toBeNull();
    expect(taskRejectionReason({ description: 7 })).toBe('invalid_shape');
    expect(taskRejectionReason({ description: '  ' })).toBe('missing_description');
  });
});

describe('validateInlineEdges drops', () => {
  it('records invalid_shape and type_not_in_manifest', () => {
    const drops: EdgeDrop[] = [];
    const kept = validateInlineEdges('person', null, [
      { edge_type: 'lives_in', target_title: 'London' },
      { edge_type: 5, target_title: 'x' } as never,
      { edge_type: 'unknown_edge', target_title: 'y' },
    ], MANIFEST, { drops });
    expect(kept).toHaveLength(1);
    expect(drops).toEqual([
      { reason: 'invalid_shape', sourceId: null, edgeType: null, sourceNodeType: 'person', targetNodeType: null },
      { reason: 'type_not_in_manifest', sourceId: null, edgeType: 'unknown_edge', sourceNodeType: 'person', targetNodeType: null },
    ]);
  });
});

describe('OntologyService drops', () => {
  const service = new OntologyService({} as never, {} as never, undefined);

  it('validateAndNormalizeFact records no_source_type for every edge of an unknown-typed fact', () => {
    const drops: EdgeDrop[] = [];
    const out = service.validateAndNormalizeFact(
      { title: 't', body: 'b', tags: [], confidence: 'certain', okf_type: 'alien',
        edges: [{ edge_type: 'lives_in', target_title: 'London' }] },
      MANIFEST, { strict: false, drops },
    );
    expect(out).toEqual({ okf_type: null, edges: [] });
    expect(drops).toEqual([
      { reason: 'no_source_type', sourceId: null, edgeType: 'lives_in', sourceNodeType: null, targetNodeType: null },
    ]);
  });

  it('resolveEdges records target_not_found and target_type_mismatch with the source id', () => {
    const drops: EdgeDrop[] = [];
    const titleIndex = new Map([
      ['london', { id: 'fact_l', okf_type: 'person' }],
    ]);
    const out = service.resolveEdges('e1', 'fact_s', 'person', [
      { edge_type: 'lives_in', target_title: 'Nowhere' },
      { edge_type: 'lives_in', target_title: 'London' },
    ], MANIFEST, titleIndex, 1, drops);
    expect(out).toEqual([]);
    expect(drops).toEqual([
      { reason: 'target_not_found', sourceId: 'fact_s', edgeType: 'lives_in', sourceNodeType: 'person', targetNodeType: null },
      { reason: 'target_type_mismatch', sourceId: 'fact_s', edgeType: 'lives_in', sourceNodeType: 'person', targetNodeType: 'person' },
    ]);
  });

  it('resolveEdges records no_source_type when the source is untyped', () => {
    const drops: EdgeDrop[] = [];
    service.resolveEdges('e1', 'fact_s', null, [{ edge_type: 'lives_in', target_title: 'x' }], MANIFEST, new Map(), 1, drops);
    expect(drops.map((d) => d.reason)).toEqual(['no_source_type']);
  });

  it('behaves exactly as before when no drops array is passed', () => {
    const out = service.resolveEdges('e1', 'fact_s', 'person', [{ edge_type: 'lives_in', target_title: 'Nowhere' }], MANIFEST, new Map(), 1);
    expect(out).toEqual([]);
  });
});

describe('edgeDropDiagnostic', () => {
  it('maps a drop to an edge_dropped input without null keys', () => {
    const input = edgeDropDiagnostic(
      { reason: 'target_not_found', sourceId: 'fact_s', edgeType: 'lives_in', sourceNodeType: 'person', targetNodeType: null },
      { entityId: 'e1', operation: 'ingest', trigger: 'call', sourceRef: 'doc.md' },
    );
    expect(input).toEqual({
      code: 'edge_dropped', operation: 'ingest', trigger: 'call', entityId: 'e1',
      detail: { reason: 'target_not_found', factId: 'fact_s', edgeType: 'lives_in', sourceNodeType: 'person', sourceRef: 'doc.md' },
    });
  });

  it('prefers ctx.factId when the drop was recorded before the id existed', () => {
    const input = edgeDropDiagnostic(
      { reason: 'no_source_type', sourceId: null, edgeType: 'lives_in', sourceNodeType: null, targetNodeType: null },
      { entityId: 'e1', operation: 'librarian', trigger: 'auto', factId: 'fact_new' },
    );
    expect(input.detail).toEqual({ reason: 'no_source_type', factId: 'fact_new', edgeType: 'lives_in' });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/diagnosticsEdgeDrops.test.ts`. Expected: FAIL because the imports are missing (`factRejectionReason`, `EdgeDrop`, `edgeDropDiagnostic`).

- [ ] **Step 3: Add the rejection reasons** to `packages/core/src/utils/pure.ts`, directly below `validateTask`:

```ts
/** Why `validateFact` rejected `raw`. Only meaningful when `validateFact(raw)` returned null. */
export function factRejectionReason(raw: unknown): 'invalid_shape' | 'missing_title' | 'missing_body' {
  const fact = raw as { title?: unknown; body?: unknown } | null | undefined;
  if (typeof fact?.title !== 'string' || typeof fact?.body !== 'string') return 'invalid_shape';
  if (!clip(fact.title, 80)) return 'missing_title';
  return 'missing_body';
}

/** Why `validateTask` rejected `raw`. Only meaningful when `validateTask(raw)` returned null. */
export function taskRejectionReason(raw: unknown): 'invalid_shape' | 'missing_description' {
  const task = raw as { description?: unknown } | null | undefined;
  if (typeof task?.description !== 'string') return 'invalid_shape';
  return 'missing_description';
}
```

- [ ] **Step 4: Add `EdgeDrop` and drops support in `packages/core/src/utils/ontology.ts`.** Add these exports above `validateInlineEdges`:

```ts
export type EdgeDropReason =
  | 'no_source_type'
  | 'invalid_shape'
  | 'type_not_in_manifest'
  | 'target_not_found'
  | 'target_type_mismatch';

/** A dropped LLM-proposed edge. Slugs only — `target_title` is content and is never recorded. */
export interface EdgeDrop {
  reason: EdgeDropReason;
  /** Source fact id when known; null while validating before the fact has an id. */
  sourceId: string | null;
  edgeType: string | null;
  sourceNodeType: string | null;
  targetNodeType: string | null;
}
```

Replace the body of `validateInlineEdges` with the following. Behavior is unchanged apart from the recorded drops.

```ts
export function validateInlineEdges(
  sourceType: string,
  _targetType: string | null,
  edges: ExtractedFactEdge[],
  manifest: OntologyManifest,
  opts?: { strict?: boolean; entityId?: string; drops?: EdgeDrop[] },
): ExtractedFactEdge[] {
  const strict = opts?.strict === true;
  const entityId = opts?.entityId ?? '';
  const drops = opts?.drops;
  const drop = (reason: EdgeDropReason, edgeType: string | null): void => {
    drops?.push({ reason, sourceId: null, edgeType, sourceNodeType: sourceType, targetNodeType: null });
  };
  if (!Array.isArray(edges)) {
    if (strict) throw new WikiStrictOntologyViolation(entityId, 'edge', '');
    drop('invalid_shape', null);
    return [];
  }
  const valid: ExtractedFactEdge[] = [];
  for (const edge of edges) {
    if (typeof edge?.edge_type !== 'string' || typeof edge?.target_title !== 'string') {
      if (strict) throw new WikiStrictOntologyViolation(entityId, 'edge', String(edge?.edge_type ?? ''));
      drop('invalid_shape', typeof edge?.edge_type === 'string' ? edge.edge_type : null);
      continue;
    }
    const defs = resolveEdgeDefinitions(edge.edge_type, manifest);
    const match = defs.find(d => typeSatisfies(d.source_type, sourceType, manifest));
    if (!match) {
      if (strict) throw new WikiStrictOntologyViolation(entityId, 'edge', edge.edge_type);
      drop('type_not_in_manifest', edge.edge_type);
      continue;
    }
    valid.push({ edge_type: match.type, target_title: edge.target_title });
  }
  return valid;
}
```

- [ ] **Step 5: Thread drops through `OntologyService`.** In `packages/core/src/services/OntologyService.ts`:
  - Add `import type { EdgeDrop } from '../utils/ontology';`. If the file already imports from `'../utils/ontology'`, add `type EdgeDrop` to that import instead.
  - Replace `validateAndNormalizeFact` with:

```ts
  validateAndNormalizeFact(
    fact: ExtractedFactWithOntology,
    manifest: OntologyManifest,
    opts?: { strict?: boolean; entityId?: string; drops?: EdgeDrop[] },
  ): { okf_type: string | null; edges: ExtractedFactEdge[] } {
    const rawType = typeof fact.okf_type === 'string' ? fact.okf_type : '';
    const strict = opts?.strict === true;
    const canonical = resolveNodeType(rawType, manifest);
    if (!canonical) {
      if (strict) throw new WikiStrictOntologyViolation(opts?.entityId ?? '', 'node', rawType);
      if (opts?.drops && Array.isArray(fact.edges)) {
        for (const edge of fact.edges) {
          opts.drops.push({
            reason: 'no_source_type',
            sourceId: null,
            edgeType: typeof edge?.edge_type === 'string' ? edge.edge_type : null,
            sourceNodeType: null,
            targetNodeType: null,
          });
        }
      }
      return { okf_type: null, edges: [] };
    }
    const edges = validateInlineEdges(canonical, null, fact.edges ?? [], manifest, opts);
    return { okf_type: canonical, edges };
  }
```

  - Replace `resolveEdges` with:

```ts
  resolveEdges(
    entityId: string,
    sourceId: string,
    sourceType: string | null,
    edges: ExtractedFactEdge[],
    manifest: OntologyManifest,
    titleIndex: Map<string, TitleIndexEntry>,
    now: number,
    drops?: EdgeDrop[],
  ): WikiEdge[] {
    if (edges.length === 0) return [];
    if (!sourceType) {
      for (const edge of edges) {
        drops?.push({ reason: 'no_source_type', sourceId, edgeType: edge.edge_type, sourceNodeType: null, targetNodeType: null });
      }
      return [];
    }
    const out: WikiEdge[] = [];
    for (const edge of edges) {
      const candidates = resolveEdgeDefinitions(edge.edge_type, manifest)
        .filter(d => typeSatisfies(d.source_type, sourceType, manifest));
      if (candidates.length === 0) {
        drops?.push({ reason: 'type_not_in_manifest', sourceId, edgeType: edge.edge_type, sourceNodeType: sourceType, targetNodeType: null });
        continue;
      }

      const targetKey = normalizeTitleKey(edge.target_title);
      const target = titleIndex.get(targetKey);
      if (!target) {
        drops?.push({ reason: 'target_not_found', sourceId, edgeType: edge.edge_type, sourceNodeType: sourceType, targetNodeType: null });
        continue;
      }

      const targetType = (target.okf_type ?? '').trim().toLowerCase();
      const def = candidates.find(d => d.target_type.trim().toLowerCase() === targetType)
        ?? candidates.find(d => typeSatisfies(d.target_type, targetType, manifest));
      if (!def) {
        drops?.push({
          reason: 'target_type_mismatch', sourceId, edgeType: edge.edge_type,
          sourceNodeType: sourceType, targetNodeType: target.okf_type ?? null,
        });
        continue;
      }

      out.push({
        id: generateId(),
        entity_id: entityId,
        source_id: sourceId,
        target_id: target.id,
        edge_type: def.type,
        created_at: now,
      });
    }
    return out;
  }
```

  - In `resolveAndPersistEdges`, add the trailing parameter `drops?: EdgeDrop[],` after `now: number,`, and change its inner call to `this.resolveEdges(entityId, sourceId, sourceType, edges, manifest, titleIndex, now, drops)`.

- [ ] **Step 6: Add `edgeDropDiagnostic`** to the bottom of `packages/core/src/utils/diagnostics.ts`. Extend the file's type import to include `WikiDiagnosticOperation` and `WikiDiagnosticTrigger`, and add `import type { EdgeDrop } from './ontology';`.

```ts
/** Map an `EdgeDrop` to an `edge_dropped` diagnostic input. Omits unknown locators instead of sending nulls. */
export function edgeDropDiagnostic(
  drop: EdgeDrop,
  ctx: {
    entityId: string;
    operation: WikiDiagnosticOperation;
    trigger: WikiDiagnosticTrigger;
    sourceRef?: string;
    factId?: string;
  },
): WikiDiagnosticInput {
  const detail: WikiDiagnosticDetail = { reason: drop.reason };
  const factId = ctx.factId ?? drop.sourceId;
  if (factId) detail.factId = factId;
  if (drop.edgeType) detail.edgeType = drop.edgeType;
  if (drop.sourceNodeType) detail.sourceNodeType = drop.sourceNodeType;
  if (drop.targetNodeType) detail.targetNodeType = drop.targetNodeType;
  if (ctx.sourceRef) detail.sourceRef = ctx.sourceRef;
  return { code: 'edge_dropped', operation: ctx.operation, trigger: ctx.trigger, entityId: ctx.entityId, detail };
}
```

- [ ] **Step 7: Run the tests.** Run `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/diagnosticsEdgeDrops.test.ts __tests__/services/OntologyService.test.ts __tests__/ontologyParentInheritance.test.ts`. Expected: PASS. Then run typecheck; expected exit 0.

- [ ] **Step 8: Commit.**

```bash
git add packages/core/src/utils/pure.ts packages/core/src/utils/ontology.ts packages/core/src/services/OntologyService.ts packages/core/src/utils/diagnostics.ts packages/core/__tests__/diagnosticsEdgeDrops.test.ts
git commit -m "feat(core): record rejection reasons and dropped edges for diagnostics

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Ingest and `upsertGraph` emissions

**Files:**
- Modify: `packages/core/src/services/IngestionService.ts`
- Modify: `packages/core/src/WikiMemory.ts` (`upsertGraph`, ~line 609)
- Test: `packages/core/__tests__/diagnosticsIngest.test.ts`

**Interfaces:**
- Consumes: `DiagnosticBuffer`, `emitDiagnostic`, `edgeDropDiagnostic`, `factRejectionReason`, `EdgeDrop`, and the harness.
- Produces: `upsertGraphCore(entityId, params, tx, opts?: { strict?: boolean; diag?: { buffer: DiagnosticBuffer; operation: 'ingest' | 'upsertGraph' } })`.

- [ ] **Step 1: Write failing tests** in `packages/core/__tests__/diagnosticsIngest.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeDiagnosticWiki, ofCode, expectNoContent, HASH_A, HASH_B } from './helpers/diagnosticsHarness';
import type { OntologyManifest } from '../src/types';

const MANIFEST: OntologyManifest = {
  node_types: [
    { type: 'person', description: 'A person' },
    { type: 'place', description: 'A place' },
  ],
  edge_types: [
    { type: 'lives_in', source_type: 'person', target_type: 'place', description: 'Person lives in place' },
  ],
};

const DOC = 'ALPHA chunk text here.\n\nBROKEN chunk text here.';

afterEach(() => vi.restoreAllMocks());

describe('ingest diagnostics', () => {
  it('aggregates chunk failures per reason, with trigger call and no content', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { wiki, diagnostics } = await makeDiagnosticWiki({
      config: { maxChunkLength: 30, chunkOverlap: 0 },
      generateText: async ({ userPrompt }) => userPrompt.includes('BROKEN')
        ? 'definitely not json'
        : JSON.stringify({ facts: [{ title: 'Alpha title', body: 'Alpha body', tags: [], confidence: 'certain' }] }),
    });
    const result = await wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: DOC });
    expect(result.chunks).toBe(2);
    expect(result.failedChunks).toBe(1);
    expect(ofCode(diagnostics, 'ingest_chunk_failed')).toEqual([
      expect.objectContaining({
        severity: 'warn', operation: 'ingest', trigger: 'call', entityId: 'e1',
        detail: { sourceRef: 'doc.md', reason: 'parse', count: 1, chunkIndexes: [1] },
      }),
    ]);
    expectNoContent(diagnostics, ['Alpha title', 'Alpha body', 'BROKEN', 'definitely not json']);
  });

  it('discards buffered diagnostics when every chunk fails (the throw is the signal)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { wiki, diagnostics } = await makeDiagnosticWiki({ generateText: async () => 'nope' });
    await expect(wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: 'x y z' })).rejects.toThrow();
    expect(diagnostics).toEqual([]);
  });

  it('reports rejected facts with chunk and item locators', async () => {
    const { wiki, diagnostics } = await makeDiagnosticWiki({
      generateText: async () => JSON.stringify({ facts: [
        { title: 'Good', body: 'Good body', tags: [], confidence: 'certain' },
        { title: 5, body: 'bad shape' },
        { title: '   ', body: 'no title' },
      ] }),
    });
    await wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: 'content' });
    expect(ofCode(diagnostics, 'fact_rejected').map((d) => d.detail)).toEqual([
      { sourceRef: 'doc.md', chunkIndex: 0, itemIndex: 1, reason: 'invalid_shape' },
      { sourceRef: 'doc.md', chunkIndex: 0, itemIndex: 2, reason: 'missing_title' },
    ]);
    expectNoContent(diagnostics, ['bad shape', 'no title', 'Good body']);
  });

  it('reports cross-chunk exact-title duplicates as info', async () => {
    const { wiki, diagnostics } = await makeDiagnosticWiki({
      config: { maxChunkLength: 30, chunkOverlap: 0 },
      generateText: async () => JSON.stringify({ facts: [{ title: 'Same', body: 'b', tags: [], confidence: 'certain' }] }),
    });
    await wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: DOC });
    expect(ofCode(diagnostics, 'fact_deduplicated')).toEqual([
      expect.objectContaining({ severity: 'info', detail: { sourceRef: 'doc.md', chunkIndex: 1, itemIndex: 0, reason: 'exact_title' } }),
    ]);
  });

  it('reports dropped edges with fact id, edge type and manifest slugs, after commit', async () => {
    const { wiki, diagnostics } = await makeDiagnosticWiki({
      generateText: async () => JSON.stringify({ facts: [
        { title: 'Ada', body: 'Ada body', tags: [], confidence: 'certain', okf_type: 'person',
          edges: [{ edge_type: 'lives_in', target_title: 'Atlantis' }, { edge_type: 'unknown_edge', target_title: 'Mars' }] },
      ] }),
    });
    await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'strict' });
    await wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: 'content' });
    const drops = ofCode(diagnostics, 'edge_dropped');
    expect(drops.map((d) => d.detail?.reason).sort()).toEqual(['target_not_found', 'type_not_in_manifest']);
    for (const d of drops) {
      expect(d.detail?.factId).toMatch(/^fact_/);
      expect(d.detail?.sourceRef).toBe('doc.md');
      expect(d.detail?.sourceNodeType).toBe('person');
      expect(d.trigger).toBe('call');
    }
    expectNoContent(diagnostics, ['Atlantis', 'Mars', 'Ada body']);
  });

  it('emits nothing on a clean ingest', async () => {
    const { wiki, diagnostics } = await makeDiagnosticWiki({
      generateText: async () => JSON.stringify({ facts: [{ title: 'Clean', body: 'clean body', tags: [], confidence: 'certain' }] }),
    });
    await wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_B, documentChunk: 'content' });
    expect(diagnostics).toEqual([]);
  });
});

describe('upsertGraph diagnostics', () => {
  it('reports manifest_violation edge drops when upsertGraph resolves (host-owned tx)', async () => {
    const { wiki, db, diagnostics } = await makeDiagnosticWiki();
    await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'emergent' });
    await db.withTransactionAsync(async (tx) => {
      await wiki.upsertGraph('e1', {
        sourceRef: 'graph.json', sourceHash: HASH_A,
        nodes: [{ id: 'n1', type: 'person', title: 'Ada' }, { id: 'n2', type: 'place', title: 'London' }],
        edges: [{ type: 'unknown_edge', sourceId: 'n1', targetId: 'n2' }],
      }, tx);
    });
    expect(ofCode(diagnostics, 'edge_dropped')).toEqual([
      expect.objectContaining({
        operation: 'upsertGraph', trigger: 'call', entityId: 'e1',
        detail: { reason: 'manifest_violation', factId: 'n1', edgeType: 'unknown_edge', sourceNodeType: 'person', sourceRef: 'graph.json' },
      }),
    ]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/diagnosticsIngest.test.ts`. Expected: FAIL, because no diagnostics are emitted yet (the "clean ingest" test passes).

- [ ] **Step 3: Collect rejections per chunk.** In `IngestionService.ts`:
  - Add the imports:

```ts
import { DiagnosticBuffer, emitDiagnostic, edgeDropDiagnostic } from '../utils/diagnostics';
import type { EdgeDrop } from '../utils/ontology';
```

  - Add `factRejectionReason` to the existing `../utils/pure` import.
  - Inside the per-chunk closure's `try`, replace the `return { status: 'ok' as const, facts: ..., ontology_updates: ... };` block with:

```ts
            const rawFacts: unknown[] = Array.isArray(result.facts) ? result.facts : [];
            const facts: ExtractedFact[] = [];
            const itemIndexes: number[] = [];
            const rejected: Array<{ itemIndex: number; reason: ReturnType<typeof factRejectionReason> }> = [];
            rawFacts.forEach((raw, itemIndex) => {
              const valid = validateFact(raw);
              if (valid) {
                facts.push(valid);
                itemIndexes.push(itemIndex);
              } else {
                rejected.push({ itemIndex, reason: factRejectionReason(raw) });
              }
            });
            return {
              status: 'ok' as const,
              facts,
              itemIndexes,
              rejected,
              ontology_updates: result.ontology_updates,
            };
```

- [ ] **Step 4: Buffer the chunk failures, rejections and dedupe drops.** Just before `let ingestedChunks = 0;`, add:

```ts
      const diagBuffer = new DiagnosticBuffer();
      const diagBase = { entityId, operation: 'ingest' as const, trigger: 'call' as const };
```

Replace the single-pass loop `for (const slot of chunkResults) { ... }` with:

```ts
      for (const [chunkIndex, slot] of chunkResults.entries()) {
        if (slot.status === 'failed') {
          failedChunks++;
          failures.push(slot.error);
          continue;
        }
        ingestedChunks++;
        for (const r of slot.rejected) {
          diagBuffer.push({ ...diagBase, code: 'fact_rejected', detail: { sourceRef, chunkIndex, itemIndex: r.itemIndex, reason: r.reason } });
        }
        const dedupedFacts: ExtractedFact[] = [];
        slot.facts.forEach((fact, k) => {
          const normalizedTitle = normalizeTitleKey(fact.title);
          if (!seen.has(normalizedTitle)) {
            seen.add(normalizedTitle);
            dedupedFacts.push(fact);
          } else {
            diagBuffer.push({
              ...diagBase, code: 'fact_deduplicated',
              detail: { sourceRef, chunkIndex, itemIndex: slot.itemIndexes[k], reason: 'exact_title' },
            });
          }
        });
        orderedChunkFacts.push({ facts: dedupedFacts, ontology_updates: slot.ontology_updates });
      }

      for (const reason of ['parse', 'llm'] as const) {
        const ofReason = failures.filter((f) => f.source === reason);
        if (ofReason.length === 0) continue;
        diagBuffer.push({
          ...diagBase, code: 'ingest_chunk_failed',
          detail: {
            sourceRef, reason, count: ofReason.length,
            chunkIndexes: ofReason.map((f) => f.chunkIndex).sort((a, b) => a - b).slice(0, 20),
          },
        });
      }
```

The existing `if (failedChunks === chunks.length) throw new WikiIngestEmptyError(...)` below is unchanged. The throw abandons `diagBuffer` without flushing, which is the spec's discard rule.

- [ ] **Step 5: Pass the buffer into both write paths.**
  - Change the full-path call to `this.runFullUpsertGraph(entityId, sourceRef, sourceHash, orderedChunkFacts, tx, diagBuffer)`.
  - Change the partial-path call to `this.appendPartialFacts(entityId, sourceRef, flat, tx, diagBuffer)`.
  - Directly **after** the whole `try { ... } catch (err) { ... }` around those transactions, and **before** `await this.searchService.sync(entityId);`, add:

```ts
      // Post-commit (spec §4.2.4). The duplicate-hash `return zeroChunkResult(...)`
      // paths in the catch above leave without flushing: nothing was committed.
      diagBuffer.flush(this.options);
```

- [ ] **Step 6: `runFullUpsertGraph` emits edge drops.**
  - Add a trailing parameter `diagBuffer: DiagnosticBuffer` to `runFullUpsertGraph`.
  - In pass 1, replace the `const normalized = ...validateAndNormalizeFact(...)` and `const id = generateId('fact_');` lines with the version below, which generates the id first:

```ts
        const id = generateId('fact_');
        const validationDrops: EdgeDrop[] = [];
        const normalized = this.ontologyService?.validateAndNormalizeFact(ontologyFact, manifest, { strict: false, drops: validationDrops })
          ?? { okf_type: null, edges: [] };
        for (const drop of validationDrops) {
          diagBuffer.push(edgeDropDiagnostic(drop, { entityId, operation: 'ingest', trigger: 'call', sourceRef, factId: id }));
        }
```

  - Replace pass 2's loop body with:

```ts
    for (const req of rawEdgeRequests) {
      const resolveDrops: EdgeDrop[] = [];
      const resolved = this.ontologyService?.resolveEdges(
        entityId, req.sourceId, req.sourceType, req.edges, manifest, titleIndex, now, resolveDrops,
      ) ?? [];
      for (const drop of resolveDrops) {
        diagBuffer.push(edgeDropDiagnostic(drop, { entityId, operation: 'ingest', trigger: 'call', sourceRef }));
      }
      for (const e of resolved) {
        hostEdges.push({ type: e.edge_type, sourceId: e.source_id, targetId: e.target_id });
      }
    }
```

  - Change its `upsertGraphCore(...)` call's last argument from `{ strict: false }` to `{ strict: false, diag: { buffer: diagBuffer, operation: 'ingest' } }`.

- [ ] **Step 7: `appendPartialFacts` reports partial-path duplicates.** Add a trailing parameter `diagBuffer: DiagnosticBuffer`. Inside the `if (liveTitles.has(normalizedTitle)) {` branch, before `skippedDuplicate++;`, add:

```ts
        diagBuffer.push({
          entityId, operation: 'ingest', trigger: 'call', code: 'fact_deduplicated',
          detail: { sourceRef, reason: 'exact_title' },
        });
```

- [ ] **Step 8: `upsertGraphCore` reports manifest violations.**
  - Change its `opts` type to `opts?: { strict?: boolean; diag?: { buffer: DiagnosticBuffer; operation: 'ingest' | 'upsertGraph' } }`.
  - Inside the `if (!match) {` branch, after the `if (strictEffective) throw ...;` line and before `continue;`, add:

```ts
        opts?.diag?.buffer.push({
          entityId, operation: opts.diag.operation, trigger: 'call', code: 'edge_dropped',
          detail: {
            reason: 'manifest_violation', factId: edge.sourceId, edgeType: edge.type,
            ...(sourceType ? { sourceNodeType: sourceType } : {}), sourceRef: params.sourceRef,
          },
        });
```

- [ ] **Step 9: Retire-hook failure after commit.** In the post-commit loop, inside `catch (hookErr) {`, after the existing `console.warn(...)` line (which stays unchanged), add:

```ts
            emitDiagnostic(this.options, {
              entityId, operation: 'ingest', trigger: 'call', code: 'hook_failed',
              detail: { factId, reason: 'on_embedding_persisted' },
            });
```

- [ ] **Step 10: `WikiMemory.upsertGraph` flushes on resolve.** In `packages/core/src/WikiMemory.ts`, add `import { DiagnosticBuffer } from './utils/diagnostics';` and replace the final `return this.ingestionService.upsertGraphCore(...)` with:

```ts
    // The host owns this transaction and core never sees its commit, so
    // diagnostics are delivered when upsertGraph resolves (spec §4.2.4).
    // Hosts that roll back should disregard them.
    const diagBuffer = new DiagnosticBuffer();
    const result = await this.ingestionService.upsertGraphCore(
      entityId,
      { sourceRef, sourceHash, nodes: params.nodes, edges: params.edges },
      adapter,
      { diag: { buffer: diagBuffer, operation: 'upsertGraph' } },
    );
    diagBuffer.flush(this.options);
    return result;
```

- [ ] **Step 11: Run the tests.** Run `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/diagnosticsIngest.test.ts __tests__/ingest.test.ts __tests__/graphOwnershipIngest.test.ts __tests__/ingestRaceTranslation.test.ts`. Expected: PASS. Then run typecheck; expected exit 0. If `ingest.test.ts` uses mocked services and fails only because a new parameter is `undefined`, fix the **implementation** (for example, a missing default), not the test.

- [ ] **Step 12: Commit.**

```bash
git add packages/core/src/services/IngestionService.ts packages/core/src/WikiMemory.ts packages/core/__tests__/diagnosticsIngest.test.ts
git commit -m "feat(core): emit ingest and upsertGraph diagnostics

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Embedding diagnostics

**Files:**
- Modify: `packages/core/src/services/EmbeddingService.ts` (`tryEmbedFact` ~95, `embedFact` ~182)
- Modify: `packages/core/src/services/IngestionService.ts` (post-commit `embedFact` loop)
- Modify: `packages/core/src/services/MaintenanceService.ts` (`runReembed` `tryEmbedFact` call ~428)
- Modify: `packages/core/src/services/ImportExportService.ts` (`embedFact` call ~443)
- Test: `packages/core/__tests__/diagnosticsEmbedding.test.ts`

**Interfaces:**
- Consumes: `emitDiagnostic`, and the `WikiDiagnosticOperation` and `WikiDiagnosticTrigger` types.
- Produces: `interface EmbedDiagnosticContext { operation: WikiDiagnosticOperation; trigger: WikiDiagnosticTrigger }` (exported from `EmbeddingService.ts`), `tryEmbedFact(fact, ctx?: EmbedDiagnosticContext)`, `embedFact(fact, ctx?: EmbedDiagnosticContext)`. Without `ctx`, nothing is emitted.

- [ ] **Step 1: Write failing tests** in `packages/core/__tests__/diagnosticsEmbedding.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeDiagnosticWiki, ofCode, expectNoContent, HASH_A } from './helpers/diagnosticsHarness';

afterEach(() => vi.restoreAllMocks());

const oneFact = async () => JSON.stringify({ facts: [{ title: 'Embed me', body: 'secret body', tags: [], confidence: 'certain' }] });

describe('embedding diagnostics', () => {
  it('embed() throwing → embedding_failed/embed_threw with the fact id, no provider message', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { wiki, diagnostics } = await makeDiagnosticWiki({
      generateText: oneFact,
      embed: async () => { throw new Error('provider says: secret body'); },
    });
    await wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: 'content' });
    const failed = ofCode(diagnostics, 'embedding_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ operation: 'ingest', trigger: 'call', entityId: 'e1', detail: { reason: 'embed_threw' } });
    expect(failed[0].detail?.factId).toMatch(/^fact_/);
    expectNoContent(diagnostics, ['secret body', 'provider says']);
  });

  it('invalid vector → invalid_vector', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { wiki, diagnostics } = await makeDiagnosticWiki({ generateText: oneFact, embed: async () => [] });
    await wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: 'content' });
    expect(ofCode(diagnostics, 'embedding_failed').map((d) => d.detail?.reason)).toEqual(['invalid_vector']);
  });

  it('float32 overflow → float32_overflow', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { wiki, diagnostics } = await makeDiagnosticWiki({ generateText: oneFact, embed: async () => [1e300, 1] });
    await wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: 'content' });
    expect(ofCode(diagnostics, 'embedding_failed').map((d) => d.detail?.reason)).toEqual(['float32_overflow']);
  });

  it('onEmbeddingPersisted throwing → hook_failed/on_embedding_persisted', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { wiki, diagnostics } = await makeDiagnosticWiki({
      generateText: oneFact,
      embed: async () => [0.1, 0.2],
      extra: {
        vectorRanker: {
          rankBySimilarity: async () => [],
          onEmbeddingPersisted: () => { throw new Error('ann down'); },
        } as never,
      },
    });
    await wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: 'content' });
    expect(ofCode(diagnostics, 'hook_failed')).toEqual([
      expect.objectContaining({ operation: 'ingest', detail: expect.objectContaining({ reason: 'on_embedding_persisted' }) }),
    ]);
  });

  it('runReembed reports operation reembed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let fail = false;
    const { wiki, diagnostics } = await makeDiagnosticWiki({
      generateText: oneFact,
      embed: async () => { if (fail) throw new Error('x'); return [0.1, 0.2]; },
    });
    await wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: 'content' });
    fail = true;
    await wiki.runReembed('e1', { force: true });
    expect(ofCode(diagnostics, 'embedding_failed').map((d) => [d.operation, d.trigger])).toEqual([['reembed', 'call']]);
  });
});
```

> Before running, open `VectorRanker` in `src/types.ts` (~line 545) and check that the stub in the `hook_failed` test satisfies the interface's required members. Add any other required method as `async () => []`. The `as never` cast only silences typing; runtime must not call a missing method.
>
> Also open `WikiMemory.runReembed` (~line 499) and match the test call to its real signature (`runReembed(entityId?, options?)` with a `force` option at the time of writing).

- [ ] **Step 2: Run it and confirm it fails.** Run: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/diagnosticsEmbedding.test.ts`. Expected: FAIL, with no `embedding_failed` diagnostics.

- [ ] **Step 3: Implement the context in `EmbeddingService.ts`.**
  - Add the imports `import { emitDiagnostic } from '../utils/diagnostics';` and `import type { WikiDiagnosticOperation, WikiDiagnosticTrigger } from '../types';`.
  - Export `export interface EmbedDiagnosticContext { operation: WikiDiagnosticOperation; trigger: WikiDiagnosticTrigger; }`.
  - Add a private helper to the class:

```ts
  private reportEmbed(
    ctx: EmbedDiagnosticContext | undefined,
    fact: { id: string; entity_id: string },
    code: 'embedding_failed' | 'hook_failed',
    reason: 'invalid_vector' | 'float32_overflow' | 'embed_threw' | 'persist_failed' | 'on_embedding_persisted',
  ): void {
    if (!ctx) return;
    emitDiagnostic(this.options, {
      code, operation: ctx.operation, trigger: ctx.trigger, entityId: fact.entity_id,
      detail: { factId: fact.id, reason },
    });
  }
```

  - Give `tryEmbedFact` a second parameter, `ctx?: EmbedDiagnosticContext`. Directly after each existing `console.warn(...)` in it, add the matching call and leave the warn itself unchanged:
    - invalid vector: `this.reportEmbed(ctx, fact, 'embedding_failed', 'invalid_vector');`
    - float32: `this.reportEmbed(ctx, fact, 'embedding_failed', 'float32_overflow');`
    - `catch (err)` around `embedFn`: `this.reportEmbed(ctx, fact, 'embedding_failed', 'embed_threw');`
    - persist `catch`: `this.reportEmbed(ctx, fact, 'embedding_failed', 'persist_failed');`
    - `notifyEmbeddingPersisted` `catch (hookErr)`: `this.reportEmbed(ctx, fact, 'hook_failed', 'on_embedding_persisted');`
  - Give `embedFact` a second parameter, `ctx?: EmbedDiagnosticContext`, and change its body to `const result = await this.tryEmbedFact(fact, ctx);`.

- [ ] **Step 4: Pass a context from each caller.**
  - `IngestionService` post-commit loop: `await this.embeddingService.embedFact(fact, { operation: 'ingest', trigger: 'call' });`
  - `MaintenanceService.runReembed`: `const result = await this.embeddingService.tryEmbedFact(row, { operation: 'reembed', trigger: 'call' });`
  - `ImportExportService.importDump`: add `{ operation: 'importDump', trigger: 'call' }` as the second argument of `embedFact({...})`.

  The librarian and heal callers get their context in Task 5.

- [ ] **Step 5: Run the tests.** Run `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/diagnosticsEmbedding.test.ts __tests__/services/EmbeddingService.test.ts __tests__/runReembed.test.ts __tests__/embeddingFailureMarkers.test.ts __tests__/importDump.test.ts`. Expected: PASS. Then run typecheck; expected exit 0.

- [ ] **Step 6: Commit.**

```bash
git add packages/core/src/services/EmbeddingService.ts packages/core/src/services/IngestionService.ts packages/core/src/services/MaintenanceService.ts packages/core/src/services/ImportExportService.ts packages/core/__tests__/diagnosticsEmbedding.test.ts
git commit -m "feat(core): emit embedding and hook diagnostics

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Librarian, heal and backfill emissions with `trigger` threading

**Files:**
- Modify: `packages/core/src/services/MaintenanceService.ts` (`doRunLibrarian` ~606, `doRunHeal` ~742, `_applyOntologyBackfillBatch` ~1206)
- Test: `packages/core/__tests__/diagnosticsMaintenance.test.ts`

**Interfaces:**
- Consumes: `DiagnosticBuffer`, `emitDiagnostic`, `edgeDropDiagnostic`, `factRejectionReason`, `taskRejectionReason`, `EdgeDrop`, `EmbedDiagnosticContext`.
- Produces:
  - `doRunLibrarian(entityId: string, promptOverride?: string, trigger: WikiDiagnosticTrigger = 'call')`
  - `doRunHeal(entityId, options?: { promptOverride?; batchSize?; bodyTruncationChars?; trigger?: WikiDiagnosticTrigger })`
  - Task 6 depends on both signatures.

- [ ] **Step 1: Write failing tests** in `packages/core/__tests__/diagnosticsMaintenance.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeDiagnosticWiki, ofCode, expectNoContent } from './helpers/diagnosticsHarness';
import type { OntologyManifest } from '../src/types';

const MANIFEST: OntologyManifest = {
  node_types: [{ type: 'person', description: 'A person' }, { type: 'place', description: 'A place' }],
  edge_types: [{ type: 'lives_in', source_type: 'person', target_type: 'place', description: 'Person lives in place' }],
};

afterEach(() => vi.restoreAllMocks());

describe('librarian diagnostics', () => {
  it('reports rejected facts, rejected tasks, fuzzy dedupe and dropped edges with trigger call', async () => {
    let calls = 0;
    const { wiki, diagnostics } = await makeDiagnosticWiki({
      generateText: async () => {
        calls++;
        if (calls === 1) {
          return JSON.stringify({
            facts: [{ title: 'Ada Lovelace wrote programs', body: 'first', tags: [], confidence: 'inferred' }],
            tasks: [],
          });
        }
        return JSON.stringify({
          facts: [
            { title: 7, body: 'bad' },
            { title: 'Ada Lovelace wrote programs', body: 'dup', tags: [], confidence: 'inferred' },
            { title: 'Grace', body: 'g', tags: [], confidence: 'inferred', okf_type: 'person',
              edges: [{ edge_type: 'lives_in', target_title: 'Nowhere Land' }] },
          ],
          tasks: [{ description: '   ' }],
        });
      },
    });
    await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'strict' });
    await wiki.write('e1', { event_type: 'observation', summary: 'event one' });
    await wiki.runLibrarian('e1');
    diagnostics.length = 0;
    await wiki.runLibrarian('e1');

    const base = { operation: 'librarian', trigger: 'call', entityId: 'e1' };
    expect(ofCode(diagnostics, 'fact_rejected')).toEqual([expect.objectContaining({ ...base, detail: { itemIndex: 0, reason: 'invalid_shape' } })]);
    expect(ofCode(diagnostics, 'task_rejected')).toEqual([expect.objectContaining({ ...base, detail: { itemIndex: 0, reason: 'missing_description' } })]);
    expect(ofCode(diagnostics, 'fact_deduplicated')).toEqual([expect.objectContaining({ ...base, detail: { itemIndex: 1, reason: 'fuzzy_title' } })]);
    const drops = ofCode(diagnostics, 'edge_dropped');
    expect(drops).toHaveLength(1);
    expect(drops[0].detail).toMatchObject({ reason: 'target_not_found', edgeType: 'lives_in', sourceNodeType: 'person' });
    expect(drops[0].detail?.factId).toMatch(/^fact_/);
    expectNoContent(diagnostics, ['Nowhere Land', 'dup', 'Ada Lovelace']);
  });
});

describe('heal diagnostics', () => {
  it('reports heal_skipped for a candidate whose call errors, after commit', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { wiki, db, diagnostics } = await makeDiagnosticWiki({
      generateText: async ({ userPrompt }) => {
        if (userPrompt.includes('Heal Candidates')) throw new Error('provider down');
        return JSON.stringify({ facts: [], tasks: [] });
      },
    });
    await db.runAsync(
      `INSERT INTO llm_wiki_entries (id, entity_id, title, body, confidence, source_type, created_at, updated_at)
       VALUES ('h1', 'e1', 'Candidate', 'candidate body', 'inferred', 'librarian_inferred', 1, 1)`,
    );
    await wiki.runHeal('e1');
    const skipped = ofCode(diagnostics, 'heal_skipped');
    expect(skipped).toEqual([
      expect.objectContaining({ operation: 'heal', trigger: 'call', entityId: 'e1', detail: { factId: 'h1', reason: 'call_error' } }),
    ]);
    expectNoContent(diagnostics, ['candidate body', 'provider down']);
  });
});

describe('ontology backfill diagnostics', () => {
  it('reports edges dropped while applying classifications', async () => {
    const { wiki, db, diagnostics } = await makeDiagnosticWiki({
      generateText: async () => JSON.stringify({
        classifications: [{ id: 'b1', okf_type: 'person', edges: [{ edge_type: 'lives_in', target_title: 'Unknown City' }] }],
      }),
    });
    await wiki.setOntologyManifest('e1', MANIFEST, { mode: 'strict' });
    await db.runAsync(
      `INSERT INTO llm_wiki_entries (id, entity_id, title, body, confidence, source_type, created_at, updated_at)
       VALUES ('b1', 'e1', 'Ada', 'b', 'certain', 'user_stated', 1, 1)`,
    );
    await wiki.runOntologyBackfill('e1');
    expect(ofCode(diagnostics, 'edge_dropped')).toEqual([
      expect.objectContaining({
        operation: 'ontologyBackfill', trigger: 'call',
        detail: { reason: 'target_not_found', factId: 'b1', edgeType: 'lives_in', sourceNodeType: 'person' },
      }),
    ]);
  });
});
```

> The heal test relies on the heal candidate query selecting `h1`. If it does not (check `findHealCandidatesByEntityId` for eligibility rules, such as `heal_checked_at` or a source type), adjust **only the fixture row** until `runHeal` offers `h1` to the provider. Keep the expected diagnostic unchanged.

- [ ] **Step 2: Run it and confirm it fails.** Run: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/diagnosticsMaintenance.test.ts`. Expected: FAIL.

- [ ] **Step 3: Update the librarian** (`doRunLibrarian`).
  - Add the imports (`DiagnosticBuffer`, `emitDiagnostic`, `edgeDropDiagnostic` from `../utils/diagnostics`; `type EdgeDrop` from `../utils/ontology`; `type WikiDiagnosticTrigger` from `../types`) and add `factRejectionReason, taskRejectionReason` to the `../utils/pure` import.
  - Change the signature to `async doRunLibrarian(entityId: string, promptOverride?: string, trigger: WikiDiagnosticTrigger = 'call'): Promise<void>`.
  - Replace the two `validFacts` and `validTasks` lines with:

```ts
    const diagBuffer = new DiagnosticBuffer();
    const diagBase = { entityId, operation: 'librarian' as const, trigger };
    const validFacts: ExtractedFact[] = [];
    const validFactItemIndexes: number[] = [];
    facts.forEach((raw, itemIndex) => {
      const valid = validateFact(raw);
      if (valid) {
        validFacts.push(valid);
        validFactItemIndexes.push(itemIndex);
      } else {
        diagBuffer.push({ ...diagBase, code: 'fact_rejected', detail: { itemIndex, reason: factRejectionReason(raw) } });
      }
    });
    const validTasks: ExtractedTask[] = [];
    tasks.forEach((raw, itemIndex) => {
      const valid = validateTask(raw);
      if (valid) validTasks.push(valid);
      else diagBuffer.push({ ...diagBase, code: 'task_rejected', detail: { itemIndex, reason: taskRejectionReason(raw) } });
    });
```

  - In the transaction, change `for (const fact of validFacts) {` to `for (const [k, fact] of validFacts.entries()) {`.
  - Replace `if (skip) continue;` with:

```ts
        if (skip) {
          diagBuffer.push({ ...diagBase, code: 'fact_deduplicated', detail: { itemIndex: validFactItemIndexes[k], reason: 'fuzzy_title' } });
          continue;
        }
```

  - Move `const id = generateId('fact_');` above the `validateAndNormalizeFact` call, and pass drops:

```ts
        const id = generateId('fact_');
        const validationDrops: EdgeDrop[] = [];
        const normalized = this.ontologyService?.validateAndNormalizeFact(ontologyFact, manifest, { strict: false, drops: validationDrops })
          ?? { okf_type: null, edges: [] };
        for (const drop of validationDrops) diagBuffer.push(edgeDropDiagnostic(drop, { ...diagBase, factId: id }));
```

  - Replace the `pendingEdges` persistence loop with:

```ts
      for (const item of pendingEdges) {
        const resolveDrops: EdgeDrop[] = [];
        await this.ontologyService?.resolveAndPersistEdges(
          entityId, item.sourceId, item.sourceType, item.edges ?? [], manifest, titleIndex, tx, now, resolveDrops,
        );
        for (const drop of resolveDrops) diagBuffer.push(edgeDropDiagnostic(drop, diagBase));
      }
```

  - After the transaction, immediately after `});` closes `withTransactionAsync` and before `await this.searchService.sync(entityId);`, add `diagBuffer.flush(this.options);`.
  - Change the embed loop call to `await this.embeddingService.embedFact(fact, { operation: 'librarian', trigger });`.

- [ ] **Step 4: Update heal** (`doRunHeal`).
  - Add `trigger?: WikiDiagnosticTrigger;` to its `options` type, and at the top of the body add `const trigger: WikiDiagnosticTrigger = options?.trigger ?? 'call';` and `const diagBase = { entityId, operation: 'heal' as const, trigger };`.
  - Orphan-pass hook loop: inside `catch (hookErr) {`, after the unchanged `console.warn`, add:

```ts
        emitDiagnostic(this.options, { ...diagBase, code: 'hook_failed', detail: { factId, reason: 'on_embedding_persisted' } });
```

  - Replace `const validNewFacts = newFacts.map(validateFact).filter(...)` with:

```ts
    const diagBuffer = new DiagnosticBuffer();
    const validNewFacts: ExtractedFact[] = [];
    const validNewFactItemIndexes: number[] = [];
    newFacts.forEach((raw, itemIndex) => {
      const valid = validateFact(raw);
      if (valid) {
        validNewFacts.push(valid);
        validNewFactItemIndexes.push(itemIndex);
      } else {
        diagBuffer.push({ ...diagBase, code: 'fact_rejected', detail: { itemIndex, reason: factRejectionReason(raw) } });
      }
    });
```

  - In the second transaction, change `for (const fact of validNewFacts) {` to `for (const [k, fact] of validNewFacts.entries()) {`, and replace `if (skip) continue;` with:

```ts
        if (skip) {
          diagBuffer.push({ ...diagBase, code: 'fact_deduplicated', detail: { itemIndex: validNewFactItemIndexes[k], reason: 'fuzzy_title' } });
          continue;
        }
```

  - After that transaction closes and before `await this.searchService.sync(entityId);`, add:

```ts
    for (const { item, reason } of outcome.skipped) {
      diagBuffer.push({ ...diagBase, code: 'heal_skipped', detail: { factId: item.id, reason } });
    }
    diagBuffer.flush(this.options);
```

  - In the deleted-facts hook loop's `catch (hookErr)`, after the unchanged `console.warn`, add the same `hook_failed` emission as the orphan loop.
  - Change the heal embed call to `await this.embeddingService.embedFact(fact, { operation: 'heal', trigger });`.

- [ ] **Step 5: Update the ontology backfill apply** (`_applyOntologyBackfillBatch`).
  - At the top of the method add `const diagBuffer = new DiagnosticBuffer();` and `const diagBase = { entityId, operation: 'ontologyBackfill' as const, trigger: 'call' as const };`.
  - Pass `drops` to `validateAndNormalizeFact`:
    - Add `const validationDrops: EdgeDrop[] = [];` before the call, and add `drops: validationDrops` to its `{ strict: false }` options.
    - After the call, push each drop: `for (const drop of validationDrops) diagBuffer.push(edgeDropDiagnostic(drop, { ...diagBase, factId: fact.id }));`
  - In the `pendingEdges` loop, give `resolveAndPersistEdges` a `resolveDrops` array and push each drop with `edgeDropDiagnostic(drop, diagBase)`.
  - After `await this.db.withTransactionAsync(...)` resolves, add `diagBuffer.flush(this.options);`. If the transaction aborted because ontology is off, the buffer is empty.

- [ ] **Step 6: Run the tests.** Run `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/diagnosticsMaintenance.test.ts __tests__/services/MaintenanceService.test.ts __tests__/ontologyBackfill.test.ts __tests__/healBounding.test.ts __tests__/healAnchorBounding.test.ts __tests__/jobs.test.ts`. Expected: PASS. Then run typecheck; expected exit 0.

- [ ] **Step 7: Commit.**

```bash
git add packages/core/src/services/MaintenanceService.ts packages/core/__tests__/diagnosticsMaintenance.test.ts
git commit -m "feat(core): emit librarian, heal and backfill diagnostics

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Background jobs (`trigger: 'auto'`) and `background_job_failed`

**Files:**
- Modify: `packages/core/src/services/WriteService.ts`
- Test: `packages/core/__tests__/diagnosticsBackground.test.ts`

**Interfaces:**
- Consumes: `emitDiagnostic`; `doRunLibrarian(entityId, promptOverride?, trigger)` and `doRunHeal(entityId, { trigger })` from Task 5.

- [ ] **Step 1: Write failing tests** in `packages/core/__tests__/diagnosticsBackground.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeDiagnosticWiki, ofCode } from './helpers/diagnosticsHarness';

afterEach(() => vi.restoreAllMocks());

describe('background job diagnostics', () => {
  it('auto-librarian failure → background_job_failed with operation librarian, trigger auto; console.error unchanged', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('llm offline');
    const { wiki, diagnostics } = await makeDiagnosticWiki({
      config: { autoLibrarianThreshold: 1 },
      generateText: async () => { throw failure; },
    });
    await wiki.write('e1', { event_type: 'observation', summary: 'one' });
    await vi.waitFor(() => expect(ofCode(diagnostics, 'background_job_failed')).toHaveLength(1));
    expect(ofCode(diagnostics, 'background_job_failed')[0]).toMatchObject({
      severity: 'error', operation: 'librarian', trigger: 'auto', entityId: 'e1',
      detail: { reason: 'unhandled_rejection' },
    });
    expect(error).toHaveBeenCalledWith(failure);
    expect(JSON.stringify(diagnostics)).not.toContain('llm offline');
  });

  it('auto-librarian run tags its own diagnostics with trigger auto', async () => {
    const { wiki, diagnostics } = await makeDiagnosticWiki({
      config: { autoLibrarianThreshold: 1 },
      generateText: async () => JSON.stringify({ facts: [{ title: 5, body: 'x' }], tasks: [] }),
    });
    await wiki.write('e1', { event_type: 'observation', summary: 'one' });
    await vi.waitFor(() => expect(ofCode(diagnostics, 'fact_rejected')).toHaveLength(1));
    expect(ofCode(diagnostics, 'fact_rejected')[0]).toMatchObject({ operation: 'librarian', trigger: 'auto' });
  });

  it('host-invoked runLibrarian tags diagnostics with trigger call', async () => {
    const { wiki, diagnostics } = await makeDiagnosticWiki({
      generateText: async () => JSON.stringify({ facts: [{ title: 5, body: 'x' }], tasks: [] }),
    });
    await wiki.write('e1', { event_type: 'observation', summary: 'one' });
    await wiki.runLibrarian('e1');
    expect(ofCode(diagnostics, 'fact_rejected')[0]).toMatchObject({ operation: 'librarian', trigger: 'call' });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/diagnosticsBackground.test.ts`. Expected: FAIL. The first two tests time out in `vi.waitFor`; the third passes.

- [ ] **Step 3: Implement in `WriteService.ts`.**
  - Add `import { emitDiagnostic } from '../utils/diagnostics';`.
  - Replace the auto-librarian launch chain with:

```ts
        const stage: { job: 'librarian' | 'heal' } = { job: 'librarian' };
        this.runLibrarianThenMaybeHeal(entityId, librarianCount, prevMemoryCheckpoint, stage)
          .catch((err: unknown) => {
            console.error(err);
            this.reportBackgroundFailure(entityId, stage.job);
          })
          .finally(() => {
            this.jobManager.releaseLock('librarian', entityId);
          });
```

  - Replace `this.maybeRunHeal(entityId, eventCount).catch(console.error);` with:

```ts
      this.maybeRunHeal(entityId, eventCount).catch((err: unknown) => {
        console.error(err);
        this.reportBackgroundFailure(entityId, 'heal');
      });
```

  - Change `runLibrarianThenMaybeHeal` to take `stage: { job: 'librarian' | 'heal' }` as a fourth parameter. Call `this.maintenanceService.doRunLibrarian(entityId, undefined, 'auto')`, and set `stage.job = 'heal';` immediately before `await this.maybeRunHeal(entityId, currentEventCount);`.
  - In `maybeRunHeal`, change the call to `this.maintenanceService.doRunHeal(entityId, { trigger: 'auto' })`.
  - Add the method:

```ts
  private reportBackgroundFailure(entityId: string, job: 'librarian' | 'heal'): void {
    emitDiagnostic(this.options, {
      code: 'background_job_failed', operation: job, trigger: 'auto', entityId,
      detail: { reason: 'unhandled_rejection' },
    });
  }
```

`console.error(err)` receives the same single argument that `.catch(console.error)` passed, so the console output is byte-identical.

- [ ] **Step 4: Run the tests.** Run `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/diagnosticsBackground.test.ts __tests__/services/WriteService.test.ts __tests__/jobs.test.ts`. Expected: PASS. Then run typecheck; expected exit 0.

- [ ] **Step 5: Commit.**

```bash
git add packages/core/src/services/WriteService.ts packages/core/__tests__/diagnosticsBackground.test.ts
git commit -m "feat(core): report background job failures and tag auto-triggered runs

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Console-compatibility regression, docs, full verification

**Files:**
- Test: `packages/core/__tests__/diagnosticsConsoleCompat.test.ts`
- Modify: `packages/core/README.md` (new `## Diagnostics` section directly before `## Per-Entity Seeded Ontology`)

- [ ] **Step 1: Write the compatibility test** `packages/core/__tests__/diagnosticsConsoleCompat.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeDiagnosticWiki, HASH_A } from './helpers/diagnosticsHarness';

afterEach(() => vi.restoreAllMocks());

const DOC = 'ALPHA chunk text here.\n\nBROKEN chunk text here.';

async function runScenario(withHook: boolean): Promise<string[]> {
  const lines: string[] = [];
  const record = (...args: unknown[]) => { lines.push(args.map((a) => (a instanceof Error ? `Error:${a.message}` : String(a))).join(' ')); };
  vi.spyOn(console, 'warn').mockImplementation(record);
  vi.spyOn(console, 'error').mockImplementation(record);
  const { wiki } = await makeDiagnosticWiki({
    withHook,
    config: { maxChunkLength: 30, chunkOverlap: 0 },
    embed: async () => { throw new Error('embed down'); },
    generateText: async ({ userPrompt }) => userPrompt.includes('BROKEN')
      ? 'not json'
      : JSON.stringify({ facts: [{ title: 'T', body: 'B', tags: [], confidence: 'certain' }, { title: 5, body: 'x' }] }),
  });
  await wiki.ingestDocument('e1', { sourceRef: 'doc.md', sourceHash: HASH_A, documentChunk: DOC });
  vi.restoreAllMocks();
  // Fact ids are random; normalize them so the two runs are comparable.
  return lines.map((l) => l.replace(/fact_[A-Za-z0-9_-]+/g, 'fact_X'));
}

describe('REQ-COMPAT-01.4', () => {
  it('console output is identical with and without onDiagnostic', async () => {
    const withoutHook = await runScenario(false);
    const withHook = await runScenario(true);
    expect(withoutHook.length).toBeGreaterThan(0);
    expect(withHook).toEqual(withoutHook);
  });
});
```

- [ ] **Step 2: Run it.** Run: `pnpm --filter @equationalapplications/core-llm-wiki exec vitest run __tests__/diagnosticsConsoleCompat.test.ts`. Expected: PASS. If it fails, some code path logs differently depending on the hook. Fix that code, not this test.

- [ ] **Step 3: Document it.** Insert this section into `packages/core/README.md` directly before `## Per-Entity Seeded Ontology`. Before writing it, grep `packages/core/src/types.ts` for each name used so the docs match the source.

````markdown
## Diagnostics

Pass `onDiagnostic` to receive typed, content-free reports of events core used to drop silently or only log: failed chunks, rejected facts and tasks, dedupe drops, dropped edges, embedding and host-hook failures, heal skips, and background-job failures.

```ts
const wiki = createWiki(db, {
  llmProvider,
  onDiagnostic: (d) => {
    // d.code, d.severity ('info' | 'warn' | 'error'), d.operation, d.trigger ('call' | 'auto'),
    // d.entityId, d.at, d.message, d.detail?: { factId, sourceRef, chunkIndex, itemIndex,
    // edgeType, sourceNodeType, targetNodeType, reason, count, chunkIndexes }
    telemetry.record(d);
  },
});
```

- **Content-free.** Diagnostics carry IDs, indexes, counts, ontology slugs and reason slugs only. They never carry titles, bodies, LLM output, provider error messages, or hashes of content.
- **Isolated.** The hook is called synchronously. A throwing or rejecting hook never affects the operation, and its failure is logged with `console.warn`.
- **After commit.** Transactional diagnostics are delivered after the operation's transaction commits. An operation that throws delivers none; the exception is the signal. `upsertGraph` runs in your transaction, so its diagnostics are delivered when it resolves. Disregard them if you roll back.
- **`trigger`.** `'auto'` marks work started by `autoLibrarianThreshold` / `autoHealThreshold`. A failed background job is reported as `background_job_failed` with `operation` set to the job.
- **Forward-compatible.** New codes may be added in minor releases; ignore codes you don't recognize.
- **Console output is unchanged** whether or not a hook is set.
````

- [ ] **Step 4: Run the full verification.** Run `pnpm --filter @equationalapplications/core-llm-wiki test` and `pnpm --filter @equationalapplications/core-llm-wiki typecheck`. Expected: all tests pass and typecheck exits 0. Then run the repo-wide `pnpm test`, expecting PASS; the integration suite runs here too.

- [ ] **Step 5: Commit.**

```bash
git add packages/core/__tests__/diagnosticsConsoleCompat.test.ts packages/core/README.md
git commit -m "docs(core): document onDiagnostic and pin console compatibility

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Self-review against the spec

| Spec | Covered by |
|---|---|
| §4.1 types, `trigger`, locators, `WikiOptions.onDiagnostic` | Task 1 |
| §4.2.1 additive console | Task 7 compatibility test; every task leaves existing console calls unchanged |
| §4.2.2 isolation, §4.2.3 async | Task 1 tests |
| §4.2.4 post-commit / `upsertGraph` exception | Tasks 3, 5 (flush placement); Task 3 all-fail discard test |
| §4.2.5 aggregation (`ingest_chunk_failed` only) | Task 3 |
| §4.2.6 fixed severity | Task 1 |
| §4.3 disclosure | `expectNoContent` in Tasks 3–6 |
| §4.4 every row | Task 3 (chunk failures, fact rejections, exact-title dedupe, `edge_dropped` including `manifest_violation`, ingest hook), Task 4 (embedding, `hook_failed`), Task 5 (task rejections, fuzzy dedupe, heal skips, librarian/backfill edges, heal hooks), Task 6 (`background_job_failed`) |
| §4.5 tests assert code, severity, operation, trigger, entityId, reason, locators, no content | Tasks 3–6 |

Out of scope for PR 1: the `grounding_*` and `classification_*` codes exist in the union but are emitted by PR 3 and PR 4.

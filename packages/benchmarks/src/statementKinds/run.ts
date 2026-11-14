/**
 * Statement-kinds classification runner (specs/statement-kinds/spec.md, test
 * plan item 7).
 *
 * Seeds an in-memory `WikiMemory` with the schema-software-org manifest and
 * three typed seed nodes (one `software_application`, one `area`, one
 * `organization`) so a proposed `about` edge resolves through the title
 * index. Each fixture statement is then written through the real
 * `remember()` path WITHOUT an `okf_type` and classified by the engine's own
 * `runOntologyBackfill` (the production code path that assembles the
 * classification prompt via `buildPromptContext` and sends it to the
 * provider). `remember()` itself has no LLM step, so the backfill is the
 * measured classifier. The runner names no prompt-assembly call.
 *
 * In-memory store only: `openDb()` is called with no path, never a file.
 */

import { readFileSync } from 'fs';

import { WikiMemory } from '@equationalapplications/core-llm-wiki';
import type { LLMProvider } from '@equationalapplications/core-llm-wiki';
import { schemaSoftwareOrgManifest } from '@equationalapplications/schema-software-org';

import { openDb } from '../db';
import { ChatEndpoint, createProvider } from '../provider';
import { engineInfo } from '../report';

type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<Response>;

export const STATEMENT_KINDS = ['rule', 'decision', 'lesson', 'trap'] as const;
export type StatementKind = (typeof STATEMENT_KINDS)[number];
export const TARGET_TYPES = ['area', 'software_application', 'organization'] as const;
export type TargetType = (typeof TARGET_TYPES)[number];

export interface StatementFixtureEntry {
  text: string;
  expected_kind: StatementKind;
  expected_target: { title: string; type: TargetType };
}

/** Seed nodes; every fixture `expected_target` must name one of these. */
export const SEED_NODES: ReadonlyArray<{ title: string; type: TargetType; body: string }> = [
  { title: 'Orbit', type: 'software_application', body: 'Orbit is a mobile application the organization builds and ships.' },
  { title: 'Deploy', type: 'area', body: 'The deploy area of Orbit: releasing builds to production.' },
  { title: 'Acme Labs', type: 'organization', body: 'Acme Labs is the software organization that builds Orbit.' },
];

/** Conservative flat per-statement input-token estimate (manifest prompt dominates). */
export const STATEMENT_KINDS_TOKENS_PER_STATEMENT = 6000;

const ENTITY = 'statement-kinds-bench';

/** Load and validate the fixture; throws on any malformed entry. */
export function parseStatementFixture(raw: string): StatementFixtureEntry[] {
  const data = JSON.parse(raw) as unknown;
  if (!Array.isArray(data)) throw new Error('statement-kinds fixture must be an array');
  const seeds = new Set(SEED_NODES.map((s) => `${s.type}:${s.title}`));
  return data.map((e: any, i: number) => {
    const where = `fixture entry ${i}`;
    if (typeof e?.text !== 'string' || e.text.trim() === '') throw new Error(`${where}: missing text`);
    if (!(STATEMENT_KINDS as readonly string[]).includes(e.expected_kind)) throw new Error(`${where}: bad expected_kind`);
    const t = e.expected_target;
    if (typeof t?.title !== 'string' || !(TARGET_TYPES as readonly string[]).includes(t.type)) throw new Error(`${where}: bad expected_target`);
    if (!seeds.has(`${t.type}:${t.title}`)) throw new Error(`${where}: expected_target is not a seed node`);
    return e as StatementFixtureEntry;
  });
}

export function loadStatementFixture(path: string): StatementFixtureEntry[] {
  return parseStatementFixture(readFileSync(path, 'utf8'));
}

export interface StatementRow {
  text: string;
  expected_kind: StatementKind;
  actual_kind: string | null;
  kind_correct: boolean;
  expected_target: { title: string; type: TargetType };
  /** Titles of `about` targets persisted as edges (resolved to a stored node). */
  about_targets: string[];
  /** Reasons of `edge_dropped` diagnostics captured during this statement's backfill pass. */
  about_dropped: string[];
  about_proposed: boolean;
  about_correct: boolean;
  error?: string;
  /** Backfill typed a different fact than this statement's (alignment guard). */
  misaligned?: true;
}

export interface KindAccuracy { total: number; correct: number; accuracy: number }

export interface StatementKindsReport {
  kind: 'statement-kinds';
  createdAt: string;
  model: string;
  engine: { version: string; gitSha: string; gitDescribe?: string };
  total: number;
  overall: KindAccuracy;
  perKind: Record<StatementKind, KindAccuracy>;
  aboutRate: {
    /** Statements with at least one resolved `about` edge. */
    proposed: number;
    /** Statements whose expected target exists as a seed (all of them). */
    resolvable: number;
    /** Statements with an `about` edge to the expected target. */
    correctTarget: number;
  };
  results: StatementRow[];
}

function ratio(correct: number, total: number): KindAccuracy {
  return { total, correct, accuracy: total === 0 ? 0 : correct / total };
}

export interface RunStatementKindsOpts {
  entries: StatementFixtureEntry[];
  endpoint: ChatEndpoint;
  fetchImpl?: FetchLike;
  /** Collected once per run by the caller and reused for the report's engine block. */
  engine: Awaited<ReturnType<typeof engineInfo>>;
}

export async function runStatementKinds(opts: RunStatementKindsOpts): Promise<StatementKindsReport> {
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const provider = createProvider(opts.endpoint, fetchImpl);
  const engine = opts.engine;
  const handle = openDb(); // in-memory, never a host database
  try {
    const llmProvider: LLMProvider = { generateText: (p) => provider.generateText(p) };
    let dropped: string[] = [];
    const wiki = new WikiMemory(handle.adapter, {
      llmProvider,
      onDiagnostic: (d) => {
        if (d.code === 'edge_dropped') dropped.push(d.detail?.reason ?? 'unknown');
      },
      config: {
        librarian: { strategy: 'ops' },
        maintenance: 'deferred',
        ontology: { seedManifests: { [ENTITY]: { manifest: schemaSoftwareOrgManifest, mode: 'strict' } } },
      },
    });
    await wiki.setup();

    const seedIds = new Map<string, string>();
    for (const s of SEED_NODES) {
      const f = await wiki.remember(ENTITY, { title: s.title, body: s.body, okf_type: s.type });
      seedIds.set(f.id, `${s.type}:${s.title}`);
    }

    const rows: StatementRow[] = [];
    for (const e of opts.entries) {
      const base = { text: e.text, expected_kind: e.expected_kind, expected_target: e.expected_target };
      let createdId: string | undefined;
      try {
        const fact = await wiki.remember(ENTITY, { title: e.text.slice(0, 80), body: e.text });
        createdId = fact.id;
        // One fact per pass so each call classifies exactly this statement.
        dropped = [];
        const bf = await wiki.runOntologyBackfill(ENTITY, { classifier: 'llm', batchSize: 1 });
        const hood = await wiki.traverseGraph(ENTITY, { sourceId: fact.id, direction: 'outbound', maxDepth: 1, edgeTypes: ['about'] });
        const anchor = hood.nodes.find((n) => n.id === fact.id);
        const targets = hood.edges
          .filter((x) => x.source_id === fact.id && x.edge_type === 'about')
          .map((x) => {
            const n = hood.nodes.find((m) => m.id === x.target_id);
            return seedIds.get(x.target_id) ?? (n ? `${n.okf_type ?? 'untyped'}:${n.title}` : x.target_id);
          });
        const want = `${e.expected_target.type}:${e.expected_target.title}`;
        const actual = anchor?.okf_type ?? null;
        // Alignment guard: the pass typed something, but not this statement's fact.
        const misaligned = bf.typed > 0 && actual === null;
        // Untyped after the pass (engine skipped it, or typed another fact):
        // drop it so a later row's batchSize:1 backfill cannot pick it up.
        if (actual === null) await wiki.forget(ENTITY, { entryId: fact.id });
        rows.push({
          ...base,
          actual_kind: actual,
          kind_correct: actual === e.expected_kind,
          about_targets: targets,
          about_dropped: [...dropped],
          about_proposed: targets.length > 0,
          about_correct: targets.includes(want),
          ...(misaligned ? { misaligned: true as const } : {}),
        });
      } catch (err) {
        // Delete the leftover untyped fact so it cannot be picked up by a later
        // row's batchSize:1 backfill and poison that row.
        if (createdId !== undefined) {
          try {
            await wiki.forget(ENTITY, { entryId: createdId });
          } catch { /* best effort; the row below still records the error */ }
        }
        // One bad statement must not discard the paid-for rest of the run.
        rows.push({ ...base, actual_kind: null, kind_correct: false, about_targets: [], about_dropped: [], about_proposed: false, about_correct: false, error: err instanceof Error ? err.message : String(err) });
      }
    }

    const perKind = {} as Record<StatementKind, KindAccuracy>;
    for (const k of STATEMENT_KINDS) {
      const of = rows.filter((r) => r.expected_kind === k);
      perKind[k] = ratio(of.filter((r) => r.kind_correct).length, of.length);
    }
    return {
      kind: 'statement-kinds',
      createdAt: new Date().toISOString(),
      model: opts.endpoint.model,
      engine: { version: engine.version, gitSha: engine.gitSha, gitDescribe: engine.gitDescribe },
      total: rows.length,
      overall: ratio(rows.filter((r) => r.kind_correct).length, rows.length),
      perKind,
      aboutRate: {
        proposed: rows.filter((r) => r.about_proposed).length,
        resolvable: rows.length,
        correctTarget: rows.filter((r) => r.about_correct).length,
      },
      results: rows,
    };
  } finally {
    handle.close();
  }
}

/** One-screen human summary. */
export function renderStatementKindsSummary(r: StatementKindsReport): string {
  const pct = (a: KindAccuracy) => `${a.correct}/${a.total} (${(a.accuracy * 100).toFixed(0)}%)`;
  return [
    `model: ${r.model}`,
    `at: ${r.createdAt}`,
    `overall kind accuracy: ${pct(r.overall)}`,
    ...STATEMENT_KINDS.map((k) => `  ${k}: ${pct(r.perKind[k])}`),
    `about edge: proposed ${r.aboutRate.proposed}/${r.aboutRate.resolvable}, correct target ${r.aboutRate.correctTarget}/${r.aboutRate.resolvable}`,
    '',
  ].join('\n');
}

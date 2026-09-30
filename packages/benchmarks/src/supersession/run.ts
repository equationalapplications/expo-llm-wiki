/**
 * Live supersession runner.
 *
 * `runSupersession` walks every scenario in a shared fixture, builds a fresh
 * in-memory wiki, seeds the existing facts, replays the events, and lets the
 * engine reconcile. Per spec §10.15, the same fixture
 * (`fixtures/supersession/scenarios.json`) feeds this runner and PR-B's
 * `supersessionReplay.test.ts`; only `existing`, `events`, and the
 * expectations matter to the live runner — `extract` and `resolve` are the
 * canned responses PR-B feeds into the ops strategy in replay mode.
 *
 * Pass criterion (per Task 8 brief):
 *   - Every `expectCurrentTitles` entry is matched (case-insensitive
 *     contains) by some current fact's title. Models paraphrase, so the
 *     match is intentionally fuzzy.
 *   - No `expectSuperseded` id is still in the current read.
 *
 * Scenarios flagged `liveSkip` are skipped: the live runner cannot force the
 * ops strategy to emit a model-misbehaviour response (those scenarios only
 * make sense in replay mode where PR-B's harness serves canned LLM
 * responses). PR-B's replay suite covers them.
 *
 * Two-run scenarios (`secondRunFrom`) split `events` into two halves. The
 * first half is written, the librarian (and heal) runs, the second half is
 * written, the librarian (and heal) runs again, then expectations are
 * checked. This mirrors PR-B's "second run after the first supersedes"
 * pattern.
 *
 * Engine version + git SHA surface in the report the same way the
 * LongMemEval report does, so a downstream reader can pin a run to its
 * commit.
 */

import { WikiMemory } from '@equationalapplications/core-llm-wiki';
import type { SQLiteAdapter, LLMProvider } from '@equationalapplications/core-llm-wiki';

import { openDb, OpenDbResult } from '../db';
import { ChatEndpoint, createProvider } from '../provider';
import { engineInfo } from '../report';

type EmbedFn = (text: string) => Promise<number[]>;
type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<Response>;

export type ScenarioSourceType = 'user_stated' | 'librarian_inferred' | 'user_confirmed' | 'immutable_document';

export interface ScenarioExistingFact {
  id: string;
  title: string;
  body: string;
  source_type: ScenarioSourceType;
}

export interface ScenarioEvent {
  summary: string;
  occurred_at?: number;
}

export interface Scenario {
  name: string;
  note?: string;
  existing: ScenarioExistingFact[];
  events: ScenarioEvent[];
  /** Replay-only (PR-B): the ops extract response. Live mode ignores it. */
  extract: { facts: Array<Record<string, unknown>>; tasks: unknown[] };
  /** Replay-only (PR-B): the ops resolve response, or null when the gate decides alone. */
  resolve: { ops: Array<Record<string, unknown>> } | null;
  expectCurrentTitles: string[];
  expectSuperseded: string[];
  expectDiagnostics?: string[];
  /** Two-run scenarios (3, 28): events[0..n) feed the first librarian run, events[n..] the second. */
  secondRunFrom?: number;
  /** Live mode skips scenarios that need a misbehaving model (21–25). */
  liveSkip?: boolean;
}

export interface RunSupersessionOpts {
  scenarios: Scenario[];
  strategy: 'legacy' | 'ops';
  endpoint: ChatEndpoint;
  fetchImpl?: FetchLike;
  embed: EmbedFn;
}

export interface SupersessionResultRow {
  name: string;
  pass: boolean;
  currentTitles: string[];
  /** Populated when the scenario threw during setup, replay, or evaluate. */
  error?: string;
}

export interface SupersessionReport {
  kind: 'supersession';
  createdAt: string;
  strategy: 'legacy' | 'ops';
  engine: { version: string; gitSha: string; flags: { strategy: 'legacy' | 'ops' } };
  passed: number;
  total: number;
  skipped: number;
  results: SupersessionResultRow[];
}

const ENTITY = 'bench-user';

/** ISO timestamp for the report. */
function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Insert a single `existing` fact by raw SQL. We bypass the repo so the
 * fixtures can pin deterministic ids (`seattle`, `seattle_old`, etc.) without
 * re-minting them via `generateId('fact_')`. `created_at` is anchored at
 * `Date.UTC(2020, 0, 1)` so a candidate that defaults its `valid_from` from
 * the event's `occurred_at` (always later) cleanly supersedes the row.
 */
const EXISTING_CREATED_AT = Date.UTC(2020, 0, 1);

async function insertExistingFacts(adapter: SQLiteAdapter, facts: ScenarioExistingFact[]): Promise<void> {
  for (const f of facts) {
    await adapter.runAsync(
      `INSERT INTO llm_wiki_entries
         (id, entity_id, title, body, tags, source_type, confidence,
          created_at, updated_at, access_count, lifecycle_status)
       VALUES (?, ?, ?, ?, '[]', ?, 'certain', ?, ?, 0, 'stable')`,
      [f.id, ENTITY, f.title, f.body, f.source_type, EXISTING_CREATED_AT, EXISTING_CREATED_AT],
    );
  }
}

/**
 * Write the scenario's events as `observation` rows. `created_at` is taken
 * from the event's `occurred_at` (defaulting to `Date.now()` plus an index
 * offset so two events with no `occurred_at` still sort deterministically).
 *
 * 7.7.7's `llm_wiki_events` schema has no `occurred_at` column; events are
 * stored in chronological order by `created_at`. PR-A adds the column via
 * migration 13 — feature-detected in the ingest path (see T4) but not
 * surfaced here. The `occurred_at` field on the scenario is purely for the
 * PR-B replay path and is recorded here only via `created_at`.
 */
async function writeScenarioEvents(adapter: SQLiteAdapter, events: ScenarioEvent[], idOffset = 0): Promise<void> {
  const now = Date.now();
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    // `idOffset` lets a two-run scenario pass `second.length` so the second
    // half's event ids continue from where the first half stopped —
    // otherwise `evt_1` collides between halves.
    const eventId = `evt_${idOffset + i + 1}`;
    const createdAt = ev.occurred_at ?? now + idOffset + i;
    await adapter.runAsync(
      `INSERT INTO llm_wiki_events (id, entity_id, event_type, summary, created_at)
       VALUES (?, ?, 'observation', ?, ?)`,
      [eventId, ENTITY, ev.summary, createdAt],
    );
  }
}

/**
 * Pass criterion:
 *   1. Every `expectCurrentTitles` substring is matched (case-insensitive
 *      contains) by at least one current fact's title.
 *   2. No `expectSuperseded` id is present in the current read.
 */
function evaluateScenario(scenario: Scenario, current: { id: string; title: string }[]): { pass: boolean; currentTitles: string[] } {
  const currentTitles = current.map((f) => f.title);
  const currentIds = new Set(current.map((f) => f.id));
  const lowered = currentTitles.map((t) => t.toLowerCase());

  const allTitlesCovered = scenario.expectCurrentTitles.every((needle) => {
    const n = needle.toLowerCase();
    return lowered.some((t) => t.includes(n));
  });
  const noneSupersededRemain = scenario.expectSuperseded.every((id) => !currentIds.has(id));

  return {
    pass: allTitlesCovered && noneSupersededRemain,
    currentTitles,
  };
}

/**
 * Read every current fact's `(id, title)`. We read with `maxResults: 0`
 * bypassed by passing a sufficiently large value — `WikiMemory.read` always
 * applies a `maxResults` cut. A query of `''` returns the corpus sorted by
 * the default order; that order does not matter for the pass criterion.
 */
async function readCurrentFacts(wiki: WikiMemory): Promise<Array<{ id: string; title: string }>> {
  const bundle = await wiki.read(ENTITY, '', { maxResults: 1000 } as any);
  return bundle.facts.map((f) => ({ id: f.id, title: f.title }));
}

interface RunOneOpts {
  scenario: Scenario;
  flags: { strategy: 'legacy' | 'ops' };
  endpoint: ChatEndpoint;
  fetchImpl: FetchLike;
  embed: EmbedFn;
}

async function runOneScenario({ scenario, flags, endpoint, fetchImpl, embed }: RunOneOpts): Promise<SupersessionResultRow> {
  // Build the LLM provider from the caller's `endpoint` (defaults to Z.AI's
  // Anthropic-compatible endpoint). The live runner resolves this in `cli.ts`
  // from `endpointFromEnv('BENCH')`; the test harness passes a fake
  // `ChatEndpoint` whose baseUrl is something other than the production URL
  // so a regression that hard-codes the URL would fail the test.
  const provider = createProvider(endpoint, fetchImpl);

  const handle: OpenDbResult = openDb();
  try {
    const adapter = handle.adapter;
    const llmProvider: LLMProvider = {
      generateText: (p) => provider.generateText(p),
      embed,
    };

    const config = flags.strategy === 'ops'
      ? { librarian: { strategy: 'ops' as const } }
      : { autoLibrarianThreshold: 20 };

    const wiki = new WikiMemory(adapter, { llmProvider, config });
    await wiki.setup();

    await insertExistingFacts(adapter, scenario.existing);
    await wiki.runReembed(ENTITY);

    const secondRunFrom = scenario.secondRunFrom ?? scenario.events.length;
    const first = scenario.events.slice(0, secondRunFrom);
    const second = scenario.events.slice(secondRunFrom);

    await writeScenarioEvents(adapter, first);
    await wiki.runLibrarian(ENTITY);
    if (flags.strategy === 'legacy') {
      await wiki.runHeal(ENTITY);
    }

    if (second.length > 0) {
      await writeScenarioEvents(adapter, second, first.length);
      await wiki.runLibrarian(ENTITY);
      if (flags.strategy === 'legacy') {
        await wiki.runHeal(ENTITY);
      }
    }

    const current = await readCurrentFacts(wiki);
    const { pass, currentTitles } = evaluateScenario(scenario, current);
    return { name: scenario.name, pass, currentTitles };
  } finally {
    handle.close();
  }
}

/**
 * Run the full supersession suite against the supplied scenarios.
 *
 * `liveSkip` scenarios are silently skipped: live mode cannot force the ops
 * librarian to emit a malformed response (those scenarios are tested in
 * PR-B's replay suite). The report still records the skipped count via
 * `total` so a downstream reader knows the suite ran to completion.
 */
export async function runSupersession(opts: RunSupersessionOpts): Promise<SupersessionReport> {
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const engine = await engineInfo();
  const flags = { strategy: opts.strategy };

  const rows: SupersessionResultRow[] = [];
  let skipped = 0;
  for (const scenario of opts.scenarios) {
    if (scenario.liveSkip) {
      skipped += 1;
      continue;
    }
    // A single bad scenario must not abort the entire suite — every scenario
    // costs at least one in-flight LLM call and a $5+ rerun would be the
    // difference between "one row failed" and "no data at all". Catch the
    // throw, mark the row as failed with the message, and continue.
    try {
      const row = await runOneScenario({
        scenario,
        flags,
        endpoint: opts.endpoint,
        fetchImpl,
        embed: opts.embed,
      });
      rows.push(row);
    } catch (e) {
      rows.push({
        name: scenario.name,
        pass: false,
        currentTitles: [],
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const passed = rows.filter((r) => r.pass).length;

  return {
    kind: 'supersession',
    createdAt: nowIso(),
    strategy: flags.strategy,
    engine: {
      version: engine.version,
      gitSha: engine.gitSha,
      flags,
    },
    passed,
    total: rows.length,
    skipped,
    results: rows,
  };
}
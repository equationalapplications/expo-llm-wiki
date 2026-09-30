import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { ofCode } from './helpers/diagnosticsHarness';
import type { WikiDiagnostic } from '../src/types';

/**
 * Supersession replay: runs all 30 PR-0 scenarios against the real ops
 * librarian (extract → gate → resolve) with a mocked `generateText` that
 * replays each scenario's recorded responses.
 *
 * Embedder: fixed 16-dim bag-of-keywords so every cosine is deterministic.
 * Gate config: `novelThreshold: 0` — with this embedder, a relocation pair
 * ("Seattle" vs "San Francisco") sits on disjoint keyword dims and would
 * cosine to 0, which the default threshold (0.55) reads as novel and gates
 * to ADD before the resolver ever sees it. Zeroing the floor means every
 * candidate with live neighbours that is not an outright duplicate is
 * resolved by the recorded ops — exactly what the fixture's `resolve` JSON
 * assumes. Duplicate detection (cos ≥ dupThreshold + title Jaccard) is
 * untouched, so gate-NOOP scenarios still bypass the resolver.
 *
 * Title assertions use PR-0's live-runner containment semantics (every
 * expected title appears as a substring of some current fact title,
 * case-insensitive) because expected titles are salient labels
 * ("San Francisco"), not full stored titles ("User lives in San
 * Francisco"). Removals are asserted exactly via `expectSuperseded`
 * (superseded_by must be non-null).
 */

const ENTITY = 'u';

const KEYWORDS = [
  'seattle',
  'san francisco',
  'portland',
  'vegan',
  'keto',
  'engineer',
  'manager',
  'acme',
  'globex',
  'married',
  'single',
  'tea',
  'coffee',
  'cat',
  'dog',
  'project',
] as const;

const embed = async (text: string) => {
  const lower = text.toLowerCase();
  return KEYWORDS.map((keyword) => (lower.includes(keyword) ? 1 : 0));
};

interface ScenarioExisting {
  id: string;
  title: string;
  body: string;
  source_type: string;
}

interface Scenario {
  name: string;
  note?: string;
  existing: ScenarioExisting[];
  events: Array<{ summary: string; occurred_at?: number }>;
  extract: { facts: Array<Record<string, unknown>>; tasks: unknown[] };
  resolve: { ops: Array<Record<string, unknown>> } | null;
  expectCurrentTitles: string[];
  expectSuperseded: string[];
  expectDiagnostics?: string[];
  secondRunFrom?: number;
  liveSkip?: boolean;
}

const scenarios: Scenario[] = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../benchmarks/fixtures/supersession/scenarios.json'), 'utf8'),
);

describe('supersession replay against the ops librarian', () => {
  it.each(scenarios)('$name', async (sc) => {
    // LLM call plan: one extract per librarian run, one resolve per run when
    // the scenario records one. The plan is an upper bound — a run whose gate
    // NOOPs every candidate legitimately skips the resolver — but a call
    // beyond the plan fails the scenario (misbehaving-replay guard).
    const runs = sc.secondRunFrom === undefined ? 1 : 2;
    const plan: string[] = [];
    for (let r = 0; r < runs; r++) {
      plan.push(JSON.stringify(sc.extract));
      if (sc.resolve !== null) plan.push(JSON.stringify(sc.resolve));
    }

    const db = openTestDatabase();
    const diagnostics: WikiDiagnostic[] = [];
    let planCallCount = 0;
    const generateText = vi.fn(async () => {
      const callIndex = planCallCount++;
      if (callIndex >= plan.length) {
        throw new Error(`[${sc.name}] unexpected LLM call #${callIndex + 1}; replay plan has ${plan.length}`);
      }
      return plan[callIndex];
    });

    const wiki = new WikiMemory(db, {
      llmProvider: { generateText, embed },
      config: {
        autoLibrarianThreshold: 1000,
        librarian: { strategy: 'ops', gate: { novelThreshold: 0 } },
      },
      onDiagnostic: (d) => diagnostics.push(d),
    });
    await wiki.setup();

    for (const f of sc.existing) {
      await db.runAsync(
        `INSERT INTO llm_wiki_entries (id, entity_id, title, body, source_type, confidence, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'certain', 1, 1)`,
        [f.id, ENTITY, f.title, f.body, f.source_type],
      );
    }
    await wiki.runReembed();
    await (wiki.__testAccess.searchService as any).sync();

    const insertEvents = async (from: number, to: number) => {
      for (let i = from; i < to; i++) {
        const e = sc.events[i];
        await db.runAsync(
          `INSERT INTO llm_wiki_events (id, entity_id, event_type, summary, created_at, occurred_at)
           VALUES (?, ?, 'observation', ?, ?, ?)`,
          [`evt_${i + 1}`, ENTITY, e.summary, 1000 + i, e.occurred_at ?? 1000 + i],
        );
      }
    };

    // Two-run scenarios: the librarian runs after each half of the events so
    // the second pass sees the first pass's writes as current state.
    const split = sc.secondRunFrom ?? sc.events.length;
    await insertEvents(0, split);
    await wiki.runLibrarian(ENTITY);
    if (runs === 2) {
      await insertEvents(split, sc.events.length);
      await wiki.runLibrarian(ENTITY);
    }

    // No call beyond the plan; when the scenario records no resolve, the gate
    // must decide alone (exactly one extract per run, nothing else).
    expect(generateText.mock.calls.length).toBeLessThanOrEqual(plan.length);
    if (sc.resolve === null) expect(generateText).toHaveBeenCalledTimes(runs);
    if (sc.name === 'mixed-1-three-candidates-noop-add-supersede') {
      // The fixture's note pins this scenario to exactly two calls.
      expect(generateText).toHaveBeenCalledTimes(2);
    }

    // Current titles: every expected title must appear (case-insensitive
    // substring) in a current fact's title.
    const titles = (await wiki.read(ENTITY, '')).facts.map((f) => f.title);
    for (const expected of sc.expectCurrentTitles) {
      expect(
        titles.some((t) => t.toLowerCase().includes(expected.toLowerCase())),
      ).toBe(true);
    }

    // Every expected-superseded id must actually be superseded.
    for (const id of sc.expectSuperseded) {
      const row = await db.getFirstAsync<{ superseded_by: string | null }>(
        `SELECT superseded_by FROM llm_wiki_entries WHERE id = ?`,
        [id],
      );
      expect(row, `[${sc.name}] existing fact "${id}" not found`).toBeDefined();
      expect(row?.superseded_by).not.toBeNull();
    }

    // Every expected diagnostic code must have been emitted.
    for (const code of sc.expectDiagnostics ?? []) {
      expect(ofCode(diagnostics, code as WikiDiagnostic['code']).length).toBeGreaterThan(0);
    }

    // Temporal anchoring, on the two scenarios that exist to prove it: the
    // replacement's valid_from comes from the event's occurred_at when the
    // extract supplies none, and from the extract when it does.
    if (sc.name === 'mixed-4-event-occurred_at-drives-valid_from' || sc.name === 'mixed-5-extract-valid_from-overrides-occurred_at') {
      const old = await db.getFirstAsync<{ superseded_by: string | null }>(
        `SELECT superseded_by FROM llm_wiki_entries WHERE id = ?`,
        [sc.expectSuperseded[0]],
      );
      const replacement = await db.getFirstAsync<{ valid_from: number | null }>(
        `SELECT valid_from FROM llm_wiki_entries WHERE id = ?`,
        [old?.superseded_by ?? ''],
      );
      const expectedValidFrom =
        sc.name === 'mixed-4-event-occurred_at-drives-valid_from' ? 1730000000000 : 1577836800000;
      expect(replacement?.valid_from).toBe(expectedValidFrom);
    }
  });
});

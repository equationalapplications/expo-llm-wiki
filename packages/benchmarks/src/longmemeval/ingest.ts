/**
 * LongMemEval replay ingestion.
 *
 * Replays a question's `haystack_sessions` into a file-backed SQLite database
 * (`${cacheDir}/ingest/${engineVersion}/${flagsKey(flags)}/${question_id}.sqlite`),
 * runs the engine's maintenance to quiescence so every event has been processed
 * (legacy auto-mode or PR-C's deferred mode), then writes
 * `bench_ingest_complete = '1'` into `llm_wiki_meta` and closes the file.
 *
 * The cache makes re-judging cheap: a second call with the same
 * `(engineVersion, flags)` opens the existing file and returns
 * `{ cached: true }` without invoking the provider or the embedder.
 *
 * The engine-version + flags tuple is the cache key. `7.7.7` is the base core
 * PR-0 targets; the module feature-detects newer shapes via:
 *   - `supportsOccurredAt`: `PRAGMA table_info(llm_wiki_events)` contains `occurred_at`
 *     (added by PR-A's migration 13; absent on 7.7.7 ⇒ events are replayed
 *     without `occurred_at`).
 *   - `runPendingMaintenance` / `getPendingMaintenance`: present in the linked
 *     `WikiMemory` types (PR-C added them to core), but the engine the cache
 *     file was built with may predate PR-C. Calling `ingestQuestion` with
 *     `flags.maintenance === 'deferred'` against a 7.7.7 engine throws via a
 *     runtime `typeof` probe; this is deliberate — deferred mode is opt-in
 *     and the baselines must be measured on the legacy-auto maintenance path.
 */

import { mkdirSync, rmSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { WikiMemory } from '@equationalapplications/core-llm-wiki';
import type { SQLiteAdapter, LLMProvider, EntityStatus } from '@equationalapplications/core-llm-wiki';
import { openDb, OpenDbResult } from '../db';
import { parseLmeDate, LmeQuestion } from './dataset';

export interface EngineFlags {
  strategy: 'legacy' | 'ops';
  maintenance: 'auto' | 'deferred';
  readTokenBudget?: number;
}

/**
 * Stable, file-system-safe key for an {@link EngineFlags} triple.
 *
 * Examples:
 *   `{ strategy: 'legacy', maintenance: 'auto' }`                       ⇒ `"legacy-auto"`
 *   `{ strategy: 'ops', maintenance: 'deferred' }`                      ⇒ `"ops-deferred"`
 *   `{ strategy: 'ops', maintenance: 'deferred', readTokenBudget: 800 }` ⇒ `"ops-deferred-b800"`
 *
 * A `readTokenBudget` of `0` is treated as "no budget" — budgets are
 * positive integers in practice.
 */
export function flagsKey(f: EngineFlags): string {
  const budget = f.readTokenBudget ? `-b${f.readTokenBudget}` : '';
  return `${f.strategy}-${f.maintenance}${budget}`;
}

export interface IngestOpts {
  flags: EngineFlags;
  provider: { generateText: (p: { systemPrompt: string; userPrompt: string }) => Promise<string> };
  embed: (t: string) => Promise<number[]>;
  cacheDir: string;
  engineVersion: string;
}

export interface IngestResult {
  dbFile: string;
  cached: boolean;
  ingestMs: number;
}

const ENTITY = 'lme-user';

/** Poll cadence (ms) for {@link waitIdle}. */
const IDLE_POLL_MS = 50;
/**
 * Hard ceiling (ms) for {@link waitIdle}.
 *
 * One full auto-heal pass legitimately takes longer than ten minutes against
 * a flash-tier model: at the `autoHealThreshold` boundary (default 100) a
 * pass offers up to `HEAL_BATCH_SIZE` (25) candidates and every candidate
 * whose response fails to parse is retried as a singleton batch, each a
 * full LLM call. Both smoke runs stalled at exactly event 100 — the heal
 * boundary — with the ingest DB showing the librarian fully caught up, so
 * the budget has to cover a complete heal pass, not just a librarian call.
 */
const IDLE_TIMEOUT_MS = 60 * 60 * 1000;
/** Safety cap for the deferred-maintenance loop. */
const DEFERRED_MAX_ITERATIONS = 200;

/**
 * Resolve the per-question cache file path. `readTokenBudget` is a
 * read-side flag, so it is left out of the key: a budget sweep reuses one
 * ingest instead of re-ingesting every question per budget value.
 */
export function cacheFilePath(cacheDir: string, engineVersion: string, flags: EngineFlags, questionId: string): string {
  const ingestKey = flagsKey({ strategy: flags.strategy, maintenance: flags.maintenance });
  return join(cacheDir, 'ingest', engineVersion, ingestKey, `${questionId}.sqlite`);
}

interface WikiMemoryWithDeferred {
  runPendingMaintenance?: () => Promise<unknown>;
  getPendingMaintenance?: () => Promise<unknown[]>;
}

/**
 * Poll `wiki.getEntityStatus(ENTITY)` until both `librarian` and `heal` are
 * false. Throws after {@link IDLE_TIMEOUT_MS} ms.
 *
 * `ingesting` is intentionally ignored — replay does not run the ingest job,
 * so any ingest activity is from a different concurrent caller and is not our
 * concern.
 */
async function waitIdle(wiki: WikiMemory): Promise<void> {
  const deadline = Date.now() + IDLE_TIMEOUT_MS;
  for (;;) {
    const status: EntityStatus = wiki.getEntityStatus(ENTITY);
    if (!status.librarian && !status.heal) return;
    if (Date.now() > deadline) {
      throw new Error(`waitIdle: maintenance did not quiesce within ${IDLE_TIMEOUT_MS} ms for entity "${ENTITY}"`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, IDLE_POLL_MS));
  }
}

/**
 * Feature-detect `occurred_at` on `llm_wiki_events`. Newer cores add the
 * column in migration 13; `7.7.7` does not have it.
 */
async function detectSupportsOccurredAt(adapter: SQLiteAdapter): Promise<boolean> {
  const rows = await adapter.getAllAsync<{ name: string }>(
    "PRAGMA table_info(llm_wiki_events)",
  );
  return rows.some((row) => row.name === 'occurred_at');
}

/**
 * Ingest one LongMemEval question: replay its haystack sessions, run
 * maintenance to quiescence, then mark the cache file complete.
 *
 * See module docblock for the cache layout and the `7.7.7` feature-detection
 * notes.
 */
export async function ingestQuestion(q: LmeQuestion, opts: IngestOpts): Promise<IngestResult> {
  const dbFile = cacheFilePath(opts.cacheDir, opts.engineVersion, opts.flags, q.question_id);

  // Fast path: an existing complete cache file short-circuits everything.
  if (existsSync(dbFile)) {
    const probe = openDb(dbFile);
    try {
      const row = await probe.adapter.getFirstAsync<{ value: string }>(
        "SELECT value FROM llm_wiki_meta WHERE key = 'bench_ingest_complete'",
      );
      if (row?.value === '1') {
        return { dbFile, cached: true, ingestMs: 0 };
      }
    } finally {
      probe.close();
    }
    // Stale or partial — fall through to the rebuild path.
  }

  // Wipe any partial file before rebuilding so the new DB starts on a clean
  // slate (and no WAL/SHM siblings from a prior attempt linger).
  rmSync(dbFile, { force: true });
  for (const suffix of ['-wal', '-shm']) {
    rmSync(`${dbFile}${suffix}`, { force: true });
  }
  mkdirSync(dirname(dbFile), { recursive: true });

  const started = Date.now();
  const handle: OpenDbResult = openDb(dbFile);
  const { adapter } = handle;
  try {
    const llmProvider: LLMProvider = {
      ...opts.provider,
      embed: opts.embed,
    };

    const config = opts.flags.strategy === 'ops'
      ? {
          librarian: { strategy: 'ops' as const },
          maintenance: opts.flags.maintenance,
        }
      : {
          // Legacy auto-mode — the 7.x default behaviour, stated explicitly so
          // a future default flip in core does not silently change the baseline.
          autoLibrarianThreshold: 20,
        };

    const wiki = new WikiMemory(adapter, { llmProvider, config });
    await wiki.setup();

    // Sort session indices by their parsed haystack date ascending so the
    // replay preserves temporal order even when the source array is not sorted.
    const ordered = q.haystack_sessions
      .map((_, s) => s)
      .sort((a, b) => parseLmeDate(q.haystack_dates[a]) - parseLmeDate(q.haystack_dates[b]));

    const supportsOccurredAt = await detectSupportsOccurredAt(adapter);

    if (opts.flags.maintenance === 'deferred') {
      // Deferred path is only valid when the engine ships the deferred
      // maintenance API (PR-C and later). 7.7.7 does not — fail loudly so a
      // misconfigured baseline cannot silently fall back to legacy-auto. The
      // runtime `typeof` probe still matters even though the linked WikiMemory
      // type now declares both methods: the engine version this cache file
      // was built against may predate PR-C.
      const w = wiki as unknown as WikiMemoryWithDeferred;
      if (typeof w.runPendingMaintenance !== 'function' || typeof w.getPendingMaintenance !== 'function') {
        throw new Error('engine does not support deferred mode');
      }
      for (const s of ordered) {
        for (const turn of q.haystack_sessions[s]) {
          const baseEvent = {
            event_type: 'observation' as const,
            summary: `${turn.role}: ${turn.content}`,
          };
          await wiki.write(ENTITY, {
            ...baseEvent,
            ...(supportsOccurredAt ? { occurred_at: parseLmeDate(q.haystack_dates[s]) } : {}),
          } as any);
        }
      }
      // Never write the completion sentinel over an unfinished memory state:
      // the cache fast path would reuse it on every later run.
      let quiesced = false;
      for (let i = 0; i < DEFERRED_MAX_ITERATIONS; i++) {
        await w.runPendingMaintenance();
        const pending = await w.getPendingMaintenance();
        if (!Array.isArray(pending) || pending.length === 0) {
          quiesced = true;
          break;
        }
      }
      if (!quiesced) {
        throw new Error(`deferred maintenance did not quiesce within ${DEFERRED_MAX_ITERATIONS} rounds for "${q.question_id}"`);
      }
    } else {
      // Legacy auto-mode — wait for quiescence after every write so a
      // backgrounded auto-librarian / auto-heal pass from a prior write has
      // finished before we add more events.
      for (const s of ordered) {
        for (const turn of q.haystack_sessions[s]) {
          const baseEvent = {
            event_type: 'observation' as const,
            summary: `${turn.role}: ${turn.content}`,
          };
          await wiki.write(ENTITY, {
            ...baseEvent,
            ...(supportsOccurredAt ? { occurred_at: parseLmeDate(q.haystack_dates[s]) } : {}),
          } as any);
          await waitIdle(wiki);
        }
      }

      // Tail call: if any events were written since the last auto-pump, run
      // the librarian one more time so the trailing batch is processed
      // before we close the file. The checkpoint lives in `llm_wiki_checkpoints`,
      // not `llm_wiki_meta` (the meta table only carries free-form key/value).
      const cpRows = await adapter.getAllAsync<{ memory_checkpoint: number }>(
        "SELECT memory_checkpoint FROM llm_wiki_checkpoints WHERE entity_id = ?",
        [ENTITY],
      );
      const memoryCheckpoint = cpRows[0]?.memory_checkpoint ?? 0;
      const eventCountRow = await adapter.getFirstAsync<{ cnt: number }>(
        "SELECT COUNT(*) AS cnt FROM llm_wiki_events WHERE entity_id = ?",
        [ENTITY],
      );
      const eventCount = eventCountRow?.cnt ?? 0;
      if (eventCount - memoryCheckpoint > 0) {
        await wiki.runLibrarian(ENTITY);
        await waitIdle(wiki);
      }
    }

    // Mark the cache file complete. The sentinel row is what the fast-path
    // probe at the top of this function looks for.
    await adapter.runAsync(
      "INSERT OR REPLACE INTO llm_wiki_meta (key, value) VALUES ('bench_ingest_complete','1')",
    );

    return {
      dbFile,
      cached: false,
      ingestMs: Date.now() - started,
    };
  } finally {
    handle.close();
  }
}
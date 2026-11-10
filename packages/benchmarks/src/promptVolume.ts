/**
 * Prompt-volume ledger runner (spec targeted-diagnostics §3).
 *
 * Replays a stream through one engine config under the determinism harness
 * with the scripted provider, and tallies calls and prompt characters per
 * call site. In-memory SQLite only; zero tokens.
 */
import { readFileSync } from 'fs';
import { WikiMemory } from '@equationalapplications/core-llm-wiki';
import { openDb } from './db';
import { withDeterminism } from './determinism';
import type { CallSite } from './instrument';
import { engineConfigFor, flagsKey } from './longmemeval/ingest';
import { createScriptedProvider, type StreamEvent } from './scriptedProvider';

export type { StreamEvent } from './scriptedProvider';

export interface VolumeConfig {
  strategy: 'legacy' | 'ops';
  maintenance: 'auto' | 'deferred';
}

export const CONFIGS: readonly VolumeConfig[] = [
  { strategy: 'legacy', maintenance: 'auto' },
  { strategy: 'legacy', maintenance: 'deferred' },
  { strategy: 'ops', maintenance: 'auto' },
  { strategy: 'ops', maintenance: 'deferred' },
];

export interface SiteVolume {
  calls: number;
  systemChars: number;
  userChars: number;
}

export interface VolumeRow {
  config: string;
  bySite: Partial<Record<CallSite, SiteVolume>>;
  rawEventChars: number;
  eventsSeen: number;
  promptLog: string;
}

export interface BaselineFile {
  note: string;
  rows: Array<Omit<VolumeRow, 'promptLog'>>;
}

const ENTITY = 'pv-user';
const IDLE_TIMEOUT_MS = 30_000;
const DRAIN_CAP = 50;

export function loadStream(path: string): StreamEvent[] {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { events?: unknown };
  if (!Array.isArray(raw.events)) throw new Error(`${path}: missing events array`);
  return raw.events.map((e: unknown, i: number) => {
    const ev = e as Partial<StreamEvent>;
    if (typeof ev.summary !== 'string') throw new Error(`${path}: event ${i} has no summary`);
    if (typeof ev.occurred_at !== 'number' || !Number.isFinite(ev.occurred_at)) {
      // Without it, ops extract prints created_at — the clock — into prompts.
      throw new Error(`${path}: event ${i} has no finite occurred_at`);
    }
    return { summary: ev.summary, occurred_at: ev.occurred_at };
  });
}

async function waitIdle(wiki: WikiMemory): Promise<void> {
  // Real-time budget: the determinism clock steps per read, so measure
  // iterations instead of Date.now().
  for (let i = 0; i < IDLE_TIMEOUT_MS / 5; i++) {
    const s = await wiki.getEntityStatus(ENTITY);
    if (!s.librarian && !s.heal) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('promptVolume: maintenance did not go idle');
}

export async function runPromptVolume(config: VolumeConfig, stream: readonly StreamEvent[]): Promise<VolumeRow> {
  return withDeterminism({ seed: 1 }, async () => {
    const { provider, log } = createScriptedProvider(stream);
    const handle = openDb();
    try {
      const wiki = new WikiMemory(handle.adapter, { llmProvider: provider, config: engineConfigFor(config) });
      await wiki.setup();
      for (const e of stream) {
        await wiki.write(ENTITY, { event_type: 'observation', summary: e.summary, occurred_at: e.occurred_at } as never);
        if (config.maintenance === 'auto') await waitIdle(wiki);
      }
      if (config.maintenance === 'deferred') {
        let drained = false;
        for (let i = 0; i < DRAIN_CAP; i++) {
          await wiki.runPendingMaintenance();
          const pending = await wiki.getPendingMaintenance();
          if (pending.length === 0) {
            drained = true;
            break;
          }
        }
        if (!drained) throw new Error(`promptVolume: ${flagsKey(config)} did not drain in ${DRAIN_CAP} rounds`);
      } else {
        // Tail pass, exactly as the LongMemEval ingest does: only when events
        // were written after the last auto pass's checkpoint.
        const cp = await handle.adapter.getFirstAsync<{ memory_checkpoint: number }>(
          'SELECT memory_checkpoint FROM llm_wiki_checkpoints WHERE entity_id = ?',
          [ENTITY],
        );
        if (stream.length - (cp?.memory_checkpoint ?? 0) > 0) {
          await wiki.runLibrarian(ENTITY);
          await waitIdle(wiki);
        }
      }
    } finally {
      handle.close();
    }

    const bySite: Partial<Record<CallSite, SiteVolume>> = {};
    for (const c of log) {
      const s = (bySite[c.site] ??= { calls: 0, systemChars: 0, userChars: 0 });
      s.calls += 1;
      s.systemChars += c.systemChars;
      s.userChars += c.userChars;
    }
    const librarianPrompts = log.filter((c) => c.site === 'extract' || c.site === 'librarian').map((c) => c.userPrompt);
    const eventsSeen = new Set(
      stream.filter((e) => librarianPrompts.some((p) => p.includes(e.summary))).map((e) => e.summary),
    ).size;
    return {
      config: flagsKey(config),
      bySite,
      rawEventChars: stream.reduce((a, e) => a + e.summary.length, 0),
      eventsSeen,
      promptLog: log.map((c) => `${c.site}\n${c.userPrompt}`).join('\n␞\n'),
    };
  });
}

const TOLERANCE = 1.1;

const total = (r: Pick<VolumeRow, 'bySite'>, k: keyof SiteVolume): number =>
  Object.values(r.bySite).reduce((a, s) => a + (s?.[k] ?? 0), 0);

/**
 * Violations: a rise of more than 10% over baseline in total user chars or
 * calls, or in any one call site's user chars or calls. Drops pass.
 *
 * An absolute extract-ratio cap (1.25, from long LongMemEval turns) was in
 * the first draft of the spec; on short events the per-line label and ISO
 * timestamp alone put ops extract near 1.6, so the per-site baseline check
 * replaces it (spec §3 revision, 2026-11-10).
 */
export function compareToBaseline(rows: readonly VolumeRow[], baseline: BaselineFile): string[] {
  const out: string[] = [];
  for (const r of rows) {
    const b = baseline.rows.find((x) => x.config === r.config);
    if (!b) {
      out.push(`${r.config}: no baseline row`);
      continue;
    }
    for (const k of ['userChars', 'calls'] as const) {
      const now = total(r, k);
      const was = total(b, k);
      if (now > was * TOLERANCE) out.push(`${r.config}: total ${k} ${now} > baseline ${was} +10%`);
      for (const [site, v] of Object.entries(r.bySite)) {
        const wasSite = b.bySite[site as CallSite]?.[k] ?? 0;
        if ((v?.[k] ?? 0) > wasSite * TOLERANCE) out.push(`${r.config}: ${site} ${k} ${v?.[k]} > baseline ${wasSite} +10%`);
      }
    }
  }
  return out;
}

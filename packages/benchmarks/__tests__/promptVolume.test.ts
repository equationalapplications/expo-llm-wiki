/**
 * Prompt-volume ledger (spec targeted-diagnostics §3).
 *
 * Replays a fixed 60-event stream through the four engine configs with a
 * scripted provider and tallies calls and prompt characters per call site.
 * Zero tokens, no network. Reports prompt volume, never billed tokens.
 *
 * Regenerate the baseline after a deliberate change:
 *   BENCH_UPDATE_BASELINE=1 pnpm --filter @equationalapplications/benchmarks-llm-wiki test __tests__/promptVolume.test.ts
 */
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import {
  CONFIGS,
  compareToBaseline,
  loadStream,
  runPromptVolume,
  type BaselineFile,
  type VolumeRow,
} from '../src/promptVolume';
import { engineInfo } from '../src/report';

const FIXTURES = join(__dirname, '..', 'fixtures', 'promptVolume');
const BASELINE_PATH = join(FIXTURES, 'baseline.json');

beforeAll(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('network blocked in diagnostics suite');
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
});

const stream = loadStream(join(FIXTURES, 'stream.json'));

describe('prompt-volume stream fixture', () => {
  it('has 60 events, each with a finite occurred_at', () => {
    expect(stream).toHaveLength(60);
    for (const e of stream) {
      expect(typeof e.summary).toBe('string');
      expect(Number.isFinite(e.occurred_at)).toBe(true);
    }
  });

  it('loadStream rejects an event without occurred_at', () => {
    const bad = join(__dirname, '..', '.cache', 'bad-stream.json');
    mkdirSync(join(__dirname, '..', '.cache'), { recursive: true });
    writeFileSync(bad, JSON.stringify({ events: [{ summary: 'x' }] }));
    expect(() => loadStream(bad)).toThrow(/occurred_at/);
  });
});

describe('prompt-volume ledger', () => {
  let rows: VolumeRow[] = [];

  beforeAll(async () => {
    rows = [];
    for (const config of CONFIGS) rows.push(await runPromptVolume(config, stream));
    const table = rows.map((r) => ({
      config: r.config,
      calls: Object.values(r.bySite).reduce((a, s) => a + s.calls, 0),
      userChars: Object.values(r.bySite).reduce((a, s) => a + s.userChars, 0),
      systemChars: Object.values(r.bySite).reduce((a, s) => a + s.systemChars, 0),
      ratio: (Object.values(r.bySite).reduce((a, s) => a + s.userChars, 0) / r.rawEventChars).toFixed(2),
      eventsSeen: r.eventsSeen,
    }));
    console.table(table);
    if (process.env.BENCH_UPDATE_BASELINE === '1') {
      const baseline: BaselineFile = {
        note: 'Prompt-volume baseline (spec targeted-diagnostics §3). Regenerate with BENCH_UPDATE_BASELINE=1 and say why in the commit.',
        rows: rows.map(({ promptLog: _p, stateDump: _s, ...rest }) => rest),
      };
      writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 1) + '\n');
    }
    if (process.env.BENCH_WRITE_RESULTS === '1') {
      const info = await engineInfo();
      const out = join(__dirname, '..', 'results', `prompt-volume-${info.gitDescribe}.json`);
      writeFileSync(out, JSON.stringify({ kind: 'prompt-volume', engine: info, rows: table }, null, 1) + '\n');
    }
  }, 120_000);

  it('runs all four configs and each librarian sees events', () => {
    expect(rows.map((r) => r.config)).toEqual(['legacy-auto', 'legacy-deferred', 'ops-auto', 'ops-deferred']);
    for (const r of rows) expect(r.eventsSeen).toBeGreaterThan(0);
  });

  it('volume stays within the committed baseline', () => {
    expect(existsSync(BASELINE_PATH)).toBe(true);
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as BaselineFile;
    expect(compareToBaseline(rows, baseline)).toEqual([]);
  });

  it('eventsSeen per config matches the baseline', () => {
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as BaselineFile;
    for (const r of rows) {
      const b = baseline.rows.find((x) => x.config === r.config)!;
      expect(r.eventsSeen, r.config).toBe(b.eventsSeen);
    }
  });

  it('final fact, event and checkpoint tables are byte-identical across replays (spec §1)', async () => {
    for (const config of CONFIGS) {
      const again = await runPromptVolume(config, stream);
      const first = rows.find((r) => r.config === again.config)!;
      expect(first.stateDump.length, config.strategy + config.maintenance).toBeGreaterThan(100);
      expect(again.stateDump === first.stateDump, again.config).toBe(true);
    }
  }, 120_000);

  it('replay is byte-stable', async () => {
    for (const config of [CONFIGS[0]!, CONFIGS[3]!]) {
      const again = await runPromptVolume(config, stream);
      const first = rows.find((r) => r.config === again.config)!;
      expect(again.promptLog === first.promptLog, again.config).toBe(true);
    }
  }, 120_000);
});

describe('compareToBaseline', () => {
  const row = (userChars: number, calls: number): VolumeRow => ({
    config: 'ops-deferred',
    bySite: { extract: { calls, systemChars: 0, userChars } } as VolumeRow['bySite'],
    rawEventChars: 1_000_000,
    eventsSeen: 1,
    promptLog: '',
    stateDump: '',
  });
  const baseline: BaselineFile = { note: '', rows: [{ ...row(1000, 10), promptLog: undefined } as never] };

  it('flags a rise above 10%', () => {
    expect(compareToBaseline([row(1110, 10)], baseline).some((m) => m.includes('total userChars'))).toBe(true);
  });

  it('ignores a drop', () => {
    expect(compareToBaseline([row(700, 7)], baseline)).toEqual([]);
  });

  it('flags a per-site rise even when the total holds', () => {
    const shifted: VolumeRow = {
      ...row(1000, 10),
      bySite: {
        extract: { calls: 5, systemChars: 0, userChars: 400 },
        resolve: { calls: 5, systemChars: 0, userChars: 600 },
      } as VolumeRow['bySite'],
    };
    const base: BaselineFile = {
      note: '',
      rows: [{ ...shifted, bySite: { extract: { calls: 5, systemChars: 0, userChars: 900 }, resolve: { calls: 5, systemChars: 0, userChars: 100 } } } as never],
    };
    expect(compareToBaseline([shifted], base).some((m) => m.includes('resolve'))).toBe(true);
  });
});

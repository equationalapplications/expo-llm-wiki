/**
 * Build `fixtures/gate/embeddings.json.gz` (spec targeted-diagnostics §4).
 *
 * Runs the gate path once per scenario with a recording embed, so the sidecar
 * keys are exactly the strings core's `embedTextForFact` sends, after
 * clamping. Adds calibrate's own strings, then embeds everything with local
 * fastembed BGE-small. Zero tokens. Run by hand, never in CI:
 *
 *   pnpm --filter @equationalapplications/benchmarks-llm-wiki fixture:gate-embeddings
 */
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { gzipSync } from 'zlib';
import { getEmbedder } from '../embed';
import type { Scenario } from '../supersession/run';
import { calibrateTexts, decisionLog, SIDECAR_PATH, type SidecarFile } from './decisionLog';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function collectEmbedTexts(scenarios: Scenario[]): Promise<string[]> {
  const seen = new Set<string>();
  const recording = async (text: string) => {
    seen.add(text);
    return [1, 0, 0, 0, 0, 0, 0, 0];
  };
  for (const s of scenarios) {
    await decisionLog(s, recording);
    for (const t of calibrateTexts(s)) seen.add(t);
  }
  return [...seen].sort();
}

async function main(): Promise<void> {
  const scenarios = JSON.parse(
    readFileSync(join(__dirname, '..', '..', 'fixtures', 'supersession', 'scenarios.json'), 'utf8'),
  ) as Scenario[];
  const texts = await collectEmbedTexts(scenarios);
  const embed = await getEmbedder();
  const out: SidecarFile = { model: 'BGESmallENV15', texts: {} };
  for (const t of texts) out.texts[t] = (await embed(t)).map((x) => Math.round(x * 1e6) / 1e6);
  mkdirSync(dirname(SIDECAR_PATH), { recursive: true });
  writeFileSync(SIDECAR_PATH, gzipSync(JSON.stringify(out)));
  console.log(`wrote ${texts.length} vectors to ${SIDECAR_PATH}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

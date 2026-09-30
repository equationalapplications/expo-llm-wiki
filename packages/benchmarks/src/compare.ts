/**
 * Offline Markdown comparison between two {@link BenchReport} JSON files.
 *
 * The CLI subcommand `bench compare <before.json> <after.json>` calls
 * `compareReports(before, after)` and writes the resulting Markdown so a
 * reviewer can read the deltas end-to-end without rerunning the pipeline.
 *
 * Sections (in order):
 *   1. Header block — engine version + short SHA, flags, answer / judge /
 *      embed models for both runs.
 *   2. A **bold warning line** when the judge or answer model differs between
 *      the two runs (so the reviewer can tell whether a delta is real or a
 *      confound).
 *   3. Accuracy table by question type — before / after / Δ percentage points.
 *   4. Tokens table by call site — input+output / Δ %.
 *   - Retrieval context tokens — mean, p50, p95.
 *   - Ingest latency p50, p95.
 *   - Answer latency p50.
 *
 * Every numeric field is formatted to one decimal place.
 */

import type { BenchReport } from './report';
import type { CallSite } from './instrument';

/** Format a number to one decimal place (e.g. `12.345` ⇒ `"12.3"`). */
function f1(n: number): string {
  return n.toFixed(1);
}

/**
 * Format a Δ in percentage points (signed, 1 dp). Always signed so the
 * reader can scan the column for direction at a glance.
 */
function deltaPp(before: number, after: number): string {
  const d = (after - before) * 100;
  const sign = d > 0 ? '+' : '';
  return `${sign}${f1(d)} pp`;
}

/**
 * Format a Δ as a signed percent change (1 dp). Uses "before == 0" as the
 * special case — emit `n/a` rather than dividing by zero.
 */
function deltaPct(before: number, after: number): string {
  if (before === 0) {
    if (after === 0) return '+0.0%';
    return 'n/a';
  }
  const d = ((after - before) / before) * 100;
  const sign = d > 0 ? '+' : '';
  return `${sign}${f1(d)}%`;
}

/** Render a flags record as a compact string for the header. */
function renderFlags(flags: BenchReport['engine']['flags']): string {
  const parts = [`strategy=${flags.strategy}`, `maintenance=${flags.maintenance}`];
  if (typeof flags.readTokenBudget === 'number') parts.push(`read-budget=${flags.readTokenBudget}`);
  return parts.join(' ');
}

/**
 * Build the Markdown report-comparison string from two {@link BenchReport}
 * objects. The output is deterministic and human-readable; numbers are
 * rounded to one decimal place everywhere.
 */
export function compareReports(before: BenchReport, after: BenchReport): string {
  const lines: string[] = [];

  // ----- header -----
  lines.push('## Bench report comparison');
  lines.push('');
  lines.push('| field | before | after |');
  lines.push('|---|---|---|');
  lines.push(`| engine | ${before.engine.version} (${before.engine.gitSha}) | ${after.engine.version} (${after.engine.gitSha}) |`);
  lines.push(`| flags | ${renderFlags(before.engine.flags)} | ${renderFlags(after.engine.flags)} |`);
  lines.push(`| answer model | ${before.models.answer} | ${after.models.answer} |`);
  lines.push(`| judge model  | ${before.models.judge} | ${after.models.judge} |`);
  lines.push(`| embed model  | ${before.models.embed} | ${after.models.embed} |`);
  lines.push(`| sample       | ${before.sample.count} (seed ${before.sample.seed}) | ${after.sample.count} (seed ${after.sample.seed}) |`);
  lines.push('');

  // ----- model-mismatch warning line -----
  const answerDiffers = before.models.answer !== after.models.answer;
  const judgeDiffers = before.models.judge !== after.models.judge;
  if (answerDiffers || judgeDiffers) {
    const reasons: string[] = [];
    if (answerDiffers) reasons.push(`answer model (${before.models.answer} → ${after.models.answer})`);
    if (judgeDiffers) reasons.push(`judge model (${before.models.judge} → ${after.models.judge})`);
    const verb = reasons.length === 1 ? 'differs' : 'differ';
    lines.push(`**Warning:** ${reasons.join(' and ')} ${verb} between the two reports — accuracy deltas may be confounded.**`);
    lines.push('');
  }

  // ----- accuracy table (by type) -----
  lines.push('### Accuracy');
  lines.push('');
  lines.push('| type | before | after | Δ |');
  lines.push('|---|---:|---:|---:|');
  const allTypes = new Set<string>([
    ...Object.keys(before.accuracy.byType),
    ...Object.keys(after.accuracy.byType),
  ]);
  for (const t of [...allTypes].sort()) {
    const b = before.accuracy.byType[t] ?? { correct: 0, total: 0, rate: 0 };
    const a = after.accuracy.byType[t] ?? { correct: 0, total: 0, rate: 0 };
    const beforeStr = `${(b.rate * 100).toFixed(1)}%`;
    const afterStr = `${(a.rate * 100).toFixed(1)}%`;
    lines.push(`| ${t} | ${beforeStr} | ${afterStr} | ${deltaPp(b.rate, a.rate)} |`);
  }
  lines.push(`| **overall** | ${(before.accuracy.overall * 100).toFixed(1)}% | ${(after.accuracy.overall * 100).toFixed(1)}% | ${deltaPp(before.accuracy.overall, after.accuracy.overall)} |`);
  lines.push('');

  // ----- tokens table (by call site) -----
  lines.push('### Tokens');
  lines.push('');
  lines.push('| call site | before (in+out) | after (in+out) | Δ |');
  lines.push('|---|---:|---:|---:|');
  const allSites = new Set<CallSite>([
    ...Object.keys(before.tokens) as CallSite[],
    ...Object.keys(after.tokens) as CallSite[],
  ]);
  for (const site of [...allSites].sort()) {
    const b = before.tokens[site] ?? { calls: 0, inputTokens: 0, outputTokens: 0, estimatedCalls: 0 };
    const a = after.tokens[site] ?? { calls: 0, inputTokens: 0, outputTokens: 0, estimatedCalls: 0 };
    const bTotal = b.inputTokens + b.outputTokens;
    const aTotal = a.inputTokens + a.outputTokens;
    lines.push(`| ${site} | ${bTotal} | ${aTotal} | ${deltaPct(bTotal, aTotal)} |`);
  }
  lines.push('');

  // ----- retrieval -----
  lines.push('### Retrieval');
  lines.push('');
  lines.push('| metric | before | after |');
  lines.push('|---|---:|---:|');
  lines.push(`| mean context tokens | ${f1(before.retrieval.meanContextTokens)} | ${f1(after.retrieval.meanContextTokens)} |`);
  lines.push(`| p50 | ${f1(before.retrieval.p50)} | ${f1(after.retrieval.p50)} |`);
  lines.push(`| p95 | ${f1(before.retrieval.p95)} | ${f1(after.retrieval.p95)} |`);
  lines.push('');

  // ----- latency -----
  lines.push('### Ingest latency');
  lines.push('');
  lines.push('| metric | before (ms) | after (ms) |');
  lines.push('|---|---:|---:|');
  lines.push(`| p50 | ${f1(before.latencyMs.ingestP50)} | ${f1(after.latencyMs.ingestP50)} |`);
  lines.push(`| p95 | ${f1(before.latencyMs.ingestP95)} | ${f1(after.latencyMs.ingestP95)} |`);
  lines.push('');
  lines.push('### Answer latency');
  lines.push('');
  lines.push('| metric | before (ms) | after (ms) |');
  lines.push('|---|---:|---:|');
  lines.push(`| p50 | ${f1(before.latencyMs.answerP50)} | ${f1(after.latencyMs.answerP50)} |`);
  lines.push('');

  return lines.join('\n');
}
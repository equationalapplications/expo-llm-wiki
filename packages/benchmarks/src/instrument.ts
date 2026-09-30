import type { ChatProvider, TextParams, TextWithUsage } from './provider';

/** Minimal provider contract — `generateTextWithUsage` is optional. */
export interface ProviderLike {
  generateText(p: TextParams): Promise<string>;
  generateTextWithUsage?(p: TextParams): Promise<TextWithUsage>;
}

export type CallSite = 'librarian' | 'extract' | 'resolve' | 'heal' | 'ingest' | 'ontology' | 'answer' | 'judge' | 'other';

export interface UsageRecord {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCalls: number;
  ms: number;
}

export type UsageTotals = Record<CallSite, UsageRecord>;

export class UsageRecorder {
  private data: Record<CallSite, UsageRecord>;

  constructor() {
    const sites: CallSite[] = ['librarian', 'extract', 'resolve', 'heal', 'ingest', 'ontology', 'answer', 'judge', 'other'];
    this.data = {} as Record<CallSite, UsageRecord>;
    for (const site of sites) {
      this.data[site] = { calls: 0, inputTokens: 0, outputTokens: 0, estimatedCalls: 0, ms: 0 };
    }
  }

  record(site: CallSite, input: number, output: number, estimated: boolean, ms: number): void {
    const bucket = this.data[site];
    bucket.calls += 1;
    bucket.inputTokens += input;
    bucket.outputTokens += output;
    if (estimated) bucket.estimatedCalls += 1;
    bucket.ms += ms;
  }

  totals(): UsageTotals {
    return this.data;
  }
}

const SITE_PATTERNS: Array<[RegExp, CallSite]> = [
  [/knowledge extraction agent/, 'librarian'],
  [/memory extraction agent/, 'extract'],
  [/reconciliation agent/, 'resolve'],
  [/memory grooming agent/, 'heal'],
  [/document ingestion agent/, 'ingest'],
  [/classification agent/, 'ontology'],
];

/** Classify a system prompt by its first sentence into a known call site. */
export function classifyCallSite(systemPrompt: string): CallSite {
  for (const [pattern, site] of SITE_PATTERNS) {
    if (pattern.test(systemPrompt)) return site;
  }
  return 'other';
}

function estimateInputTokens(systemPrompt: string, userPrompt: string): number {
  return Math.ceil((systemPrompt.length + userPrompt.length) / 4);
}

function estimateOutputTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

interface InstrumentOptions {
  /** Optional override; when supplied, `forcedSite` bypasses classification. */
  forcedSite?: CallSite;
}

/**
 * Wrap a provider so every call classifies into a call-site bucket and is
 * recorded with measured wall-clock time and token usage (or an estimate when
 * the inner provider does not expose `generateTextWithUsage`).
 */
export function instrument(inner: ProviderLike, recorder: UsageRecorder, forcedSite?: CallSite): ChatProvider {
  function classify(p: TextParams): CallSite {
    return forcedSite ?? classifyCallSite(p.systemPrompt);
  }

  return {
    async generateText(p: TextParams): Promise<string> {
      const start = Date.now();
      const text = await inner.generateText(p);
      const ms = Date.now() - start;
      const site = classify(p);
      recorder.record(site, estimateInputTokens(p.systemPrompt, p.userPrompt), estimateOutputTokens(text), true, ms);
      return text;
    },

    async generateTextWithUsage(p: TextParams): Promise<TextWithUsage> {
      const start = Date.now();
      let result: TextWithUsage;
      let estimated: boolean;
      if (typeof inner.generateTextWithUsage === 'function') {
        // Use method syntax so `this` binds correctly when the inner provider
        // is an object whose `generateTextWithUsage` reads `this`.
        result = await inner.generateTextWithUsage(p);
        estimated = result.usage === undefined;
      } else {
        const text = await inner.generateText(p);
        result = { text };
        estimated = true;
      }
      const ms = Date.now() - start;
      const site = classify(p);
      const usage = result.usage ?? {
        inputTokens: estimateInputTokens(p.systemPrompt, p.userPrompt),
        outputTokens: estimateOutputTokens(result.text),
      };
      recorder.record(site, usage.inputTokens, usage.outputTokens, estimated, ms);
      return result;
    },
  };
}

export type { InstrumentOptions };
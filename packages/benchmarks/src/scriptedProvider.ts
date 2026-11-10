/**
 * Scripted LLM provider for zero-token diagnostics (spec
 * targeted-diagnostics §3). It answers each call site with a well-formed,
 * deterministic response and logs prompt volume per call. It tests nothing
 * about a real model's behavior: it exists so the engine's own prompt
 * assembly, batching and maintenance scheduling can be measured.
 *
 *   - extract (ops) / librarian (legacy): one fact per known stream event
 *     present in the user prompt. Title = the event's first 8 words.
 *   - resolve: ADD for every item.
 *   - heal and everything else: `{}`.
 *   - embed: 64-dim normalised hashed bag of words.
 */
import type { LLMProvider } from '@equationalapplications/core-llm-wiki';
import { classifyCallSite, type CallSite } from './instrument';

export interface StreamEvent {
  summary: string;
  occurred_at: number;
}

export interface ScriptedCall {
  site: CallSite;
  systemChars: number;
  userChars: number;
  userPrompt: string;
}

const EMBED_DIM = 64;

function hashToken(token: string): number {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % EMBED_DIM;
}

export function hashEmbed(text: string): number[] {
  const v = new Array<number>(EMBED_DIM).fill(0);
  for (const t of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) v[hashToken(t)]! += 1;
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

export function titleOf(summary: string): string {
  return summary.replace(/^(user|assistant):\s*/, '').split(/\s+/).slice(0, 8).join(' ');
}

function factsFor(userPrompt: string, stream: readonly StreamEvent[], withLabels: boolean): unknown[] {
  const facts: unknown[] = [];
  const seen = new Set<string>();
  if (withLabels) {
    // Ops extract lines: `e3 [ISO] (observation) <summary>`.
    for (const m of userPrompt.matchAll(/^(e\d+) \[[^\]]+\] \([^)]+\) (.*)$/gm)) {
      const summary = m[2]!;
      if (seen.has(summary)) continue;
      seen.add(summary);
      facts.push({ title: titleOf(summary), body: summary, source_event: m[1] });
    }
    return facts;
  }
  for (const e of stream) {
    if (seen.has(e.summary) || !userPrompt.includes(e.summary)) continue;
    seen.add(e.summary);
    facts.push({ title: titleOf(e.summary), body: e.summary });
  }
  return facts;
}

export function createScriptedProvider(stream: readonly StreamEvent[]): { provider: LLMProvider; log: ScriptedCall[] } {
  const log: ScriptedCall[] = [];
  const provider = {
    async generateText({ systemPrompt, userPrompt }: { systemPrompt: string; userPrompt: string }): Promise<string> {
      const site = classifyCallSite(systemPrompt);
      log.push({ site, systemChars: systemPrompt.length, userChars: userPrompt.length, userPrompt });
      switch (site) {
        case 'extract':
          return JSON.stringify({ facts: factsFor(userPrompt, stream, true), tasks: [] });
        case 'librarian':
          return JSON.stringify({ facts: factsFor(userPrompt, stream, false), tasks: [] });
        case 'resolve': {
          const json = userPrompt.slice(userPrompt.indexOf('{'));
          const items = (JSON.parse(json) as { items: Array<{ item: number }> }).items;
          return JSON.stringify({ ops: items.map((i) => ({ item: i.item, op: 'ADD' })) });
        }
        default:
          return '{}';
      }
    },
    async embed(text: string): Promise<number[]> {
      return hashEmbed(text);
    },
  } as unknown as LLMProvider;
  return { provider, log };
}

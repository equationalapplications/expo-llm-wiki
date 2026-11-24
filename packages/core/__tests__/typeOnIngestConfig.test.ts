import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  resolveSystemOneTypeOnIngest, resolveSystemOneTypeOnWrite, resolveTypingMinConfidence, __resetWarnOnceForTests,
} from '../src/utils/engineDefaults';
import { canEngageIngestTyping, canEngageWriteTyping, classifyFactsForWrite } from '../src/services/typing/typeOnWrite';
import { ONTOLOGY_ABSTAIN_SENTINEL } from '../src/utils/ontology';
import type { OntologyManifest, WikiConfig, WikiOptions } from '../src/types';

const man = (n: number, extra: string[] = []): OntologyManifest => ({
  node_types: [...Array.from({ length: n }, (_, i) => `t${i}`), ...extra].map((type) => ({ type, description: type })),
  edge_types: [],
});
const classify = async () => ({ answers: {} });
const ingestOn = { systemOne: { typeOnIngest: 'auto' } } as WikiConfig;

beforeEach(() => __resetWarnOnceForTests());
afterEach(() => vi.restoreAllMocks());

describe('resolveSystemOneTypeOnIngest (ingest-time-typing §1, Test plan 2)', () => {
  it('defaults to llm and passes auto/llm through', () => {
    expect(resolveSystemOneTypeOnIngest(undefined)).toBe('llm');
    expect(resolveSystemOneTypeOnIngest({})).toBe('llm');
    expect(resolveSystemOneTypeOnIngest(ingestOn)).toBe('auto');
    expect(resolveSystemOneTypeOnIngest({ systemOne: { typeOnIngest: 'llm' } })).toBe('llm');
  });
  it('warns once on an invalid value and treats it as unset', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bad = { systemOne: { typeOnIngest: 'off' } } as unknown as WikiConfig;
    expect(resolveSystemOneTypeOnIngest(bad)).toBe('llm');
    expect(resolveSystemOneTypeOnIngest(bad)).toBe('llm');
    expect(warn).toHaveBeenCalledTimes(1);
  });
  it('is independent of typeOnWrite, both ways', () => {
    expect(resolveSystemOneTypeOnIngest({ systemOne: { typeOnWrite: 'auto' } })).toBe('llm');
    expect(resolveSystemOneTypeOnWrite(ingestOn)).toBe('llm');
  });
  it('the floor is the shared typing floor, 0 honored', () => {
    expect(resolveTypingMinConfidence({ systemOne: { typeOnIngest: 'auto', minConfidence: { typing: 0 } } } as WikiConfig)).toBe(0);
  });
});

describe('canEngageIngestTyping (§2, Test plan 3)', () => {
  const ok = () => canEngageIngestTyping(ingestOn, { classify }, 'strict', man(2));
  it('engages only when all four hold', () => {
    expect(ok()).toBe(true);
    expect(canEngageIngestTyping(ingestOn, { classify }, 'emergent', man(2))).toBe(true);
    expect(canEngageIngestTyping({}, { classify }, 'strict', man(2))).toBe(false);
    expect(canEngageIngestTyping({ systemOne: { typeOnIngest: 'llm' } }, { classify }, 'strict', man(2))).toBe(false);
    expect(canEngageIngestTyping(ingestOn, {}, 'strict', man(2))).toBe(false);
    expect(canEngageIngestTyping(ingestOn, { classify }, 'off', man(2))).toBe(false);
    expect(canEngageIngestTyping(ingestOn, { classify }, 'strict', man(0))).toBe(false);
  });
  it('typeOnWrite alone does not engage ingest; typeOnIngest alone does not engage the librarian', () => {
    expect(canEngageIngestTyping({ systemOne: { typeOnWrite: 'auto' } }, { classify }, 'strict', man(2))).toBe(false);
    expect(canEngageWriteTyping(ingestOn, { classify }, 'strict', man(2))).toBe(false);
  });
  it('shares the manifest boundary with the write caller (254 ok, 255 not, reserved slug not)', () => {
    const w = { systemOne: { typeOnWrite: 'auto' } } as WikiConfig;
    expect(canEngageIngestTyping(ingestOn, { classify }, 'strict', man(254))).toBe(true);
    expect(canEngageWriteTyping(w, { classify }, 'strict', man(254))).toBe(true);
    expect(canEngageIngestTyping(ingestOn, { classify }, 'strict', man(255))).toBe(false);
    expect(canEngageWriteTyping(w, { classify }, 'strict', man(255))).toBe(false);
    const reserved = man(1, [ONTOLOGY_ABSTAIN_SENTINEL]);
    expect(canEngageIngestTyping(ingestOn, { classify }, 'strict', reserved)).toBe(false);
    expect(canEngageWriteTyping(w, { classify }, 'strict', reserved)).toBe(false);
    expect(canEngageIngestTyping(ingestOn, { classify }, 'strict', reserved)).toBe(
      canEngageWriteTyping(w, { classify }, 'strict', reserved),
    );
  });
});

describe('classifyFactsForWrite opts.concurrency (§3)', () => {
  it('honors opts.concurrency over config.chunkConcurrency', async () => {
    let inflight = 0; let max = 0;
    const options = {
      config: { chunkConcurrency: 1 },
      llmProvider: {
        generateText: async () => '',
        classify: async () => {
          inflight++; max = Math.max(max, inflight);
          await new Promise((r) => setTimeout(r, 5));
          inflight--;
          return { answers: {} };
        },
      },
    } as unknown as WikiOptions;
    const facts = Array.from({ length: 6 }, (_, i) => ({ title: `f${i}`, body: 'b', tags: [] }));
    await classifyFactsForWrite(options, { entityId: 'e', trigger: 'call', operation: 'ingest' }, facts, man(2), 0.5, { concurrency: 3 });
    expect(max).toBe(3);
    max = 0;
    await classifyFactsForWrite(options, { entityId: 'e', trigger: 'call', operation: 'ingest' }, facts, man(2), 0.5);
    expect(max).toBe(1);
  });
});

import { describe, it, expect } from 'vitest';
import { PromptService } from '../src/services/PromptService';
import type { BuiltPrompt } from '../src/services/BoundedLlmCall';
import type { DegradedRecord } from '../src/types';
import {
  HEAL_ANCHORS_PER_CANDIDATE,
  HEAL_MAX_ANCHORS,
  HEAL_MAX_FACT_BODY_CHARS_L3,
} from '../src/utils/healConstants';

function makeCandidate(id: string, body: string) {
  return { id, title: `title ${id}`, body, tags: [] };
}

function makeAnchors(n: number) {
  return Array.from({ length: n }, (_, i) => ({ id: `a${i}`, title: `anchor ${i}`, body: 'x', tags: [] }));
}

const allTasks = [{ id: 't1', description: 'a task' }];
const recentEvents = [{ id: 'e1', type: 'write' }];

function newService() {
  return new PromptService();
}

describe('PromptService.buildHealPrompt — ladder interpretation', () => {
  it('L0: anchor count scaled to batch size, allTasks and recentEvents present', () => {
    const svc = newService();
    const candidates = Array.from({ length: 10 }, (_, i) => makeCandidate(`c${i}`, 'body'));
    const anchors = makeAnchors(50);
    const { prompts, degraded } = svc.buildHealPrompt(
      candidates, anchors, allTasks, recentEvents, undefined, 0,
    );
    expect(degraded).toEqual([]);
    // L0: min(50, 10 * 4) = 40 anchors serialized in the prompt.
    const userPrompt: string = (prompts as BuiltPrompt).userPrompt;
    const anchorMatches = userPrompt.match(/"id": "a\d+"/g) ?? [];
    expect(anchorMatches.length).toBe(40);
    expect(userPrompt).toContain('"id": "t1"');
    expect(userPrompt).toContain('"id": "e1"');
  });

  it('L1: allTasks dropped, recentEvents present, anchor scaling unchanged', () => {
    const svc = newService();
    const candidates = Array.from({ length: 5 }, (_, i) => makeCandidate(`c${i}`, 'body'));
    const anchors = makeAnchors(50);
    const { prompts, degraded } = svc.buildHealPrompt(
      candidates, anchors, allTasks, recentEvents, undefined, 1,
    );
    expect(degraded).toEqual([]);
    const userPrompt: string = (prompts as BuiltPrompt).userPrompt;
    expect(userPrompt).not.toContain('"id": "t1"');
    expect(userPrompt).toContain('"id": "e1"');
    const anchorMatches = userPrompt.match(/"id": "a\d+"/g) ?? [];
    expect(anchorMatches.length).toBe(20); // min(50, 5 * 4)
  });

  it('L2: allTasks and recentEvents both dropped', () => {
    const svc = newService();
    const candidates = Array.from({ length: 3 }, (_, i) => makeCandidate(`c${i}`, 'body'));
    const anchors = makeAnchors(50);
    const { prompts, degraded } = svc.buildHealPrompt(
      candidates, anchors, allTasks, recentEvents, undefined, 2,
    );
    expect(degraded).toEqual([]);
    const userPrompt: string = (prompts as BuiltPrompt).userPrompt;
    expect(userPrompt).not.toContain('"id": "t1"');
    expect(userPrompt).not.toContain('"id": "e1"');
  });

  it('L3: bodies truncated to bodyTruncationChars, with marker, and degraded records emitted', () => {
    const svc = newService();
    const longBody = 'x'.repeat(12_345);
    const candidates = [makeCandidate('c0', longBody)];
    const anchors: unknown[] = [];
    const { prompts, degraded } = svc.buildHealPrompt(
      candidates, anchors, allTasks, recentEvents, undefined, 3,
    );
    expect(degraded).toEqual([
      { id: 'c0', originalBodyChars: 12_345, truncatedBodyChars: HEAL_MAX_FACT_BODY_CHARS_L3 },
    ]);
    const userPrompt: string = (prompts as BuiltPrompt).userPrompt;
    expect(userPrompt).toContain(`…[truncated at ${HEAL_MAX_FACT_BODY_CHARS_L3} chars, original was 12345]`);
    expect(userPrompt.length).toBeLessThan(longBody.length);
  });

  it('L3 with body.length <= cap: passes through unchanged, no degraded record', () => {
    const svc = newService();
    const shortBody = 'short body';
    const candidates = [makeCandidate('c0', shortBody)];
    const { prompts, degraded } = svc.buildHealPrompt(
      candidates, [], allTasks, recentEvents, undefined, 3,
    );
    expect(degraded).toEqual([]);
    const userPrompt: string = (prompts as BuiltPrompt).userPrompt;
    expect(userPrompt).toContain('short body');
    expect(userPrompt).not.toContain('[truncated');
  });

  it('L3 with bodyTruncationChars: 500: bodies truncated to 500 chars, degraded carries the override', () => {
    const svc = newService();
    const longBody = 'y'.repeat(8_000);
    const candidates = [makeCandidate('c0', longBody), makeCandidate('c1', 'short')];
    const { prompts, degraded } = svc.buildHealPrompt(
      candidates, [], allTasks, recentEvents, undefined, 3, 500,
    );
    expect(degraded).toEqual([
      { id: 'c0', originalBodyChars: 8_000, truncatedBodyChars: 500 },
    ]);
    const userPrompt: string = (prompts as BuiltPrompt).userPrompt;
    expect(userPrompt).toContain('…[truncated at 500 chars, original was 8000]');
    expect(userPrompt).toContain('short');
  });

  it('L0 with bodyTruncationChars override: bodies are full, degraded empty', () => {
    const svc = newService();
    const longBody = 'z'.repeat(8_000);
    const candidates = [makeCandidate('c0', longBody)];
    const { prompts, degraded } = svc.buildHealPrompt(
      candidates, [], allTasks, recentEvents, undefined, 0, 500,
    );
    expect(degraded).toEqual([]);
    const userPrompt: string = (prompts as BuiltPrompt).userPrompt;
    expect(userPrompt).toContain('z'.repeat(500));
    expect(userPrompt).not.toContain('[truncated');
  });

  it('L3 truncation does not split a UTF-16 surrogate pair at the cut boundary', () => {
    // Regression lock for the boundary hazard the same way `formatSkipError`
    // handles its log lines: a naive `body.slice(0, n)` would emit a lone high
    // surrogate when the cut lands between a high surrogate (e.g. 😀 U+1F600's
    // first code unit, 0xD83D) and its paired low surrogate (0xDE00). `safeSlice`
    // recognizes the boundary is mid-pair and trims back so the prompt never
    // carries an invalid codepoint.
    //
    // Body shape: 3999 ASCII 'a' chars + one 😀 (surrogate pair = 2 UTF-16 units).
    // Total body length: 4001 chars. bodyTruncationChars: 4000. The cut at
    // index 4000 lands between the ASCII region and the high surrogate.
    const svc = newService();
    const body = 'a'.repeat(3999) + '😀';
    const candidates = [makeCandidate('c0', body)];
    const { prompts, degraded } = svc.buildHealPrompt(
      candidates, [], allTasks, recentEvents, undefined, 3, HEAL_MAX_FACT_BODY_CHARS_L3,
    );
    expect(degraded).toEqual([
      { id: 'c0', originalBodyChars: 4001, truncatedBodyChars: HEAL_MAX_FACT_BODY_CHARS_L3 },
    ]);
    const userPrompt: string = (prompts as BuiltPrompt).userPrompt;
    // The 3999 ASCII chars must be preserved in full.
    expect(userPrompt).toContain('a'.repeat(3999));
    // The emoji was at the boundary; safeSlice dropped it rather than emit a
    // lone surrogate. A naive `String.prototype.slice` would have left a
    // high surrogate (0xD83D) sitting in front of the marker.
    expect(userPrompt).not.toContain('😀');
    // No lone surrogate (high or low) anywhere in the rendered prompt. The
    // marker text contains no surrogates — any match here is from the body.
    expect(userPrompt).not.toMatch(/[\uD800-\uDBFF]/);
    expect(userPrompt).not.toMatch(/[\uDC00-\uDFFF]/);
    // Marker is correct.
    expect(userPrompt).toContain(`…[truncated at ${HEAL_MAX_FACT_BODY_CHARS_L3} chars, original was 4001]`);
  });
});

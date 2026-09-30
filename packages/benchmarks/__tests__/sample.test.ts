import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadDataset, parseLmeDate } from '../src/longmemeval/dataset';
import { sampleQuestionIds, STRATA } from '../src/longmemeval/sample';
import type { LmeQuestion } from '../src/longmemeval/dataset';

type LmeType = LmeQuestion['question_type'];

const TYPES: LmeType[] = [
  'knowledge-update',
  'temporal-reasoning',
  'multi-session',
  'single-session-user',
  'single-session-assistant',
  'single-session-preference',
];

function makeSynthetic(): LmeQuestion[] {
  const out: LmeQuestion[] = [];
  // 10 per type ⇒ 60 base questions.
  for (const type of TYPES) {
    for (let i = 0; i < 10; i++) {
      out.push({
        question_id: `${type}__${String(i).padStart(2, '0')}`,
        question_type: type,
        question: `q ${type} ${i}`,
        answer: 'a',
        question_date: '2023/05/20 (Sat) 02:21',
        haystack_dates: ['2023/05/18 (Thu) 10:00'],
        haystack_sessions: [[{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }]],
      });
    }
  }
  // Plus 3 abstention questions — must never be picked.
  for (let i = 0; i < 3; i++) {
    out.push({
      question_id: `knowledge-update__${String(i).padStart(2, '0')}_abs`,
      question_type: 'knowledge-update',
      question: `abs q ${i}`,
      answer: 'a',
      question_date: '2023/05/20 (Sat) 02:21',
      haystack_dates: ['2023/05/18 (Thu) 10:00'],
      haystack_sessions: [[{ role: 'user', content: 'hi' }]],
    });
  }
  return out;
}

describe('STRATA', () => {
  it('has the spec-defined six keys with the spec-defined counts (total 80)', () => {
    expect(STRATA).toEqual({
      'knowledge-update': 20,
      'temporal-reasoning': 20,
      'multi-session': 15,
      'single-session-user': 9,
      'single-session-assistant': 8,
      'single-session-preference': 8,
    });
    expect(Object.values(STRATA).reduce((a, b) => a + b, 0)).toBe(80);
  });
});

describe('parseLmeDate', () => {
  it('parses "YYYY/MM/DD (Day) HH:mm" to a UTC epoch', () => {
    expect(parseLmeDate('2023/05/20 (Sat) 02:21')).toBe(Date.UTC(2023, 4, 20, 2, 21));
    expect(parseLmeDate('2024/01/01 (Mon) 00:00')).toBe(Date.UTC(2024, 0, 1, 0, 0));
    expect(parseLmeDate('2024/12/31 (Tue) 23:59')).toBe(Date.UTC(2024, 11, 31, 23, 59));
  });
  it('throws on unparseable input', () => {
    expect(() => parseLmeDate('not a date')).toThrow();
    expect(() => parseLmeDate('2023-05-20 02:21')).toThrow();
    expect(() => parseLmeDate('')).toThrow();
  });
});

describe('sampleQuestionIds', () => {
  const questions = makeSynthetic();

  it('returns one id per sampled slot, capped at availability, in STRATA key order', () => {
    const ids = sampleQuestionIds(questions, 20260929);
    const counts: Record<string, number> = {};
    for (const id of ids) {
      const q = questions.find((x) => x.question_id === id)!;
      counts[q.question_type] = (counts[q.question_type] ?? 0) + 1;
    }
    // 10 per type available; STRATA caps:
    //   knowledge-update 20 ⇒ take 10 (availability)
    //   temporal-reasoning 20 ⇒ take 10
    //   multi-session 15 ⇒ take 10
    //   single-session-user 9 ⇒ take 9 (STRATA cap)
    //   single-session-assistant 8 ⇒ take 8 (STRATA cap)
    //   single-session-preference 8 ⇒ take 8 (STRATA cap)
    const expectedCounts: Record<string, number> = {
      'knowledge-update': 10,
      'temporal-reasoning': 10,
      'multi-session': 10,
      'single-session-user': 9,
      'single-session-assistant': 8,
      'single-session-preference': 8,
    };
    for (const type of TYPES) {
      expect(counts[type]).toBe(expectedCounts[type]);
    }
    expect(ids.length).toBe(55);
  });

  it('concatenates strata in STRATA key order', () => {
    const ids = sampleQuestionIds(questions, 20260929);
    // STRATA keys in declaration order: knowledge-update, temporal-reasoning, multi-session,
    // single-session-user, single-session-assistant, single-session-preference.
    const orderKeys = Object.keys(STRATA);
    const seenTypes: string[] = [];
    let lastIndex = -1;
    for (const id of ids) {
      const q = questions.find((x) => x.question_id === id)!;
      const idx = orderKeys.indexOf(q.question_type);
      expect(idx).toBeGreaterThanOrEqual(lastIndex);
      if (idx > lastIndex) {
        seenTypes.push(q.question_type);
        lastIndex = idx;
      }
    }
    expect(seenTypes).toEqual(orderKeys);
  });

  it('never returns _abs question ids', () => {
    const ids = sampleQuestionIds(questions, 1);
    expect(ids.some((id) => id.endsWith('_abs'))).toBe(false);
  });

  it('is deterministic for the same seed', () => {
    const a = sampleQuestionIds(questions, 42);
    const b = sampleQuestionIds(questions, 42);
    expect(a).toEqual(b);
  });

  it('produces a different output for a different seed (when type has >1 candidate)', () => {
    const a = sampleQuestionIds(questions, 1);
    const b = sampleQuestionIds(questions, 2);
    // Both pick all 10 of each type, but order matters; sampleQuestionIds is
    // required to shuffle, so the per-stratum ids differ at least once.
    const aStr = a.join('|');
    const bStr = b.join('|');
    expect(aStr).not.toBe(bStr);
  });
});

describe('loadDataset', () => {
  it('writes the cache file on first call and reuses it on second (zero fetches)', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'lme-cache-'));
    try {
      const datasetPayload = JSON.stringify(makeSynthetic());
      const fetchImpl = vi.fn(async (url: string) =>
        new Response(datasetPayload, { status: 200, headers: { 'content-type': 'application/json' } }),
      );

      const url = 'https://example.test/longmemeval_s.json';
      const first = await loadDataset({ url, cacheDir, fetchImpl: fetchImpl as unknown as typeof fetch });
      expect(first.length).toBe(63); // 60 + 3 _abs
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl.mock.calls[0]?.[0]).toBe(url);

      const cacheFile = join(cacheDir, 'longmemeval_s.json');
      expect(existsSync(cacheFile)).toBe(true);
      expect(JSON.parse(readFileSync(cacheFile, 'utf8')).length).toBe(63);

      // Second call must not touch fetchImpl at all.
      const second = await loadDataset({ url, cacheDir, fetchImpl: fetchImpl as unknown as typeof fetch });
      expect(second.length).toBe(63);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
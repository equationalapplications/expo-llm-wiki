import { describe, it, expect } from 'vitest';
import { validateClassifierAnswer, classifierStateForFact } from '../src/utils/classifier';
import type { ClassifierQuestion } from '../src/types';

const choice: ClassifierQuestion = { kind: 'choice', options: ['person', 'place'] };
const binary: ClassifierQuestion = { kind: 'binary', instructions: 'Is it true?' };
const score: ClassifierQuestion = { kind: 'score', levels: ['low', 'mid', 'high'] };
const wrap = (answer: unknown) => ({ answers: { q: answer } });

describe('validateClassifierAnswer', () => {
  it('accepts a well-formed choice', () => {
    const r = validateClassifierAnswer(wrap({ kind: 'choice', choice: 'place', confidence: 0.9, probabilities: { person: 0.1, place: 0.9 } }), 'q', choice);
    expect(r).toEqual({ ok: true, answer: { kind: 'choice', choice: 'place', confidence: 0.9, probabilities: { person: 0.1, place: 0.9 } } });
  });

  it.each([
    ['non-object response', 42, 'malformed'],
    ['missing answers map', {}, 'missing_answer'],
    ['missing key', { answers: {} }, 'missing_answer'],
    ['kind mismatch', wrap({ kind: 'binary', probability: 0.5 }), 'kind_mismatch'],
    ['off-list choice', wrap({ kind: 'choice', choice: 'planet', confidence: 0.9, probabilities: {} }), 'choice_not_offered'],
    ['NaN confidence', wrap({ kind: 'choice', choice: 'place', confidence: Number.NaN, probabilities: {} }), 'invalid_probability'],
    ['confidence > 1', wrap({ kind: 'choice', choice: 'place', confidence: 1.5, probabilities: {} }), 'invalid_probability'],
    ['bad probability value', wrap({ kind: 'choice', choice: 'place', confidence: 0.5, probabilities: { place: -0.1 } }), 'invalid_probability'],
  ])('rejects %s', (_label, response, reason) => {
    expect(validateClassifierAnswer(response, 'q', choice)).toEqual({ ok: false, reason });
  });

  it('validates binary', () => {
    expect(validateClassifierAnswer(wrap({ kind: 'binary', probability: 0.2 }), 'q', binary)).toEqual({ ok: true, answer: { kind: 'binary', probability: 0.2 } });
    expect(validateClassifierAnswer(wrap({ kind: 'binary', probability: 2 }), 'q', binary)).toEqual({ ok: false, reason: 'invalid_probability' });
  });

  it('validates score range [0, levels-1]', () => {
    expect(validateClassifierAnswer(wrap({ kind: 'score', score: 1.04, confidence: 0.9, probabilities: [0, 0.96, 0.04] }), 'q', score).ok).toBe(true);
    expect(validateClassifierAnswer(wrap({ kind: 'score', score: 2.5, confidence: 0.9, probabilities: [0, 0, 1] }), 'q', score)).toEqual({ ok: false, reason: 'score_out_of_range' });
    expect(validateClassifierAnswer(wrap({ kind: 'score', score: 1, confidence: 0.9, probabilities: [0, 'x', 1] }), 'q', score)).toEqual({ ok: false, reason: 'invalid_probability' });
  });

  it('never throws on hostile input', () => {
    const hostile = new Proxy({}, { get() { throw new Error('trap'); } });
    expect(validateClassifierAnswer(hostile, 'q', choice)).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('classifierStateForFact', () => {
  it('joins title, body and tags', () => {
    expect(classifierStateForFact({ title: 'Ada', body: 'Mathematician', tags: ['history', 'math'] }))
      .toBe('Ada\n\nMathematician\n\nTags: history, math');
    expect(classifierStateForFact({ title: 'Ada', body: 'Mathematician', tags: [] })).toBe('Ada\n\nMathematician');
  });
});

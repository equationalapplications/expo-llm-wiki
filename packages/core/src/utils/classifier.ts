import type { ClassifierAnswer, ClassifierQuestion } from '../types';

export type ClassifierRejection =
  | 'malformed'
  | 'missing_answer'
  | 'kind_mismatch'
  | 'choice_not_offered'
  | 'score_out_of_range'
  | 'invalid_probability';

type Checked = { ok: true; answer: ClassifierAnswer } | { ok: false; reason: ClassifierRejection };

const isUnit = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

/**
 * Validate one answer from an untrusted classifier response (spec REQ-CLASS-02).
 * Never throws: hostile objects (throwing getters, Proxies) yield `malformed`.
 * Returns a fresh plain object, never the provider's own reference.
 */
export function validateClassifierAnswer(response: unknown, key: string, question: ClassifierQuestion): Checked {
  try {
    if (response === null || typeof response !== 'object') return { ok: false, reason: 'malformed' };
    const answers = (response as { answers?: unknown }).answers;
    if (answers === null || typeof answers !== 'object') return { ok: false, reason: 'missing_answer' };
    if (!Object.prototype.hasOwnProperty.call(answers, key)) return { ok: false, reason: 'missing_answer' };
    const raw = (answers as Record<string, unknown>)[key];
    if (raw === null || typeof raw !== 'object') return { ok: false, reason: 'missing_answer' };
    const a = raw as Record<string, unknown>;
    if (a.kind !== question.kind) return { ok: false, reason: 'kind_mismatch' };

    if (question.kind === 'choice') {
      if (typeof a.choice !== 'string' || !question.options.includes(a.choice)) return { ok: false, reason: 'choice_not_offered' };
      if (!isUnit(a.confidence)) return { ok: false, reason: 'invalid_probability' };
      const probs = a.probabilities;
      if (probs === null || typeof probs !== 'object' || Array.isArray(probs)) return { ok: false, reason: 'invalid_probability' };
      const probabilities: Record<string, number> = {};
      for (const [k, v] of Object.entries(probs as Record<string, unknown>)) {
        if (!isUnit(v)) return { ok: false, reason: 'invalid_probability' };
        probabilities[k] = v;
      }
      return { ok: true, answer: { kind: 'choice', choice: a.choice, confidence: a.confidence, probabilities } };
    }

    if (question.kind === 'binary') {
      if (!isUnit(a.probability)) return { ok: false, reason: 'invalid_probability' };
      return { ok: true, answer: { kind: 'binary', probability: a.probability } };
    }

    const maxScore = question.levels.length - 1;
    if (typeof a.score !== 'number' || !Number.isFinite(a.score) || a.score < 0 || a.score > maxScore) {
      return { ok: false, reason: 'score_out_of_range' };
    }
    if (!isUnit(a.confidence)) return { ok: false, reason: 'invalid_probability' };
    if (!Array.isArray(a.probabilities) || !a.probabilities.every(isUnit)) return { ok: false, reason: 'invalid_probability' };
    return { ok: true, answer: { kind: 'score', score: a.score, confidence: a.confidence, probabilities: a.probabilities.slice() } };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}

/** The classifier `state` for a fact: title, body, and tags when present. */
export function classifierStateForFact(fact: { title: string; body: string; tags: string[] }): string {
  const parts = [fact.title, fact.body];
  if (Array.isArray(fact.tags) && fact.tags.length > 0) parts.push(`Tags: ${fact.tags.join(', ')}`);
  return parts.join('\n\n');
}

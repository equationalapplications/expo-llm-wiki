import { describe, it, expect } from 'vitest';
import {
  buildAnswerPrompt,
  buildJudgePrompt,
  parseVerdict,
  JUDGE_TEMPLATES,
} from '../src/longmemeval/judge';
import type { LmeQuestion, LmeQuestionType } from '../src/longmemeval/dataset';

const TYPES: LmeQuestionType[] = [
  'single-session-user',
  'single-session-assistant',
  'single-session-preference',
  'multi-session',
  'temporal-reasoning',
  'knowledge-update',
];

function makeQuestion(type: LmeQuestionType): LmeQuestion {
  return {
    question_id: `judge-test-${type}`,
    question_type: type,
    question: `Q for ${type}?`,
    answer: `correct-${type}`,
    question_date: '2023/05/20 (Sat) 02:21',
    haystack_dates: ['2023/05/18 (Thu) 10:00'],
    haystack_sessions: [[{ role: 'user', content: 'hi' }]],
  };
}

describe('buildAnswerPrompt', () => {
  it('substitutes the question date, memory, and question into the user prompt', () => {
    const q = makeQuestion('single-session-user');
    const { systemPrompt, userPrompt } = buildAnswerPrompt(q, 'fact A; fact B');
    expect(systemPrompt).toContain('long-term memory');
    expect(systemPrompt).toContain("don't know");
    expect(userPrompt).toContain('Current date: 2023/05/20 (Sat) 02:21');
    expect(userPrompt).toContain('Memory:\nfact A; fact B');
    expect(userPrompt).toContain('Question: Q for single-session-user?');
    expect(userPrompt).not.toContain('{');
    expect(userPrompt).not.toContain('}');
  });

  it('substitutes (empty) when the memory context is empty', () => {
    const q = makeQuestion('multi-session');
    const { userPrompt } = buildAnswerPrompt(q, '');
    expect(userPrompt).toContain('Memory:\n(empty)');
    expect(userPrompt).not.toContain('{');
    expect(userPrompt).not.toContain('}');
  });
});

describe('buildJudgePrompt', () => {
  it('inserts values literally, without $-pattern expansion or re-substitution', () => {
    const q = { ...makeQuestion('single-session-user'), question: 'Q {answer} {response}', answer: "A $& $'" };
    const { userPrompt } = buildJudgePrompt(q, "R $` $'");
    expect(userPrompt).toContain('Q {answer} {response}');
    expect(userPrompt).toContain("A $& $'");
    expect(userPrompt).toContain("R $` $'");
  });

  it('has a JUDGE_TEMPLATES entry for every LmeQuestionType', () => {
    for (const t of TYPES) {
      expect(JUDGE_TEMPLATES[t]).toBeTypeOf('string');
      expect(JUDGE_TEMPLATES[t].length).toBeGreaterThan(0);
    }
  });

  it('substitutes {question}, {answer}, {response} for every question type', () => {
    for (const t of TYPES) {
      const q = makeQuestion(t);
      const { systemPrompt, userPrompt } = buildJudgePrompt(q, `response for ${t}`);
      expect(systemPrompt).toBe('You are an evaluator. Answer yes or no only.');
      // No template placeholders should remain after substitution.
      expect(userPrompt).not.toContain('{question}');
      expect(userPrompt).not.toContain('{answer}');
      expect(userPrompt).not.toContain('{response}');
      expect(userPrompt).not.toContain('{');
      expect(userPrompt).not.toContain('}');
      // Substituted values must appear.
      expect(userPrompt).toContain(`Q for ${t}?`);
      expect(userPrompt).toContain(`correct-${t}`);
      expect(userPrompt).toContain(`response for ${t}`);
    }
  });

  it('the temporal-reasoning template mentions off-by-one tolerance', () => {
    expect(JUDGE_TEMPLATES['temporal-reasoning']).toMatch(/off-by-one/i);
  });

  it('the single-session-preference template uses the word "Rubric"', () => {
    const q = makeQuestion('single-session-preference');
    const { userPrompt } = buildJudgePrompt(q, 'a response');
    expect(userPrompt).toContain('Rubric:');
    expect(userPrompt).toContain('correct-single-session-preference');
  });

  it('the non-preference templates use "Correct Answer" (not "Rubric")', () => {
    for (const t of TYPES.filter((x) => x !== 'single-session-preference')) {
      const q = makeQuestion(t);
      const { userPrompt } = buildJudgePrompt(q, 'r');
      expect(userPrompt).toContain('Correct Answer:');
      expect(userPrompt).not.toContain('Rubric:');
    }
  });
});

describe('parseVerdict', () => {
  it('returns true for "Yes."', () => {
    expect(parseVerdict('Yes.')).toBe(true);
  });

  it('returns true for " yes" (leading whitespace)', () => {
    expect(parseVerdict(' yes')).toBe(true);
  });

  it('returns true for a one-line "YES" with trailing whitespace', () => {
    expect(parseVerdict('YES\n')).toBe(true);
  });

  it('returns true for a longer affirmation that starts with "yes"', () => {
    expect(parseVerdict('yes, the response includes the correct answer.')).toBe(true);
  });

  it('returns false for "No"', () => {
    expect(parseVerdict('No')).toBe(false);
  });

  it('returns false for "maybe"', () => {
    expect(parseVerdict('maybe')).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(parseVerdict('')).toBe(false);
  });

  it('returns false for a string that contains "yes" but does not start with it', () => {
    expect(parseVerdict('The answer is yes.')).toBe(false);
  });
});
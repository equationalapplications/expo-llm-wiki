import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runLongMemEval } from '../src/longmemeval/run';
import type { EngineFlags } from '../src/longmemeval/ingest';
import type { LmeQuestion, LmeQuestionType } from '../src/longmemeval/dataset';

function makeQuestion(type: LmeQuestionType, id: string, answer: string): LmeQuestion {
  return {
    question_id: id,
    question_type: type,
    question: `What is the answer for ${type} ${id}?`,
    answer,
    question_date: '2023/05/20 (Sat) 02:21',
    haystack_dates: ['2023/05/18 (Thu) 10:00'],
    haystack_sessions: [
      [
        { role: 'user', content: 'pick a colour' },
        { role: 'assistant', content: 'which one?' },
        { role: 'user', content: 'blue' },
      ],
    ],
  };
}

describe('runLongMemEval', () => {
  it('runs ingest→read→answer→judge per question and emits a structured report', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'lme-run-'));

    // The judge is invoked once per question. The first call says "yes",
    // the second says "no" — giving an overall accuracy of 0.5.
    let judgeCount = 0;

    // The fake fetch routes by request body. Anthropic responses are used
    // because the test endpoints are configured as `protocol: 'anthropic'`.
    const anthropicOk = (text: string, inputTokens: number, outputTokens: number) =>
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text }],
          usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );

    const fetchImpl = vi.fn(async (_url: string, init?: { body?: string }) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      const systemPrompt: string = body.system ?? '';
      if (systemPrompt.includes('knowledge extraction agent')) {
        return anthropicOk(
          JSON.stringify({
            facts: [
              { title: 'User favourite colour', body: 'The user favourite colour is blue.' },
            ],
            tasks: [],
          }),
          10,
          5,
        );
      }
      if (systemPrompt.includes('long-term memory')) {
        return anthropicOk('blue', 100, 1);
      }
      if (systemPrompt.includes('evaluator')) {
        judgeCount += 1;
        const verdict = judgeCount === 1 ? 'yes' : 'no';
        return anthropicOk(verdict, 50, 1);
      }
      // Anything else (e.g. ontology, heal): an empty JSON object.
      return anthropicOk('{}', 0, 0);
    });

    const flags: EngineFlags = { strategy: 'legacy', maintenance: 'auto' };
    const q1 = makeQuestion('single-session-user', 'sess-user-001', 'blue');
    const q2 = makeQuestion('knowledge-update', 'know-update-001', 'red');

    try {
      const report = await runLongMemEval({
        questions: [q1, q2],
        flags,
        cacheDir,
        engineVersion: '7.7.7-test',
        answerEndpoint: {
          protocol: 'anthropic',
          baseUrl: 'https://x.test',
          apiKey: 'k',
          model: 'answer-model',
        },
        judgeEndpoint: {
          protocol: 'anthropic',
          baseUrl: 'https://x.test',
          apiKey: 'k',
          model: 'judge-model',
        },
        concurrency: 2,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        embed: async (_t: string) => [0.1, 0.2, 0.3],
      });

      // 1 of 2 verdicts was "yes" → accuracy 0.5.
      expect(report.accuracy.overall).toBe(0.5);
      // Per-type accuracy: each type has total 1; first question type is correct,
      // second is not (the order matches the input questions array).
      expect(report.accuracy.byType['single-session-user']).toEqual({ correct: 1, total: 1 });
      expect(report.accuracy.byType['knowledge-update']).toEqual({ correct: 0, total: 1 });
      // Two answer-model calls and two judge-model calls — one per question.
      expect(report.tokens.answer.calls).toBe(2);
      expect(report.tokens.judge.calls).toBe(2);
      // Judge model id surfaces in the report exactly as configured.
      expect(report.models.judge).toBe('judge-model');
      expect(report.models.answer).toBe('answer-model');
      // The first question produced non-empty retrieval context.
      expect(report.questions[0].contextTokens).toBeGreaterThan(0);
      expect(report.questions[0].correct).toBe(true);
      expect(report.questions[1].correct).toBe(false);
      // Cached ingest counter is well-formed (zero or more).
      expect(typeof report.cachedIngests).toBe('number');
      expect(report.cachedIngests).toBeGreaterThanOrEqual(0);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
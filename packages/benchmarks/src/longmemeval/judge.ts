/**
 * Answer and judge prompts for the LongMemEval slice.
 *
 * Templates are adapted from the public LongMemEval repository
 * (`evaluate_qa.py`); the README must call this out. We render the judge
 * template locally — no network calls — so the substitution is deterministic
 * and easy to test.
 */

import type { LmeQuestion } from './dataset';

const ANSWER_SYSTEM_PROMPT =
  'You are a helpful assistant with long-term memory of past conversations with the user. Answer the question using the memory below. If the memory does not contain the answer, say you don\'t know. Be concise.';

const JUDGE_SYSTEM_PROMPT = 'You are an evaluator. Answer yes or no only.';

/**
 * Build the (system, user) prompt pair sent to the model under test.
 *
 * `memoryContext` is the formatted retrieval bundle produced by the engine
 * (`formatContext(bundle, …)`); when empty we render `(empty)` so the model
 * sees the same shape it would see with a known-empty memory.
 */
export function buildAnswerPrompt(
  q: LmeQuestion,
  memoryContext: string,
): { systemPrompt: string; userPrompt: string } {
  const userPrompt =
    `Current date: ${q.question_date}\n\nMemory:\n${memoryContext || '(empty)'}\n\nQuestion: ${q.question}`;
  return { systemPrompt: ANSWER_SYSTEM_PROMPT, userPrompt };
}

const BASE = `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no.`;

/**
 * Per-question-type judge templates.
 *
 * Each template is a function of `{question}`, `{answer}`, and `{response}`;
 * `buildJudgePrompt` substitutes them with the corresponding field on the
 * question plus the model's free-form reply.
 *
 * Adapted from LongMemEval's `evaluate_qa.py`; see the package README.
 */
export const JUDGE_TEMPLATES: Record<LmeQuestion['question_type'], string> = {
  'single-session-user': `${BASE}\n\nQuestion: {question}\n\nCorrect Answer: {answer}\n\nModel Response: {response}\n\nIs the model response correct? Answer yes or no only.`,
  'single-session-assistant': `${BASE}\n\nQuestion: {question}\n\nCorrect Answer: {answer}\n\nModel Response: {response}\n\nIs the model response correct? Answer yes or no only.`,
  'multi-session': `${BASE}\n\nQuestion: {question}\n\nCorrect Answer: {answer}\n\nModel Response: {response}\n\nIs the model response correct? Answer yes or no only.`,
  'temporal-reasoning': `${BASE} In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct.\n\nQuestion: {question}\n\nCorrect Answer: {answer}\n\nModel Response: {response}\n\nIs the model response correct? Answer yes or no only.`,
  'knowledge-update': `${BASE} If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: {question}\n\nCorrect Answer: {answer}\n\nModel Response: {response}\n\nIs the model response correct? Answer yes or no only.`,
  'single-session-preference': `I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: {question}\n\nRubric: {answer}\n\nModel Response: {response}\n\nIs the model response correct? Answer yes or no only.`,
};

/**
 * Build the (system, user) prompt pair sent to the judge model. The user
 * prompt is the template for `q.question_type` with `{question}`, `{answer}`,
 * and `{response}` substituted.
 */
export function buildJudgePrompt(
  q: LmeQuestion,
  response: string,
): { systemPrompt: string; userPrompt: string } {
  const template = JUDGE_TEMPLATES[q.question_type];
  // One pass with a function replacer: values are inserted literally (no `$&`
  // / `$'` expansion) and never re-scanned for later placeholders.
  const values: Record<string, string> = { question: q.question, answer: q.answer, response };
  const userPrompt = template.replace(/\{(question|answer|response)\}/g, (_m, k: string) => values[k]);
  return { systemPrompt: JUDGE_SYSTEM_PROMPT, userPrompt };
}

/**
 * Parse a judge-model reply into a boolean verdict. We treat any reply whose
 * trimmed, lowercased form begins with `yes` as correct; everything else is
 * incorrect. The judge is asked to reply with "yes" or "no" only, but we are
 * tolerant of trailing punctuation and a leading affirmation.
 */
export function parseVerdict(text: string): boolean {
  if (typeof text !== 'string') {
    return false;
  }
  return text.trim().toLowerCase().startsWith('yes');
}
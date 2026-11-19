import { describe, expect, it } from 'vitest';
import { isConfigError, isContextOverflowError, isTruncationError } from '../../src/services/BoundedLlmCall';

// Real provider messages. Each must classify as overflow and as NEITHER
// truncation-shaped nor config-error-shaped by the pre-existing helpers.
const OVERFLOW_MESSAGES: string[] = [
  // OpenAI / vLLM: this prompt is too long (openai python SDK, 400 detail)
  "This model's maximum context length is 8192 tokens. However, you requested 10020 tokens (9000 in the messages, 1020 in the completion). Please reduce the length of the messages or completion.",
  // vLLM: dual-match (max_tokens wording + context clause) — the regex enforces both; locked as overflow per errata E2
  "max_tokens is too large: 4096 tokens. This model supports at most 8192 context length tokens.",
  // Anthropic: prompt is too long
  "prompt is too long: 210000 tokens > 200000 token maximum",
  // Anthropic alt phrasing
  "input length and `max_tokens` exceed context limit",
  // llama.cpp / llama-server
  "the request exceeds the available context size (2048 KiTokens, 2100 estimated)",
  // Gemini
  "The input token count (1204556) exceeds the maximum number of tokens allowed (1048576).",
  // Bedrock / generic
  "Input is too long for requested model.",
  // OpenAI error code style
  "Invalid request: context_length_exceeded. Reduce the number of tokens.",
];

const NOT_OVERFLOW: Array<[string, string]> = [
  ['transient 5xx', 'Internal server error, please retry'],
  ['auth failure', 'Invalid API key provided'],
  // response cut short mid-JSON: truncation-shaped, NOT input overflow
  ['truncated output', 'The response was truncated because it reached the token limit'],
  // request-config max_tokens: the caller asked for too much OUTPUT
  ['max_tokens config', "max_tokens: 1000000 exceeds the model's maximum output tokens"],
  ['validation wording', 'Invalid input length for field X'],
  // bare output-config error: no context clause, so the dual-match is NOT satisfied (errata E2)
  ['bare max_tokens too large', 'max_tokens is too large: 4096 tokens must be ≤ 4096'],
  ['parse error','Unexpected token < in JSON at position 0'],
  // 429 rate-limit bodies mentioning "input ... exceeds ... tokens": must NOT
  // classify as input overflow despite the token wording (Sonnet review minor).
  ['429 tokens-per-minute', 'Input exceeds the tokens-per-minute limit. Please retry after 30 seconds.'],
  ['429 rate limit body', 'Rate limit reached for model gpt-x: 429 Too Many Requests, tokens per min: 80000'],
];

describe('isContextOverflowError', () => {
  it('classifies every corpus overflow message as overflow', () => {
    for (const m of OVERFLOW_MESSAGES) {
      expect(isContextOverflowError(new Error(m)), m).toBe(true);
    }
  });
  it('corpus overflow messages are neither truncation- nor config-error-shaped (except the deliberate vLLM and Anthropic dual-matches)', () => {
    for (const m of OVERFLOW_MESSAGES) {
      // Deliberate dual-matches (mention max_tokens): overflow is checked first, so these classify as overflow.
      if (m.startsWith('max_tokens is too large') || m.startsWith('input length and `max_tokens`')) continue;
      expect(isTruncationError(new Error(m)), m).toBe(false);
      expect(isConfigError(new Error(m)), m).toBe(false);
    }
  });
  it('rejects non-overflow errors', () => {
    for (const [label, m] of NOT_OVERFLOW) {
      expect(isContextOverflowError(new Error(m)), label).toBe(false);
    }
  });
  it('handles non-Error throws and bare strings', () => {
    expect(isContextOverflowError(undefined)).toBe(false);
    // getErrorMessage's documented contract is "a string or an Error" — a
    // plain object stringifies as "[object Object]" and must NOT match.
    expect(isContextOverflowError({ message: 'prompt is too long' })).toBe(false);
    expect(isContextOverflowError('maximum context length exceeded')).toBe(true);
  });
});

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
  // llama.rn 0.12.9 (RNLlamaJSI.cpp:1114): prompt >= n_ctx with ctx_shift off
  "Context is full",
  "llama.rn: Context is full",
  "Error: context is FULL",
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
  ['context fully cached', 'The context is fully cached, retry later'],
  ['context fully loaded', 'Context is fully loaded'],
  ['disk full', 'Disk is full'],
  ['queue full', 'Request queue is full, retry later'],
  ['parse error','Unexpected token < in JSON at position 0'],
  // 429 rate-limit bodies mentioning "input ... exceeds ... tokens": must NOT
  // classify as input overflow despite the token wording (Sonnet review minor).
  ['429 tokens-per-minute', 'Input exceeds the tokens-per-minute limit. Please retry after 30 seconds.'],
  ['429 rate limit body', 'Rate limit reached for model gpt-x: 429 Too Many Requests, tokens per min: 80000'],
  // Blended 429 quota body: the overflow-shaped wording sits behind a rate-limit
  // status line, so the guard must win (Haiku max review, PR #428).
  ['429 mixed quota body', '429 Too Many Requests: input token count exceeds the per-minute quota'],
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

describe('rate-limit wording is transient (CodeRabbit minor, PR #428)', () => {
  // The two 429 bodies in NOT_OVERFLOW must fall through to call_error: they
  // are neither truncation- nor config-error-shaped, or runBatched would stamp
  // a cooldown on a transient rate limit.
  for (const [label, m] of NOT_OVERFLOW.filter(([l]) => l.startsWith('429'))) {
    it(`isContextOverflowError is false for: ${label}`, () => {
      expect(isContextOverflowError(new Error(m)), m).toBe(false);
    });
    it(`isTruncationError is false for: ${label}`, () => {
      expect(isTruncationError(new Error(m)), m).toBe(false);
    });
    it(`isConfigError is false for: ${label}`, () => {
      expect(isConfigError(new Error(m)), m).toBe(false);
    });
  }
});

describe('bare 429 in a message is not a rate limit (Haiku max review, PR #428)', () => {
  it('a message mentioning the token count 429 still classifies as truncation', () => {
    expect(isTruncationError(new Error('response truncated at 429 tokens'))).toBe(true);
  });
  it('a max_tokens config error whose value is 429 still classifies as config error', () => {
    expect(isConfigError(new Error('max_tokens: 429 exceeds the model limit'))).toBe(true);
  });
  it('a genuine 429 status line still matches RATE_LIMIT_PATTERN via HTTP context', () => {
    expect(isTruncationError(new Error('Error: status 429, tokens per min: 80000'))).toBe(false);
    expect(isConfigError(new Error('Error: status 429, tokens per min: 80000'))).toBe(false);
    expect(isContextOverflowError(new Error('Error: status 429, tokens per min: 80000'))).toBe(false);
  });
});

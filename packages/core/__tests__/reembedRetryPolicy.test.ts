import { describe, it, expect } from 'vitest';
import {
  classifyReembedRow,
  embedRetryDelayMs,
  MAX_EMBED_ATTEMPTS,
  EMBED_RETRY_BASE_MS,
  EMBED_RETRY_CAP_MS,
} from '../src/services/MaintenanceService';

describe('embedRetryDelayMs', () => {
  it('grows exponentially from the base', () => {
    expect(embedRetryDelayMs(1)).toBe(EMBED_RETRY_BASE_MS);
    expect(embedRetryDelayMs(2)).toBe(EMBED_RETRY_BASE_MS * 2);
    expect(embedRetryDelayMs(3)).toBe(EMBED_RETRY_BASE_MS * 4);
  });

  it('never exceeds the cap', () => {
    expect(embedRetryDelayMs(50)).toBe(EMBED_RETRY_CAP_MS);
  });

  it('treats a zero/absent attempt count as the base delay', () => {
    expect(embedRetryDelayMs(0)).toBe(EMBED_RETRY_BASE_MS);
  });
});

describe('classifyReembedRow', () => {
  const NOW = 1_000_000_000;

  it('attempts a row that has never failed', () => {
    expect(classifyReembedRow({}, NOW, false)).toBe('attempt');
    expect(classifyReembedRow(
      { embedding_failed_at: null, embedding_failure_kind: null, embedding_attempts: 0 },
      NOW, false,
    )).toBe('attempt');
  });

  it('defers a row still inside its backoff window', () => {
    expect(classifyReembedRow(
      { embedding_failed_at: NOW - 1000, embedding_failure_kind: 'provider_error', embedding_attempts: 1 },
      NOW, false,
    )).toBe('defer');
  });

  it('attempts a row whose backoff has elapsed', () => {
    expect(classifyReembedRow(
      { embedding_failed_at: NOW - EMBED_RETRY_BASE_MS - 1, embedding_failure_kind: 'provider_error', embedding_attempts: 1 },
      NOW, false,
    )).toBe('attempt');
  });

  it('permanently excludes float32_overflow regardless of age', () => {
    expect(classifyReembedRow(
      { embedding_failed_at: NOW - EMBED_RETRY_CAP_MS * 10, embedding_failure_kind: 'float32_overflow', embedding_attempts: 1 },
      NOW, false,
    )).toBe('permanent');
  });

  it('permanently excludes a row at the attempt ceiling', () => {
    expect(classifyReembedRow(
      { embedding_failed_at: NOW - EMBED_RETRY_CAP_MS * 10, embedding_failure_kind: 'provider_error', embedding_attempts: MAX_EMBED_ATTEMPTS },
      NOW, false,
    )).toBe('permanent');
  });

  it('force overrides both permanent rules and the backoff window', () => {
    expect(classifyReembedRow(
      { embedding_failed_at: NOW, embedding_failure_kind: 'float32_overflow', embedding_attempts: 99 },
      NOW, true,
    )).toBe('attempt');
  });
});

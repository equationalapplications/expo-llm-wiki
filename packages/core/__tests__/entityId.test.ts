import { describe, it, expect } from 'vitest';
import { assertEntityId } from '../src/utils/entityId';

describe('assertEntityId', () => {
  it('accepts a non-empty string up to 200 chars with no null bytes', () => {
    expect(() => assertEntityId('e1')).not.toThrow();
    expect(() => assertEntityId('x'.repeat(200))).not.toThrow();
  });

  it.each([
    ['empty', ''],
    ['too long', 'x'.repeat(201)],
    ['null byte', 'a\0b'],
    ['not a string', 42 as unknown as string],
    ['undefined', undefined as unknown as string],
  ])('rejects %s with the write() message', (_label, value) => {
    expect(() => assertEntityId(value)).toThrow(TypeError);
    expect(() => assertEntityId(value)).toThrow(
      `Invalid entityId: must be a non-empty string at most 200 chars with no null bytes; got ${JSON.stringify(value)}.`,
    );
  });
});

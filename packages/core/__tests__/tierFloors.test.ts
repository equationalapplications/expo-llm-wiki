import { describe, it, expect } from 'vitest';
import { validateTierFloors } from '../src/readOptions';
import { WikiInvalidReadOptions } from '../src/types';

const ids = ['a', 'b'];

describe('validateTierFloors', () => {
  it('returns undefined when tierFloors is undefined', () => {
    expect(validateTierFloors(ids, undefined, undefined, undefined, 10)).toBeUndefined();
  });

  it('returns integer floors for valid input', () => {
    expect(validateTierFloors(ids, { a: 3 }, undefined, undefined, 10)).toEqual({ a: 3 });
  });

  it('throws when floors sum above maxResults', () => {
    expect(() => validateTierFloors(ids, { a: 6, b: 6 }, undefined, undefined, 10))
      .toThrow(WikiInvalidReadOptions);
  });

  it('throws when maxResults is 0 and a positive floor is given', () => {
    expect(() => validateTierFloors(ids, { a: 1 }, undefined, undefined, 0))
      .toThrow(WikiInvalidReadOptions);
  });

  it('throws on a floor keyed to an entity not in entityIds', () => {
    try {
      validateTierFloors(ids, { typo: 2 }, undefined, undefined, 10);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WikiInvalidReadOptions);
      expect((err as WikiInvalidReadOptions).field).toBe('tierFloors');
      expect((err as WikiInvalidReadOptions).reason).toContain('typo');
    }
  });

  it('throws on a floor for a zero-weight entity when zero-weight entities are excluded', () => {
    expect(() => validateTierFloors(ids, { a: 2 }, { a: 0, b: 1 }, false, 10))
      .toThrow(WikiInvalidReadOptions);
  });

  it('allows a floor on a zero-weight entity when includeZeroWeightEntities is true', () => {
    expect(validateTierFloors(ids, { a: 2 }, { a: 0, b: 1 }, true, 10)).toEqual({ a: 2 });
  });

  it('clamps a negative floor to 0', () => {
    expect(validateTierFloors(ids, { a: -5 }, undefined, undefined, 10)).toEqual({ a: 0 });
  });

  it('truncates a non-integer floor', () => {
    expect(validateTierFloors(ids, { a: 2.7 }, undefined, undefined, 10)).toEqual({ a: 2 });
  });

  it('treats non-finite floors as absent', () => {
    expect(validateTierFloors(ids, { a: NaN, b: Infinity }, undefined, undefined, 10)).toEqual({});
  });

  it('retains a floor of 0 as a no-op', () => {
    expect(validateTierFloors(ids, { a: 0 }, undefined, undefined, 10)).toEqual({ a: 0 });
  });
});

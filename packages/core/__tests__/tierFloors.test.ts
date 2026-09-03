import { describe, it, expect } from 'vitest';
import { validateTierFloors, selectWithFloors } from '../src/readOptions';
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

  it('treats a non-finite floor on an unknown key as absent, not a typo throw', () => {
    // Regression: the documented sanitization rule (§4.2) is that non-finite
    // values are treated as absent. A typo'd key carrying NaN should fall
    // through cleanly, not surface as "typo is not one of the entity IDs".
    expect(validateTierFloors(ids, { typo: NaN }, undefined, undefined, 10)).toEqual({});
    expect(validateTierFloors(ids, { typo: Infinity }, undefined, undefined, 10)).toEqual({});
  });

  it('still throws for a finite floor keyed to an unknown entity', () => {
    // Sanity: the fix must not soften the typo-detection guard for finite values.
    expect(() => validateTierFloors(ids, { typo: 2 }, undefined, undefined, 10))
      .toThrow(WikiInvalidReadOptions);
  });

  it('retains a floor of 0 as a no-op', () => {
    expect(validateTierFloors(ids, { a: 0 }, undefined, undefined, 10)).toEqual({ a: 0 });
  });
});

type Row = { id: string; entity_id: string };

/** Rows in already-sorted rank order: 8 from `guidance`, then 4 from `codebase`. */
function starvedRows(): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < 8; i++) rows.push({ id: `g${i}`, entity_id: 'guidance' });
  for (let i = 0; i < 4; i++) rows.push({ id: `c${i}`, entity_id: 'codebase' });
  return rows;
}

describe('selectWithFloors', () => {
  it('is identical to slice() when no floors are given', () => {
    const rows = starvedRows();
    expect(selectWithFloors(rows, undefined, 5)).toEqual(rows.slice(0, 5));
    expect(selectWithFloors(rows, {}, 5)).toEqual(rows.slice(0, 5));
  });

  it('reserves slots the plain cut would have taken', () => {
    // Without a floor, the top 5 are all guidance and codebase is absent.
    const plain = selectWithFloors(starvedRows(), undefined, 5);
    expect(plain.filter(r => r.entity_id === 'codebase')).toHaveLength(0);

    const floored = selectWithFloors(starvedRows(), { codebase: 2 }, 5);
    expect(floored).toHaveLength(5);
    expect(floored.filter(r => r.entity_id === 'codebase')).toHaveLength(2);
    expect(floored.filter(r => r.entity_id === 'guidance')).toHaveLength(3);
  });

  it('returns results in global rank order, not floor-first', () => {
    const floored = selectWithFloors(starvedRows(), { codebase: 2 }, 5);
    expect(floored.map(r => r.id)).toEqual(['g0', 'g1', 'g2', 'c0', 'c1']);
  });

  it('contributes what exists when the floor exceeds available rows', () => {
    const floored = selectWithFloors(starvedRows(), { codebase: 99 }, 6);
    expect(floored.filter(r => r.entity_id === 'codebase')).toHaveLength(4);
    expect(floored).toHaveLength(6);
  });

  it('returns exactly the floors when they sum to maxResults', () => {
    const floored = selectWithFloors(starvedRows(), { guidance: 2, codebase: 2 }, 4);
    expect(floored.map(r => r.id)).toEqual(['g0', 'g1', 'c0', 'c1']);
  });

  it('treats a zero floor as a no-op', () => {
    const rows = starvedRows();
    expect(selectWithFloors(rows, { codebase: 0 }, 5)).toEqual(rows.slice(0, 5));
  });

  it('returns everything when maxResults exceeds the row count', () => {
    const rows = starvedRows();
    expect(selectWithFloors(rows, { codebase: 2 }, 100)).toEqual(rows);
  });

  it('returns an empty array when maxResults is 0', () => {
    expect(selectWithFloors(starvedRows(), undefined, 0)).toEqual([]);
  });
});

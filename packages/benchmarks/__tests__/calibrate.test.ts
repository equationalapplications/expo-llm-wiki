/**
 * Tests for the offline gate-threshold calibration command (Task 1 of
 * PR-D2).
 *
 * The hand-built fixture encodes the calibration contract:
 *   - two true duplicates (high cosine + matching titles)        ⇒ expected noop
 *   - one clearly-novel candidate (low cosine)                   ⇒ expected add
 *   - three ambiguous candidates in the "send to LLM" band:
 *       * one low (0.60)                                         ⇒ expected ambiguous
 *       * one mid (0.75)                                         ⇒ expected ambiguous
 *       * one high (0.96) with a contradicting (non-matching) title ⇒ expected ambiguous
 *
 * `recommendThresholds` must pick a `(novelThreshold, dupThreshold)` pair
 * that classifies every row correctly (0 misclassifications), with
 * `novelThreshold ∈ (0.20, 0.60]` and `dupThreshold ≤ 0.98`. Ties on
 * misclassification count are broken by the *largest* margin to the nearest
 * ambiguous row (prefer sending more rows to the LLM rather than silently
 * skipping them).
 *
 * Pure unit tests; no filesystem, network, or fastembed invocation.
 */

import { describe, it, expect } from 'vitest';

import { recommendThresholds, expectedClass, CalibrationRow, ExpectedClass } from '../src/calibrate';
import type { Scenario } from '../src/supersession/run';

/**
 * Hand-built fixture per Task 1 brief step 1. Two true duplicates with
 * matching titles, one novel add, three ambiguous (the third is a high
 * cosine with a non-matching title so `titlesMatch` fails the duplicate
 * gate and the row lands in the ambiguous band).
 */
function handBuiltRows(): CalibrationRow[] {
  return [
    // Two true duplicates — both pass the gate's noop rule:
    //   score >= dupThreshold AND titlesMatch (Jaccard >= FUZZY_THRESHOLD)
    { scenario: 'dup-1', candidate: 'User lives in Seattle', bestCosine: 0.99, titleJaccard: 1.0, expected: 'noop' as ExpectedClass },
    { scenario: 'dup-2', candidate: 'User lives in Seattle', bestCosine: 0.98, titleJaccard: 1.0, expected: 'noop' as ExpectedClass },
    // One clearly-novel candidate — score well below novelThreshold ⇒ add
    { scenario: 'add-1', candidate: 'User prefers swimming', bestCosine: 0.20, titleJaccard: 0.0, expected: 'add' as ExpectedClass },
    // Three ambiguous — scores between the band thresholds, so the gate
    // sends them to the LLM. The 0.96 row has a contradicting title so
    // titlesMatch fails and it cannot be classified as noop even though
    // the cosine is high.
    { scenario: 'amb-1', candidate: 'User likes hiking', bestCosine: 0.60, titleJaccard: 0.2, expected: 'ambiguous' as ExpectedClass },
    { scenario: 'amb-2', candidate: 'User prefers tea', bestCosine: 0.75, titleJaccard: 0.2, expected: 'ambiguous' as ExpectedClass },
    { scenario: 'amb-3', candidate: 'User moved to Berlin', bestCosine: 0.96, titleJaccard: 0.0, expected: 'ambiguous' as ExpectedClass },
  ];
}

describe('recommendThresholds (hand-built fixture)', () => {
  const rows = handBuiltRows();

  it('classifies every row correctly (zero misclassifications)', () => {
    const r = recommendThresholds(rows);
    expect(r.misclassifiedAtRecommended).toBe(0);
  });

  it('reports the default-rule misclassification count alongside the recommended one', () => {
    // Defaults in core are dupThreshold=0.97, novelThreshold=0.55; the
    // hand-built fixture is internally consistent with those defaults,
    // so the defaults row also has zero misclassifications. The contract
    // is that both fields exist and are non-negative integers.
    const r = recommendThresholds(rows);
    expect(r.misclassifiedAtDefaults).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(r.misclassifiedAtDefaults)).toBe(true);
  });

  it('picks a novelThreshold in (0.20, 0.60]', () => {
    const r = recommendThresholds(rows);
    expect(r.novelThreshold).toBeGreaterThan(0.20);
    expect(r.novelThreshold).toBeLessThanOrEqual(0.60);
  });

  it('picks a dupThreshold ≤ 0.98', () => {
    const r = recommendThresholds(rows);
    expect(r.dupThreshold).toBeLessThanOrEqual(0.98);
  });

  it('obeys the gate invariant novelThreshold <= dupThreshold', () => {
    const r = recommendThresholds(rows);
    expect(r.novelThreshold).toBeLessThanOrEqual(r.dupThreshold);
  });

  it('returns 0 misclassifications on an empty row set', () => {
    // Degenerate case: with no rows the band sweep trivially classifies
    // nothing wrong; the function should still return a valid pair.
    const r = recommendThresholds([]);
    expect(r.misclassifiedAtRecommended).toBe(0);
    expect(r.misclassifiedAtDefaults).toBe(0);
    expect(r.novelThreshold).toBeGreaterThanOrEqual(0.30);
    expect(r.novelThreshold).toBeLessThanOrEqual(0.90);
  });
});

describe('expectedClass (resolve null ⇒ gate decides alone)', () => {
  /**
   * Build a one-candidate scenario with the supplied `existing`,
   * `expectCurrentTitles`, and `expectSuperseded`. `resolve` defaults to
   * null; pass `{ resolve: { ops: [] } }` to flip it to "present".
   */
  function scenario(opts: {
    existing?: Array<{ id: string; title: string; body: string; source_type: 'user_stated' }>;
    events?: Array<{ summary: string }>;
    expectCurrentTitles?: string[];
    expectSuperseded?: string[];
    resolve?: Scenario['resolve'];
    name?: string;
  }): Scenario {
    return {
      name: opts.name ?? '__test__',
      existing: opts.existing ?? [],
      events: opts.events ?? [],
      extract: { facts: [], tasks: [] },
      resolve: opts.resolve === undefined ? null : opts.resolve,
      expectCurrentTitles: opts.expectCurrentTitles ?? [],
      expectSuperseded: opts.expectSuperseded ?? [],
    };
  }

  it('returns "ambiguous" when resolve is present (gate routed to LLM)', () => {
    const s = scenario({
      existing: [{ id: 'seattle', title: 'User lives in Seattle', body: 'b', source_type: 'user_stated' }],
      expectCurrentTitles: ['San Francisco'],
      resolve: { ops: [{ item: 0, op: 'SUPERSEDE', target: 'n1' }] },
    });
    expect(expectedClass(s, 0)).toBe('ambiguous');
  });

  it('returns "noop" when the candidate is a restatement (existing preserved + no new title)', () => {
    // job-5 shape: candidate "User is an engineer at Acme" matches existing
    // "User is an engineer at Acme"; expectCurrentTitles "engineer at Acme"
    // is a substring of the existing title.
    const s = scenario({
      existing: [{ id: 'engineer_dup', title: 'User is an engineer at Acme', body: 'b', source_type: 'user_stated' }],
      expectCurrentTitles: ['engineer at Acme'],
      expectSuperseded: [],
    });
    expect(expectedClass(s, 0)).toBe('noop');
  });

  it('returns "add" when some existing id is being superseded', () => {
    // relocation-1 shape (resolve set to null in this hypothetical): a
    // new SF fact supersedes the Seattle one.
    const s = scenario({
      existing: [{ id: 'seattle', title: 'User lives in Seattle', body: 'b', source_type: 'user_stated' }],
      expectCurrentTitles: ['San Francisco'],
      expectSuperseded: ['seattle'],
    });
    expect(expectedClass(s, 0)).toBe('add');
  });

  it('returns "add" when a brand-new title beyond existing is expected', () => {
    // Pure ADD shape: existing fact survives, but a new unrelated title is expected.
    const s = scenario({
      existing: [{ id: 'seattle', title: 'User lives in Seattle', body: 'b', source_type: 'user_stated' }],
      expectCurrentTitles: ['User likes swimming'],
      expectSuperseded: [],
    });
    expect(expectedClass(s, 0)).toBe('add');
  });
});

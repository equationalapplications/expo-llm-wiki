import { describe, expect, it } from 'vitest';
import { installDeterminism, withDeterminism } from '../src/determinism';
import { generateId } from '../../core/src/utils/ids';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('determinism harness', () => {
  it('clock steps forward', () => {
    const restore = installDeterminism({ startMs: 1000, stepMs: 5 });
    try {
      expect(Date.now()).toBe(1000);
      expect(Date.now()).toBe(1005);
      expect(new Date().getTime()).toBe(1010);
      const p1 = performance.now();
      const p2 = performance.now();
      expect(p2).toBeGreaterThan(p1);
      expect(new Date(0).getTime()).toBe(0);
      expect(new Date('2026-01-01T00:00:00Z').getTime()).toBe(Date.UTC(2026, 0, 1));
    } finally {
      restore();
    }
  });

  it('seeded ids are reproducible', () => {
    const draw = (seed: number) => {
      const restore = installDeterminism({ seed });
      try {
        const ids = Array.from({ length: 5 }, () => crypto.randomUUID());
        const bytes = new Uint8Array(8);
        crypto.getRandomValues(bytes);
        return { ids, bytes: Array.from(bytes) };
      } finally {
        restore();
      }
    };
    const a = draw(7);
    const b = draw(7);
    const c = draw(8);
    expect(a).toEqual(b);
    expect(c.ids).not.toEqual(a.ids);
    for (const id of a.ids) expect(id).toMatch(UUID_V4);
  });

  it('restore puts globals back', () => {
    const before = Date.now();
    const restore = installDeterminism({ startMs: 0 });
    expect(Date.now()).toBe(0);
    restore();
    expect(Math.abs(Date.now() - before)).toBeLessThan(1000);
    expect(new Date().getTime()).toBeGreaterThanOrEqual(before);
    const ids = new Set(Array.from({ length: 3 }, () => crypto.randomUUID()));
    expect(ids.size).toBe(3);
  });

  it('withDeterminism restores after a throw', async () => {
    const before = Date.now();
    await expect(withDeterminism({ startMs: 0 }, async () => {
      expect(Date.now()).toBe(0);
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(Math.abs(Date.now() - before)).toBeLessThan(1000);
  });

  it('core generateId is deterministic', async () => {
    const run = () => withDeterminism({ seed: 3 }, async () => [generateId('f_'), generateId('f_')]);
    const a = await run();
    const b = await run();
    expect(a).toEqual(b);
    expect(a[0]).not.toBe(a[1]);
  });
});

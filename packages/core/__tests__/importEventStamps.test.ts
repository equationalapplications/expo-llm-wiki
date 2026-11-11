import { describe, it, expect } from 'vitest';
import { planEventStamps, parseSourceWatermark } from '../src/services/importEventStamps';
import { START_OF_LOG_WATERMARK } from '../src/repositories/MetadataRepository';
import type { WikiEvent } from '../src/types';

const NOW = 1_700_000_000_000;
const FLOOR = NOW;
const WM = { at: 1_600_000_000_000, id: 'm' };
const ev = (id: string, created_at: unknown, extra: Record<string, unknown> = {}) =>
  ({ id, event_type: 't', summary: 's', created_at, ...extra }) as unknown as WikiEvent;
const ctx = (over: Record<string, unknown> = {}) => ({ now: NOW, floor: FLOOR, merge: true, localWm: WM, sourceWm: null, ...over }) as Parameters<typeof planEventStamps>[1];
const one = (e: WikiEvent, c = ctx()) => planEventStamps([e], c).get(e)!;

describe('planEventStamps', () => {
  it('re-stamps a future event and keeps its occurred_at', () => {
    const s = one(ev('a', NOW + 5000, { occurred_at: 123 }));
    expect(s).toEqual({ createdAt: FLOOR + 1, occurredAt: 123, reason: 'future' });
  });
  it('flags a past event behind localWm on merge', () => {
    const s = one(ev('a', WM.at - 10));
    expect(s).toEqual({ createdAt: FLOOR + 1, occurredAt: WM.at - 10, reason: 'behind_watermark' });
  });
  it('leaves it alone when merge is false', () => {
    expect(one(ev('a', WM.at - 10), ctx({ merge: false }))).toEqual({ createdAt: WM.at - 10, occurredAt: null, reason: null });
  });
  it('treats an event exactly at localWm as behind', () => {
    expect(one(ev('m', WM.at)).reason).toBe('behind_watermark');
  });
  it('treats the same at with a greater id as not behind', () => {
    expect(one(ev('z', WM.at)).reason).toBeNull();
  });
  it('does not flag an event at or before sourceWm', () => {
    const sourceWm = { at: WM.at - 5, id: 'k' };
    expect(one(ev('a', WM.at - 10), ctx({ sourceWm })).reason).toBeNull();
    expect(one(ev('k', WM.at - 5), ctx({ sourceWm })).reason).toBeNull();
  });
  it('flags an event after sourceWm', () => {
    const sourceWm = { at: WM.at - 20, id: 'k' };
    expect(one(ev('a', WM.at - 10), ctx({ sourceWm })).reason).toBe('behind_watermark');
  });
  it('ignores a localWm with at Infinity', () => {
    expect(one(ev('a', WM.at - 10), ctx({ localWm: { at: Infinity, id: '' } })).reason).toBeNull();
  });
  it('ignores a null localWm', () => {
    expect(one(ev('a', WM.at - 10), ctx({ localWm: null })).reason).toBeNull();
  });
  it.each([null, undefined, NaN, 'abc', '0x10', -Infinity, -9e15, -1e300, true, {}])('flags invalid created_at %s', (bad) => {
    const e = ev('a', bad, { occurred_at: 99 });
    const s = one(e);
    expect(s.reason).toBe('invalid');
    expect(Number.isFinite(s.createdAt)).toBe(true);
    expect(s.createdAt).toBe(FLOOR + 1);
    expect(s.occurredAt).toBe(99);
  });
  it('gives a future or invalid event with no occurred_at no occurredAt copy', () => {
    expect(one(ev('a', NOW + 5000)).occurredAt).toBeNull();
    expect(one(ev('b', 'abc')).occurredAt).toBeNull();
    expect(one(ev('c', null, { occurred_at: null })).occurredAt).toBeNull();
  });
  it('flags invalid occurred_at without re-stamping', () => {
    const s = one(ev('a', WM.at + 10, { occurred_at: 'abc' }));
    expect(s).toEqual({ createdAt: WM.at + 10, occurredAt: null, reason: 'invalid' });
  });
  it('copies created_at over an Infinity occurred_at when behind', () => {
    const s = one(ev('a', WM.at - 10, { occurred_at: Infinity }));
    expect(s.occurredAt).toBe(WM.at - 10);
    expect(s.reason).toBe('behind_watermark');
  });
  it('keeps a valid occurred_at when behind', () => {
    expect(one(ev('a', WM.at - 10, { occurred_at: 42 })).occurredAt).toBe(42);
  });
  it('does not copy a negative created_at into occurredAt', () => {
    const s = one(ev('a', -5000));
    expect(s.reason).toBe('behind_watermark');
    expect(s.occurredAt).toBeNull();
  });
  it('copies a numeric-string created_at as a number', () => {
    // now is raised so the decimal string is behind the watermark but not future.
    expect(one(ev('a', '1700000000000'), ctx({ now: NOW * 2, localWm: { at: 1.8e12, id: '' } })).occurredAt).toBe(1700000000000);
  });
  it('stamps invalid, then behind, then future, consecutively', () => {
    const events = [ev('f2', NOW + 2), ev('f1', NOW + 2), ev('b2', WM.at - 1), ev('b1', WM.at - 2), ev('i2', 'x'), ev('i1', null)];
    const p = planEventStamps(events, ctx());
    const order = [...events].sort((a, b) => p.get(a)!.createdAt - p.get(b)!.createdAt).map((e) => e.id);
    expect(order).toEqual(['i1', 'i2', 'b1', 'b2', 'f1', 'f2']);
    expect(order.map((id) => p.get(events.find((e) => e.id === id)!)!.createdAt)).toEqual([1, 2, 3, 4, 5, 6].map((n) => FLOOR + n));
  });
  it('throws RangeError near MAX_SAFE_INTEGER', () => {
    expect(() => one(ev('a', NOW + 1), ctx({ floor: Number.MAX_SAFE_INTEGER }))).toThrow(RangeError);
  });
});

describe('parseSourceWatermark', () => {
  it('accepts a valid watermark', () => {
    expect(parseSourceWatermark({ at: 5, id: 'x' })).toEqual({ at: 5, id: 'x' });
    expect(parseSourceWatermark(START_OF_LOG_WATERMARK)).toEqual(START_OF_LOG_WATERMARK);
  });
  it.each([{ at: '5', id: 'x' }, { at: NaN, id: 'x' }, { at: null, id: 'x' }, { at: 5, id: 3 }, null, []])('rejects %j', (bad) => {
    expect(parseSourceWatermark(bad)).toBeNull();
  });
});

import { describe, it, expect } from 'vitest';
import { deriveEventId, appendEventIdComment, parseEventIdComment } from '../src/index';
import { encodeEventIdInput } from '../src/event-id';

// Test vectors: specs/import-followups/spec.md §3.3 (also docs/okf-profile.md §7).
const VECTORS: Array<[string, string, string, string, number, string]> = [
  ['demo', '2026-07-05', 'observation', 'Linked to alpha', 0, 'evt_okf1_02dd42bf329719f258ab93b373f44506'],
  ['demo', '2026-07-05', 'decision', 'Chose path B', 0, 'evt_okf1_9a70e3a388247f9c27f96fc3855b3975'],
  ['demo', '2026-07-05', 'decision', 'Chose path B', 1, 'evt_okf1_549570648f50f8a88e414df0285d1de9'],
  ['other', '2026-07-05', 'decision', 'Chose path B', 0, 'evt_okf1_0a2faa6618933c9e9d106a5b164bab90'],
  ['user-123', '2023-11-14', 'observation', 'Café ☕ visit — see [docs]', 0, 'evt_okf1_bb987e1897dec93aec0ac282799ebc58'],
  ['', '2026-01-01', 'action', '', 0, 'evt_okf1_a24645f15c6bdc6a079fb283dfc059eb'],
];

describe('deriveEventId', () => {
  it.each(VECTORS)('vector %s %s %s %j #%i', (entityId, date, eventType, summary, occurrence, id) => {
    expect(deriveEventId({ entityId, date, eventType, summary, occurrence })).toBe(id);
  });

  it('encodes the first vector exactly as the spec shows', () => {
    const bytes = encodeEventIdInput({ entityId: 'demo', date: '2026-07-05', eventType: 'observation', summary: 'Linked to alpha', occurrence: 0 });
    expect(new TextDecoder().decode(bytes)).toBe('19:llm-wiki/event-id/1,4:demo,10:2026-07-05,11:observation,15:Linked to alpha,1:0,');
  });

  it('every id has the documented shape and survives an id comment', () => {
    for (const [entityId, date, eventType, summary, occurrence] of VECTORS) {
      const id = deriveEventId({ entityId, date, eventType, summary, occurrence });
      expect(id).toMatch(/^evt_okf1_[0-9a-f]{32}$/);
      expect(parseEventIdComment(appendEventIdComment('(observation) x', id))).toEqual({ text: '(observation) x', eventId: id });
    }
  });

  it('field boundaries cannot be shifted', () => {
    const base = { eventType: 'observation', summary: 's', occurrence: 0 };
    expect(deriveEventId({ ...base, entityId: 'a,1:b', date: 'd' })).not.toBe(deriveEventId({ ...base, entityId: 'a', date: 'b' }));
  });

  it('a lone surrogate in the summary hashes as U+FFFD', () => {
    const base = { entityId: 'demo', date: '2026-07-05', eventType: 'observation', occurrence: 0 };
    expect(deriveEventId({ ...base, summary: 'x\uD800' })).toBe(deriveEventId({ ...base, summary: 'x�' }));
  });

  it.each([-1, 1.5, NaN, Infinity])('occurrence %s throws a TypeError', (occurrence) => {
    expect(() => deriveEventId({ entityId: 'demo', date: '2026-07-05', eventType: 'observation', summary: 's', occurrence })).toThrow(TypeError);
  });
});

describe('createEventIdDeriver', () => {
  it('returns the same ids as deriveEventId for the spec vectors', async () => {
    const { createEventIdDeriver } = await import('../src/index');
    for (const [entityId, date, eventType, summary, occurrence, want] of VECTORS) {
      expect(createEventIdDeriver({ entityId, date, eventType, summary })(occurrence)).toBe(want);
    }
  });

  it('rejects a bad occurrence like deriveEventId', async () => {
    const { createEventIdDeriver } = await import('../src/index');
    const d = createEventIdDeriver({ entityId: 'e', date: '2026-01-01', eventType: 'observation', summary: 'x' });
    for (const bad of [-1, 1.5, NaN]) expect(() => d(bad)).toThrow(TypeError);
  });
});

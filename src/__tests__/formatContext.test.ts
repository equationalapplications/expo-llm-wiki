import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatContext } from '../utils/formatContext';
import type { MemoryBundle, WikiFact, WikiTask, WikiEvent } from '../types';

function makeFact(overrides: Partial<WikiFact> = {}): WikiFact {
  return {
    id: 'f1',
    entity_id: 'e1',
    title: 'A fact',
    body: 'Body text',
    tags: ['tag1'],
    confidence: 'certain',
    source_type: 'agent_inferred',
    source_hash: null,
    source_ref: null,
    created_at: 0,
    updated_at: Date.now(),
    last_accessed_at: null,
    access_count: 0,
    deleted_at: null,
    ...overrides,
  };
}

function makeTask(overrides: Partial<WikiTask> = {}): WikiTask {
  return {
    id: 't1',
    entity_id: 'e1',
    description: 'A task',
    status: 'pending',
    priority: 0,
    created_at: 0,
    updated_at: 0,
    resolved_at: null,
    deleted_at: null,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<WikiEvent> = {}): WikiEvent {
  return {
    id: 'ev1',
    entity_id: 'e1',
    event_type: 'observation',
    summary: 'Something happened',
    related_entry_id: null,
    created_at: new Date('2026-05-01T00:00:00Z').getTime(),
    ...overrides,
  };
}

const emptyBundle: MemoryBundle = { facts: [], tasks: [], events: [] };

describe('formatContext', () => {
  it('returns empty string for empty bundle', () => {
    const result = formatContext(emptyBundle);
    expect(result.trim()).toBe('');
  });

  it('produces markdown headers by default', () => {
    const bundle: MemoryBundle = {
      facts: [makeFact()],
      tasks: [],
      events: [],
    };
    const result = formatContext(bundle);
    expect(result).toContain('##');
    expect(result).toContain('A fact');
  });

  it('plain format contains no markdown headers or bold', () => {
    const bundle: MemoryBundle = {
      facts: [makeFact()],
      tasks: [makeTask()],
      events: [makeEvent()],
    };
    const result = formatContext(bundle, { format: 'plain' });
    expect(result).not.toMatch(/^#{1,6} /m);
    expect(result).not.toContain('**');
    expect(result).toContain('KNOWN FACTS:');
    expect(result).toContain('OPEN TASKS:');
    expect(result).toContain('RECENT EVENTS:');
  });

  it('plain format still contains fact title and body', () => {
    const bundle: MemoryBundle = {
      facts: [makeFact({ title: 'My Fact', body: 'My body' })],
      tasks: [],
      events: [],
    };
    const result = formatContext(bundle, { format: 'plain' });
    expect(result).toContain('My Fact');
    expect(result).toContain('My body');
  });

  it('respects maxFacts truncation', () => {
    const bundle: MemoryBundle = {
      facts: [
        makeFact({ id: 'f1', title: 'Fact 1' }),
        makeFact({ id: 'f2', title: 'Fact 2' }),
        makeFact({ id: 'f3', title: 'Fact 3' }),
      ],
      tasks: [],
      events: [],
    };
    const result = formatContext(bundle, { maxFacts: 2 });
    const matches = (result.match(/Fact \d/g) || []).length;
    expect(matches).toBe(2);
  });

  it('respects maxTasks truncation', () => {
    const bundle: MemoryBundle = {
      facts: [],
      tasks: [
        makeTask({ id: 't1', description: 'Task 1' }),
        makeTask({ id: 't2', description: 'Task 2' }),
        makeTask({ id: 't3', description: 'Task 3' }),
      ],
      events: [],
    };
    const result = formatContext(bundle, { maxTasks: 1 });
    const matches = (result.match(/Task \d/g) || []).length;
    expect(matches).toBe(1);
  });

  it('respects maxEvents truncation', () => {
    const bundle: MemoryBundle = {
      facts: [],
      tasks: [],
      events: [
        makeEvent({ id: 'ev1', summary: 'Event 1' }),
        makeEvent({ id: 'ev2', summary: 'Event 2' }),
        makeEvent({ id: 'ev3', summary: 'Event 3' }),
      ],
    };
    const result = formatContext(bundle, { maxEvents: 2 });
    const matches = (result.match(/Event \d/g) || []).length;
    expect(matches).toBe(2);
  });

  it('includeConfidence=false omits confidence labels', () => {
    const bundle: MemoryBundle = {
      facts: [makeFact({ confidence: 'tentative' })],
      tasks: [],
      events: [],
    };
    const withConf = formatContext(bundle, { includeConfidence: true });
    const withoutConf = formatContext(bundle, { includeConfidence: false });
    expect(withConf).toContain('tentative');
    expect(withoutConf).not.toContain('tentative');
  });

  it('includeTags=false omits tag labels', () => {
    const bundle: MemoryBundle = {
      facts: [makeFact({ tags: ['alpha', 'beta'] })],
      tasks: [],
      events: [],
    };
    const withTags = formatContext(bundle, { includeTags: true });
    const withoutTags = formatContext(bundle, { includeTags: false });
    expect(withTags).toContain('alpha');
    expect(withoutTags).not.toContain('alpha');
  });

  it('ranks certain above inferred above tentative', () => {
    const now = Date.now();
    const bundle: MemoryBundle = {
      facts: [
        makeFact({ id: 'f1', title: 'Tentative fact', confidence: 'tentative', updated_at: now, access_count: 0 }),
        makeFact({ id: 'f2', title: 'Certain fact', confidence: 'certain', updated_at: now, access_count: 0 }),
        makeFact({ id: 'f3', title: 'Inferred fact', confidence: 'inferred', updated_at: now, access_count: 0 }),
      ],
      tasks: [],
      events: [],
    };
    const result = formatContext(bundle);
    const certIdx = result.indexOf('Certain fact');
    const infIdx = result.indexOf('Inferred fact');
    const tentIdx = result.indexOf('Tentative fact');
    expect(certIdx).toBeLessThan(infIdx);
    expect(infIdx).toBeLessThan(tentIdx);
  });

  it('recency: fresher fact ranks above stale fact of same confidence', () => {
    const now = Date.now();
    const bundle: MemoryBundle = {
      facts: [
        makeFact({ id: 'f1', title: 'Stale fact', confidence: 'certain', updated_at: now - 90 * 86400000, access_count: 0 }),
        makeFact({ id: 'f2', title: 'Fresh fact', confidence: 'certain', updated_at: now, access_count: 0 }),
      ],
      tasks: [],
      events: [],
    };
    const result = formatContext(bundle);
    expect(result.indexOf('Fresh fact')).toBeLessThan(result.indexOf('Stale fact'));
  });

  it('events render newest-first', () => {
    const bundle: MemoryBundle = {
      facts: [],
      tasks: [],
      events: [
        makeEvent({ id: 'ev1', summary: 'Old event', created_at: 1000 }),
        makeEvent({ id: 'ev2', summary: 'New event', created_at: 9000 }),
      ],
    };
    const result = formatContext(bundle);
    expect(result.indexOf('New event')).toBeLessThan(result.indexOf('Old event'));
  });

  it('tasks render by priority DESC, created_at ASC', () => {
    const bundle: MemoryBundle = {
      facts: [],
      tasks: [
        makeTask({ id: 't1', description: 'Low priority', priority: 1, created_at: 100 }),
        makeTask({ id: 't2', description: 'High priority', priority: 10, created_at: 200 }),
        makeTask({ id: 't3', description: 'High priority early', priority: 10, created_at: 100 }),
      ],
      events: [],
    };
    const result = formatContext(bundle);
    const hp1 = result.indexOf('High priority early');
    const hp2 = result.indexOf('High priority (');  // match 'High priority (pending)', not 'High priority early'
    const lp = result.indexOf('Low priority');
    expect(hp1).toBeLessThan(hp2);
    expect(hp2).toBeLessThan(lp);
  });

  it('custom weight overrides change ranking', () => {
    const now = Date.now();
    // With accessCount weight = 10, a high-access inferred fact beats a certain fact
    const bundle: MemoryBundle = {
      facts: [
        makeFact({ id: 'f1', title: 'Certain low-access', confidence: 'certain', access_count: 0, updated_at: now }),
        makeFact({ id: 'f2', title: 'Inferred high-access', confidence: 'inferred', access_count: 100, updated_at: now }),
      ],
      tasks: [],
      events: [],
    };
    const result = formatContext(bundle, { factWeights: { confidence: 1.0, accessCount: 10, recency: 0.5 } });
    expect(result.indexOf('Inferred high-access')).toBeLessThan(result.indexOf('Certain low-access'));
  });
});

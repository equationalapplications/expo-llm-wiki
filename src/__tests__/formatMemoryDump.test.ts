import { describe, it, expect } from 'vitest';
import { formatMemoryDump } from '../utils/formatMemoryDump';
import type { MemoryDump } from '../types';

describe('formatMemoryDump', () => {
  it('handles empty dump', () => {
    const r = formatMemoryDump({ generatedAt: 0, entities: {} });
    expect(r.files).toHaveLength(0);
    expect(JSON.parse(r.manifest).entities).toEqual({});
  });

  it('produces one file per entity', () => {
    const dump: MemoryDump = {
      generatedAt: 1000000,
      entities: {
        e1: {
          facts: [{
            id: 'f1', entity_id: 'e1', title: 'Fact A', body: 'body text', tags: ['tag1'],
            confidence: 'certain', source_type: 'user_document', source_hash: null,
            source_ref: 'doc.pdf', created_at: 1000, updated_at: 1000,
            last_accessed_at: null, access_count: 0, deleted_at: null,
          }],
          tasks: [{
            id: 't1', entity_id: 'e1', description: 'do x', status: 'pending',
            priority: 5, created_at: 1000, updated_at: 1000, resolved_at: null, deleted_at: null,
          }],
          events: [],
        },
        e2: { facts: [], tasks: [], events: [] },
      },
    };
    const r = formatMemoryDump(dump);
    expect(r.files).toHaveLength(2);
    expect(r.files.find(f => f.name === 'e1.md')?.content).toContain('Fact A');
    expect(r.files.find(f => f.name === 'e1.md')?.content).toContain('- [ ] do x');
    expect(r.files.find(f => f.name === 'e2.md')).toBeDefined();
  });

  it('manifest is valid JSON with entities', () => {
    const dump: MemoryDump = { generatedAt: 0, entities: { x: { facts: [], tasks: [], events: [] } } };
    const r = formatMemoryDump(dump);
    const parsed = JSON.parse(r.manifest);
    expect(parsed.entities).toHaveProperty('x');
  });

  it('renders done tasks with [x]', () => {
    const dump: MemoryDump = {
      generatedAt: 0,
      entities: {
        e: {
          facts: [],
          tasks: [{ id: 't', entity_id: 'e', description: 'done task', status: 'done', priority: 0, created_at: 0, updated_at: 0, resolved_at: null, deleted_at: null }],
          events: [],
        },
      },
    };
    const r = formatMemoryDump(dump);
    expect(r.files[0].content).toContain('- [x] done task');
  });

  it('renders events with timestamp and type', () => {
    const dump: MemoryDump = {
      generatedAt: 0,
      entities: {
        e: {
          facts: [],
          tasks: [],
          events: [{ id: 'ev1', entity_id: 'e', event_type: 'observation', summary: 'something happened', created_at: 0 }],
        },
      },
    };
    const r = formatMemoryDump(dump);
    expect(r.files[0].content).toContain('(observation)');
    expect(r.files[0].content).toContain('something happened');
  });
});

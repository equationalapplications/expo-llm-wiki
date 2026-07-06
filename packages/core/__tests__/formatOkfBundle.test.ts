import { describe, it, expect } from 'vitest';
import { formatOkfBundle } from '../src/utils/formatOkfBundle';
import type { MemoryDump, WikiFact, WikiTask, WikiEvent } from '../src/types';

function makeFact(overrides: Partial<WikiFact> = {}): WikiFact {
  return {
    id: 'fact_aaa',
    entity_id: 'alice',
    title: 'Likes coffee',
    body: 'Alice drinks coffee every morning.',
    tags: ['preference', 'drink'],
    confidence: 'certain',
    source_type: 'user_stated',
    source_hash: null,
    source_ref: 'chat-2026-01-01',
    created_at: 1700000000000,
    updated_at: 1700000100000,
    embedding_blob: new Uint8Array([0, 0, 128, 63]),
    last_accessed_at: 1700000200000,
    access_count: 3,
    deleted_at: null,
    ...overrides,
  };
}

function makeTask(overrides: Partial<WikiTask> = {}): WikiTask {
  return {
    id: 'task_bbb',
    entity_id: 'alice',
    description: 'Order more coffee beans',
    status: 'pending',
    priority: 2,
    created_at: 1700000300000,
    updated_at: 1700000400000,
    resolved_at: null,
    deleted_at: null,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<WikiEvent> = {}): WikiEvent {
  return {
    id: 'evt_ccc',
    entity_id: 'alice',
    event_type: 'observation',
    summary: 'Alice mentioned coffee',
    related_entry_id: null,
    created_at: 1700000500000,
    ...overrides,
  };
}

describe('formatOkfBundle', () => {
  it('produces no files for an empty dump except the root index.md', () => {
    const { files } = formatOkfBundle({ generatedAt: 0, entities: {} });
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('index.md');
    expect(files[0].content).toBe('---\nokf_version: "0.1"\nprofile: llm-wiki/1\n---\n\n');
  });

  it('writes one concept file per fact with correct path and excludes embedding_blob', () => {
    const dump: MemoryDump = {
      generatedAt: 0,
      entities: { alice: { facts: [makeFact()], tasks: [], events: [], edges: [] } },
    };
    const { files } = formatOkfBundle(dump);
    const factFile = files.find(f => f.path === 'entities/alice/facts/fact_aaa.md');
    expect(factFile).toBeDefined();
    expect(factFile!.content).not.toContain('embedding_blob');
    expect(factFile!.content).toContain('type: fact');
    expect(factFile!.content).toContain('title: Likes coffee');
    expect(factFile!.content).toContain('timestamp: 2023-11-14T22:15:00.000Z');
    expect(factFile!.content).toContain('resource: chat-2026-01-01');
    expect(factFile!.content).toContain('id: fact_aaa');
    expect(factFile!.content).toContain('entity_id: alice');
    expect(factFile!.content).toContain('confidence: certain');
    expect(factFile!.content).toContain('source_type: user_stated');
    expect(factFile!.content).toContain('access_count: 3');
    expect(factFile!.content).toContain('Alice drinks coffee every morning.');
  });

  it('omits the resource key when source_ref is null', () => {
    const dump: MemoryDump = {
      generatedAt: 0,
      entities: { alice: { facts: [makeFact({ source_ref: null })], tasks: [], events: [], edges: [] } },
    };
    const { files } = formatOkfBundle(dump);
    const factFile = files.find(f => f.path === 'entities/alice/facts/fact_aaa.md')!;
    expect(factFile.content).not.toContain('resource:');
  });

  it('writes one concept file per task with description as title and empty body', () => {
    const dump: MemoryDump = {
      generatedAt: 0,
      entities: { alice: { facts: [], tasks: [makeTask()], events: [], edges: [] } },
    };
    const { files } = formatOkfBundle(dump);
    const taskFile = files.find(f => f.path === 'entities/alice/tasks/task_bbb.md');
    expect(taskFile).toBeDefined();
    expect(taskFile!.content).toBe(
      '---\ntype: task\ntitle: Order more coffee beans\ntimestamp: 2023-11-14T22:20:00.000Z\nid: task_bbb\nentity_id: alice\nstatus: pending\npriority: 2\ncreated_at: 1700000300000\nresolved_at: null\ndeleted_at: null\n---\n\n'
    );
  });

  it('links a log entry to its referenced fact when related_entry_id matches an exported fact', () => {
    const dump: MemoryDump = {
      generatedAt: 0,
      entities: {
        alice: {
          facts: [makeFact()],
          tasks: [],
          events: [makeEvent({ related_entry_id: 'fact_aaa', summary: 'Confirmed coffee preference' })],
          edges: [],
        },
      },
    };
    const { files } = formatOkfBundle(dump);
    const logFile = files.find(f => f.path === 'entities/alice/log.md')!;
    expect(logFile.content).toContain('[Confirmed coffee preference](./facts/fact_aaa.md)');
  });

  it('renders a plain summary when related_entry_id does not match an exported fact', () => {
    const dump: MemoryDump = {
      generatedAt: 0,
      entities: {
        alice: {
          facts: [],
          tasks: [],
          events: [makeEvent({ related_entry_id: 'fact_missing', summary: 'Unlinked event' })],
          edges: [],
        },
      },
    };
    const { files } = formatOkfBundle(dump);
    const logFile = files.find(f => f.path === 'entities/alice/log.md')!;
    expect(logFile.content).toContain('(observation) Unlinked event');
    expect(logFile.content).not.toContain('[Unlinked event]');
  });

  it('builds an entity index.md linking to facts, tasks, and the log', () => {
    const dump: MemoryDump = {
      generatedAt: 0,
      entities: { alice: { facts: [makeFact()], tasks: [makeTask()], events: [], edges: [] } },
    };
    const { files } = formatOkfBundle(dump);
    const entityIndex = files.find(f => f.path === 'entities/alice/index.md')!;
    expect(entityIndex.content).toContain('## Facts');
    expect(entityIndex.content).toContain('* [Likes coffee](facts/fact_aaa.md)');
    expect(entityIndex.content).toContain('## Tasks');
    expect(entityIndex.content).toContain('* [Order more coffee beans](tasks/task_bbb.md)');
    expect(entityIndex.content).toContain('[Event log](./log.md)');
  });

  it('builds a root index.md linking to every entity index', () => {
    const dump: MemoryDump = {
      generatedAt: 0,
      entities: {
        alice: { facts: [], tasks: [], events: [], edges: [] },
        bob: { facts: [], tasks: [], events: [], edges: [] },
      },
    };
    const { files } = formatOkfBundle(dump);
    const rootIndex = files.find(f => f.path === 'index.md')!;
    expect(rootIndex.content).toContain('* [alice](entities/alice/index.md)');
    expect(rootIndex.content).toContain('* [bob](entities/bob/index.md)');
  });

  it('avoids reserved concept filenames and sanitizes unsafe fact/task ids', () => {
    const dump: MemoryDump = {
      generatedAt: 0,
      entities: {
        index: {
          facts: [makeFact({ id: 'index', entity_id: 'index' })],
          tasks: [makeTask({ id: 'log', entity_id: 'index' })],
          events: [], edges: [],
        },
      },
    };
    const { files } = formatOkfBundle(dump);
    const paths = files.map(f => f.path);
    const conceptPaths = paths.filter(p => p.includes('/facts/') || p.includes('/tasks/'));
    expect(conceptPaths.every(p => !p.endsWith('/facts/index.md') && !p.endsWith('/tasks/log.md'))).toBe(true);
    expect(conceptPaths.some(p => /\/facts\/index-[0-9a-f]{16}\.md$/.test(p))).toBe(true);
    expect(conceptPaths.some(p => /\/tasks\/log-[0-9a-f]{16}\.md$/.test(p))).toBe(true);
    expect(paths).toContain('entities/index/index.md');
    expect(paths).toContain('entities/index/log.md');
    expect(paths).toContain('index.md');
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('sanitizes fact ids containing path separators', () => {
    const dump: MemoryDump = {
      generatedAt: 0,
      entities: {
        alice: {
          facts: [makeFact({ id: '../escape', entity_id: 'alice' })],
          tasks: [],
          events: [], edges: [],
        },
      },
    };
    const { files } = formatOkfBundle(dump);
    const factFile = files.find(f => f.path.startsWith('entities/alice/facts/'))!;
    expect(factFile.path).toMatch(/^entities\/alice\/facts\/escape-[0-9a-f]{16}\.md$/);
    expect(factFile.path).not.toContain('..');
  });

  it('preserves a fact\'s okf_type instead of hardcoding "fact"', () => {
    const dump: MemoryDump = {
      generatedAt: 0,
      entities: { alice: { facts: [makeFact({ okf_type: 'meeting_note' })], tasks: [], events: [], edges: [] } },
    };
    const { files } = formatOkfBundle(dump);
    const factFile = files.find(f => f.path === 'entities/alice/facts/fact_aaa.md')!;
    expect(factFile.content).toContain('type: meeting_note');
    expect(factFile.content).not.toContain('type: fact');
  });

  it('falls back to "fact" type when okf_type is absent', () => {
    const dump: MemoryDump = {
      generatedAt: 0,
      entities: { alice: { facts: [makeFact()], tasks: [], events: [], edges: [] } },
    };
    const { files } = formatOkfBundle(dump);
    const factFile = files.find(f => f.path === 'entities/alice/facts/fact_aaa.md')!;
    expect(factFile.content).toContain('type: fact');
  });

  it('preserves a task\'s okf_type instead of hardcoding "task"', () => {
    const dump: MemoryDump = {
      generatedAt: 0,
      entities: { alice: { facts: [], tasks: [makeTask({ okf_type: 'todo_item' })], events: [], edges: [] } },
    };
    const { files } = formatOkfBundle(dump);
    const taskFile = files.find(f => f.path === 'entities/alice/tasks/task_bbb.md')!;
    expect(taskFile.content).toContain('type: todo_item');
  });

  it('falls back to "task" type when okf_type is absent', () => {
    const dump: MemoryDump = {
      generatedAt: 0,
      entities: { alice: { facts: [], tasks: [makeTask()], events: [], edges: [] } },
    };
    const { files } = formatOkfBundle(dump);
    const taskFile = files.find(f => f.path === 'entities/alice/tasks/task_bbb.md')!;
    expect(taskFile.content).toContain('type: task');
  });

  it('emits profile: llm-wiki/1 on root index.md', () => {
    const { files } = formatOkfBundle({ generatedAt: 0, entities: {} });
    expect(files[0].content).toContain('profile: llm-wiki/1');
  });

  it('emits entity summary prose in entity index.md', () => {
    const dump: MemoryDump = {
      generatedAt: 0,
      entities: {
        alice: { summary: 'Alice loves coffee.', facts: [], tasks: [], events: [], edges: [] },
      },
    };
    const entityIndex = formatOkfBundle(dump).files.find(f => f.path === 'entities/alice/index.md')!;
    expect(entityIndex.content.startsWith('Alice loves coffee.\n\n')).toBe(true);
  });

  it('preserves edges array order in ## Related bullets for a single source concept', () => {
    const dump: MemoryDump = {
      generatedAt: 0,
      entities: {
        alice: {
          facts: [
            makeFact({ id: 'fact_a', body: 'Source fact.' }),
            makeFact({ id: 'fact_b', title: 'Beta', body: 'Beta body.' }),
          ],
          tasks: [makeTask({ id: 'task_c' })],
          events: [],
          edges: [
            {
              id: 'edge_1',
              entity_id: 'alice',
              source_id: 'fact_a',
              target_id: 'fact_b',
              edge_type: 'references',
              created_at: 0,
            },
            {
              id: 'edge_2',
              entity_id: 'alice',
              source_id: 'fact_a',
              target_id: 'task_c',
              edge_type: 'blocks',
              created_at: 0,
            },
          ],
        },
      },
    };
    const factA = formatOkfBundle(dump).files.find(f => f.path === 'entities/alice/facts/fact_a.md')!;
    const relatedSection = factA.content.slice(factA.content.indexOf('## Related'));
    const referencesIdx = relatedSection.indexOf('- [references]');
    const blocksIdx = relatedSection.indexOf('- [blocks]');
    expect(referencesIdx).toBeGreaterThan(-1);
    expect(blocksIdx).toBeGreaterThan(-1);
    expect(referencesIdx).toBeLessThan(blocksIdx);
  });

  it('emits ## Related from edges array, not inline body links', () => {
    const dump: MemoryDump = {
      generatedAt: 0,
      entities: {
        alice: {
          facts: [
            makeFact({ id: 'fact_a', body: 'Plain body without links.' }),
            makeFact({ id: 'fact_b', title: 'Target', body: 'Target body.' }),
          ],
          tasks: [makeTask({ id: 'task_c' })],
          events: [],
          edges: [
            {
              id: 'edge_1',
              entity_id: 'alice',
              source_id: 'fact_a',
              target_id: 'fact_b',
              edge_type: 'mentions',
              created_at: 0,
            },
            {
              id: 'edge_2',
              entity_id: 'alice',
              source_id: 'fact_a',
              target_id: 'task_c',
              edge_type: 'blocks',
              created_at: 0,
            },
          ],
        },
      },
    };
    const factA = formatOkfBundle(dump).files.find(f => f.path === 'entities/alice/facts/fact_a.md')!;
    expect(factA.content).toContain('Plain body without links.');
    expect(factA.content).toContain('## Related');
    expect(factA.content).toContain('- [mentions](./fact_b.md)');
    expect(factA.content).toContain('- [blocks](../tasks/task_c.md)');
  });

  it('appends event id comments to log lines', () => {
    const dump: MemoryDump = {
      generatedAt: 0,
      entities: {
        alice: {
          facts: [makeFact()],
          tasks: [],
          events: [makeEvent({ id: 'evt_ccc', related_entry_id: 'fact_aaa' })],
          edges: [],
        },
      },
    };
    const logFile = formatOkfBundle(dump).files.find(f => f.path === 'entities/alice/log.md')!;
    expect(logFile.content).toContain('<!-- id: evt_ccc -->');
  });
});

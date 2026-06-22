import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildConceptDocument, buildLogMd } from '@equationalapplications/core-okf';
import type { OkfFile, OkfFrontmatter } from '@equationalapplications/core-okf';
import { parseOkfBundle } from '../src/utils/parseOkfBundle';
import { formatOkfBundle } from '../src/utils/formatOkfBundle';
import type { MemoryDump, WikiFact, WikiTask, WikiEvent } from '../src/types';
import * as ids from '../src/utils/ids';

const FIXED_NOW = 1_700_000_000_000;

function conceptFile(path: string, fm: OkfFrontmatter, body = ''): OkfFile {
  return { path, content: buildConceptDocument(fm, body) };
}

function makeFact(overrides: Partial<WikiFact> = {}): WikiFact {
  return {
    id: 'fact_aaa',
    entity_id: 'alice',
    title: 'Likes coffee',
    body: 'See [related](./facts/fact_bbb.md).',
    tags: ['preference'],
    confidence: 'certain',
    source_type: 'user_stated',
    source_hash: null,
    source_ref: null,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_010_000,
    last_accessed_at: null,
    access_count: 0,
    deleted_at: null,
    ...overrides,
  };
}

function makeTask(overrides: Partial<WikiTask> = {}): WikiTask {
  return {
    id: 'task_bbb',
    entity_id: 'alice',
    description: 'Order beans',
    status: 'pending',
    priority: 1,
    created_at: 1_700_000_020_000,
    updated_at: 1_700_000_030_000,
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
    summary: 'Noted preference',
    related_entry_id: 'fact_aaa',
    created_at: 1_700_000_040_000,
    ...overrides,
  };
}

describe('parseOkfBundle', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
    vi.spyOn(ids, 'generateId').mockImplementation((prefix = '') => `${prefix}generated`);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('routing precedence', () => {
    it('routes via typeMapping over directory convention', () => {
      const files: OkfFile[] = [
        conceptFile('entities/alice/facts/custom.md', { type: 'meeting_note', title: 'M', id: 'fact_custom' }),
      ];
      const dump = parseOkfBundle('alice', files, {
        typeMapping: { meeting_note: 'task' },
      });
      const bundle = dump.entities.alice;
      expect(bundle.tasks).toHaveLength(1);
      expect(bundle.facts).toHaveLength(0);
      expect(bundle.tasks[0].id).toBe('fact_custom');
    });

    it('routes via /facts/ directory when typeMapping has no entry', () => {
      const files: OkfFile[] = [
        conceptFile('entities/alice/facts/x.md', { type: 'note', title: 'N', id: 'fact_x' }),
      ];
      const dump = parseOkfBundle('alice', files);
      expect(dump.entities.alice.facts).toHaveLength(1);
      expect(dump.entities.alice.tasks).toHaveLength(0);
    });

    it('routes via /tasks/ directory when typeMapping has no entry', () => {
      const files: OkfFile[] = [
        conceptFile('entities/alice/tasks/x.md', { type: 'note', title: 'T', id: 'task_x' }),
      ];
      const dump = parseOkfBundle('alice', files);
      expect(dump.entities.alice.tasks).toHaveLength(1);
      expect(dump.entities.alice.facts).toHaveLength(0);
    });

    it('falls back to defaultSchema when neither typeMapping nor directory applies', () => {
      const files: OkfFile[] = [
        conceptFile('entities/alice/concepts/x.md', { type: 'note', title: 'C', id: 'concept_x' }),
      ];
      const dump = parseOkfBundle('alice', files, { defaultSchema: 'task' });
      expect(dump.entities.alice.tasks).toHaveLength(1);
      expect(dump.entities.alice.facts).toHaveLength(0);
    });

    it('defaults to fact when no mapping, directory, or defaultSchema is set', () => {
      const files: OkfFile[] = [
        conceptFile('entities/alice/concepts/x.md', { type: 'note', title: 'C', id: 'concept_x' }),
      ];
      const dump = parseOkfBundle('alice', files);
      expect(dump.entities.alice.facts).toHaveLength(1);
    });

    it('skips a concept entirely when routing resolves to ignore', () => {
      const files: OkfFile[] = [
        conceptFile('entities/alice/facts/skip.md', { type: 'noise', title: 'S', id: 'fact_skip' }),
        conceptFile('entities/alice/facts/keep.md', { type: 'fact', title: 'K', id: 'fact_keep' }),
      ];
      const dump = parseOkfBundle('alice', files, { typeMapping: { noise: 'ignore' } });
      expect(dump.entities.alice.facts.map(f => f.id)).toEqual(['fact_keep']);
    });

    it('does not resolve edges to concepts routed to ignore', () => {
      const files: OkfFile[] = [
        conceptFile(
          'entities/alice/facts/keep.md',
          { type: 'fact', title: 'K', id: 'fact_keep' },
          'See [noise](./skip.md).',
        ),
        conceptFile('entities/alice/facts/skip.md', { type: 'noise', title: 'S', id: 'fact_skip' }),
      ];
      const dump = parseOkfBundle('alice', files, { typeMapping: { noise: 'ignore' } });
      expect(dump.entities.alice.edges).toEqual([]);
    });

    it('does not treat inherited object keys as typeMapping entries', () => {
      const files: OkfFile[] = [
        conceptFile('entities/alice/concepts/x.md', { type: 'toString', title: 'C', id: 'concept_x' }),
      ];
      const dump = parseOkfBundle('alice', files, { typeMapping: {} });
      expect(dump.entities.alice.facts).toHaveLength(1);
      expect(dump.entities.alice.tasks).toHaveLength(0);
    });

    it('ignores index.md and log.md during concept parsing', () => {
      const files: OkfFile[] = [
        { path: 'entities/alice/index.md', content: '# Index\n' },
        { path: 'entities/alice/log.md', content: buildLogMd([]) },
        conceptFile('entities/alice/facts/only.md', { type: 'fact', title: 'O', id: 'fact_only' }),
      ];
      const dump = parseOkfBundle('alice', files);
      expect(dump.entities.alice.facts).toHaveLength(1);
    });
  });
});

describe('parseOkfBundle — field mapping', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
    vi.spyOn(ids, 'generateId').mockImplementation((prefix = '') => `${prefix}generated`);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('preserves arbitrary third-party okf_type strings verbatim', () => {
    const files: OkfFile[] = [
      conceptFile('entities/alice/facts/x.md', {
        type: 'meeting_note',
        title: 'Standup',
        id: 'fact_x',
      }),
    ];
    const dump = parseOkfBundle('alice', files);
    expect(dump.entities.alice.facts[0].okf_type).toBe('meeting_note');
  });

  it('maps fact frontmatter fields back onto WikiFact', () => {
    const files: OkfFile[] = [
      conceptFile(
        'entities/alice/facts/x.md',
        {
          type: 'fact',
          title: 'Likes coffee',
          tags: ['preference'],
          timestamp: '2023-11-14T22:15:00.000Z',
          resource: 'chat-1',
          id: 'fact_x',
          confidence: 'certain',
          source_type: 'user_stated',
          source_hash: 'abc',
          created_at: 1_700_000_000_000,
          access_count: 3,
          last_accessed_at: 1_700_000_020_000,
          deleted_at: null,
        },
        'Body text',
      ),
    ];
    const fact = parseOkfBundle('alice', files).entities.alice.facts[0];
    expect(fact.title).toBe('Likes coffee');
    expect(fact.body).toBe('Body text');
    expect(fact.tags).toEqual(['preference']);
    expect(fact.source_ref).toBe('chat-1');
    expect(fact.confidence).toBe('certain');
    expect(fact.source_type).toBe('user_stated');
    expect(fact.source_hash).toBe('abc');
    expect(fact.access_count).toBe(3);
    expect(fact.updated_at).toBe(Date.parse('2023-11-14T22:15:00.000Z'));
  });

  it('maps task frontmatter fields back onto WikiTask', () => {
    const files: OkfFile[] = [
      conceptFile('entities/alice/tasks/x.md', {
        type: 'todo_item',
        title: 'Buy beans',
        id: 'task_x',
        status: 'pending',
        priority: 2,
        created_at: 1_700_000_030_000,
        timestamp: '2023-11-14T22:20:00.000Z',
        resolved_at: null,
        deleted_at: null,
      }),
    ];
    const task = parseOkfBundle('alice', files).entities.alice.tasks[0];
    expect(task.description).toBe('Buy beans');
    expect(task.okf_type).toBe('todo_item');
    expect(task.status).toBe('pending');
    expect(task.priority).toBe(2);
  });

  it('uses filename basename as id and Date.now() when frontmatter omits id and timestamps', () => {
    const files: OkfFile[] = [
      conceptFile('entities/alice/facts/foreign.md', { type: 'note', title: 'T' }),
    ];
    const fact = parseOkfBundle('alice', files).entities.alice.facts[0];
    expect(fact.id).toBe('foreign');
    expect(fact.created_at).toBe(FIXED_NOW);
    expect(fact.updated_at).toBe(FIXED_NOW);
  });

  it('resolves id from filename basename when frontmatter omits id', () => {
    const files: OkfFile[] = [
      conceptFile('entities/alice/facts/foreign_slug.md', { type: 'fact', title: 'T' }),
    ];
    const fact = parseOkfBundle('alice', files).entities.alice.facts[0];
    expect(fact.id).toBe('foreign_slug');
  });
});

describe('parseOkfBundle — edge extraction', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
    vi.spyOn(ids, 'generateId').mockImplementation((prefix = '') => `${prefix}generated`);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('extracts edges from markdown links in a concept body', () => {
    const files: OkfFile[] = [
      conceptFile(
        'entities/alice/facts/source.md',
        { type: 'fact', title: 'S', id: 'fact_src' },
        'See [mentions](./target.md).',
      ),
      conceptFile('entities/alice/facts/target.md', { type: 'fact', title: 'T', id: 'fact_tgt' }),
    ];
    const edges = parseOkfBundle('alice', files).entities.alice.edges;
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      source_id: 'fact_src',
      target_id: 'fact_tgt',
      edge_type: 'mentions',
      entity_id: 'alice',
      created_at: FIXED_NOW,
    });
    expect(edges[0].id).toBe('generated');
  });

  it('skips links that do not resolve to a concept in the bundle', () => {
    const files: OkfFile[] = [
      conceptFile(
        'entities/alice/facts/source.md',
        { type: 'fact', title: 'S', id: 'fact_src' },
        'See [missing](./missing.md).',
      ),
    ];
    expect(parseOkfBundle('alice', files).entities.alice.edges).toEqual([]);
  });

  it('skips structural navigation links to index.md and log.md', () => {
    const files: OkfFile[] = [
      conceptFile(
        'entities/alice/facts/source.md',
        { type: 'fact', title: 'S', id: 'fact_src' },
        '[log](./log.md) and [index](./index.md)',
      ),
      { path: 'entities/alice/log.md', content: buildLogMd([]) },
      { path: 'entities/alice/index.md', content: '# Index\n' },
    ];
    expect(parseOkfBundle('alice', files).entities.alice.edges).toEqual([]);
  });
});

describe('parseOkfBundle — log and round-trip', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
    vi.spyOn(ids, 'generateId').mockImplementation((prefix = '') => `${prefix}generated`);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses linked log entries and hydrates related_entry_id', () => {
    const files: OkfFile[] = [
      conceptFile('entities/alice/facts/fact_aaa.md', { type: 'fact', title: 'A', id: 'fact_aaa' }),
      {
        path: 'entities/alice/log.md',
        content: buildLogMd([
          { date: '2023-11-14', text: '(observation) [Noted preference](./facts/fact_aaa.md)' },
        ]),
      },
    ];
    const events = parseOkfBundle('alice', files).entities.alice.events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: 'evt_generated',
      event_type: 'observation',
      summary: 'Noted preference',
      related_entry_id: 'fact_aaa',
      created_at: new Date('2023-11-14T00:00:00.000Z').getTime(),
    });
  });

  it('skips log entries with invalid dates', () => {
    const files: OkfFile[] = [
      {
        path: 'entities/alice/log.md',
        content: '## 2026-99-99\n\n- (observation) Bad date entry\n',
      },
    ];
    expect(parseOkfBundle('alice', files).entities.alice.events).toEqual([]);
  });

  it('parses plain (unlinked) log entries', () => {
    const files: OkfFile[] = [
      {
        path: 'entities/alice/log.md',
        content: buildLogMd([{ date: '2023-11-14', text: '(decision) Chose option A' }]),
      },
    ];
    const events = parseOkfBundle('alice', files).entities.alice.events;
    expect(events[0]).toMatchObject({
      event_type: 'decision',
      summary: 'Chose option A',
      related_entry_id: null,
    });
  });

  it('formatOkfBundle → parseOkfBundle yields structurally equivalent facts, tasks, events, and edges', () => {
    const original: MemoryDump = {
      generatedAt: 0,
      entities: {
        alice: {
          facts: [
            makeFact({
              body: 'See [related task](../tasks/task_bbb.md).',
              okf_type: 'preference',
            }),
            makeFact({ id: 'fact_bbb', title: 'Target fact', body: 'Target body', okf_type: 'note' }),
          ],
          tasks: [makeTask({ okf_type: 'todo_item' })],
          events: [makeEvent()],
          edges: [
            {
              id: 'edge_1',
              entity_id: 'alice',
              source_id: 'fact_aaa',
              target_id: 'task_bbb',
              edge_type: 'related task',
              created_at: FIXED_NOW,
            },
          ],
        },
      },
    };

    const { files } = formatOkfBundle(original);
    const entityFiles = files.filter(f => f.path.startsWith('entities/alice/'));
    const parsed = parseOkfBundle('alice', entityFiles);

    const orig = original.entities.alice;
    const round = parsed.entities.alice;

    expect(round.facts.map(f => f.id).sort()).toEqual(orig.facts.map(f => f.id).sort());
    expect(round.tasks.map(t => t.id).sort()).toEqual(orig.tasks.map(t => t.id).sort());

    for (const fact of orig.facts) {
      const found = round.facts.find(f => f.id === fact.id)!;
      expect(found.title).toBe(fact.title);
      expect(found.body).toBe(fact.body);
      expect(found.okf_type).toBe(fact.okf_type);
      expect(found.tags).toEqual(fact.tags);
      expect(found.confidence).toBe(fact.confidence);
    }

    for (const task of orig.tasks) {
      const found = round.tasks.find(t => t.id === task.id)!;
      expect(found.description).toBe(task.description);
      expect(found.okf_type).toBe(task.okf_type);
      expect(found.status).toBe(task.status);
    }

    expect(round.edges.map(e => [e.source_id, e.target_id, e.edge_type].join('|')).sort()).toEqual(
      orig.edges.map(e => [e.source_id, e.target_id, e.edge_type].join('|')).sort(),
    );

    expect(round.events).toHaveLength(orig.events.length);
    for (let i = 0; i < orig.events.length; i++) {
      expect(round.events[i].event_type).toBe(orig.events[i].event_type);
      expect(round.events[i].summary).toBe(orig.events[i].summary);
      expect(round.events[i].related_entry_id).toBe(orig.events[i].related_entry_id);
      expect(new Date(round.events[i].created_at).toISOString().slice(0, 10)).toBe(
        new Date(orig.events[i].created_at).toISOString().slice(0, 10),
      );
    }
  });
});

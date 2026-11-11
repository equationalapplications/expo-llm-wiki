import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildConceptDocument, buildLogMd, buildRootIndexMd, deriveEventId } from '@equationalapplications/core-okf';
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

    it('rejects concept files outside facts/ and tasks/ via path allow-list', () => {
      const files: OkfFile[] = [
        conceptFile('entities/alice/concepts/x.md', { type: 'note', title: 'C', id: 'concept_x' }),
      ];
      const dump = parseOkfBundle('alice', files, { defaultSchema: 'task' });
      expect(dump.entities.alice.facts).toHaveLength(0);
      expect(dump.entities.alice.tasks).toHaveLength(0);
    });

    it('defaults to fact when no mapping, directory, or defaultSchema is set', () => {
      const files: OkfFile[] = [
        conceptFile('entities/alice/facts/x.md', { type: 'note', title: 'C', id: 'concept_x' }),
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
        conceptFile('entities/alice/facts/x.md', { type: 'toString', title: 'C', id: 'concept_x' }),
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

  it('resolves entity-root-relative link targets from nested concept paths', () => {
    const files: OkfFile[] = [
      conceptFile('entities/alice/facts/target.md', { type: 'fact', title: 'T', id: 'fact_tgt' }),
      conceptFile(
        'entities/alice/facts/source.md',
        { type: 'fact', title: 'S', id: 'fact_src' },
        'See [mentions](./target.md).',
      ),
    ];
    const edges = parseOkfBundle('alice', files).entities.alice.edges;
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      source_id: 'fact_src',
      target_id: 'fact_tgt',
      edge_type: 'mentions',
    });
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

describe('parseOkfBundle — profile 1', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
    vi.spyOn(ids, 'generateId').mockImplementation((prefix = '') => `${prefix}generated`);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ignores bundle-root README.md via path allow-list', () => {
    const files: OkfFile[] = [
      {
        path: 'README.md',
        content: buildConceptDocument({ type: 'fact', title: 'Trap', id: 'bad' }, 'x'),
      },
      conceptFile('entities/alice/facts/keep.md', { type: 'fact', title: 'K', id: 'fact_keep' }),
    ];
    expect(parseOkfBundle('alice', files).entities.alice.facts.map(f => f.id)).toEqual(['fact_keep']);
  });

  it('parses ## Related into edges and strips from fact body', () => {
    const files: OkfFile[] = [
      conceptFile('entities/alice/facts/target.md', { type: 'fact', title: 'T', id: 'fact_tgt' }),
      conceptFile(
        'entities/alice/facts/source.md',
        { type: 'fact', title: 'S', id: 'fact_src' },
        'Body only.\n\n## Related\n\n- [mentions](./target.md)\n',
      ),
    ];
    const bundle = parseOkfBundle('alice', files).entities.alice;
    expect(bundle.facts.find(f => f.id === 'fact_src')!.body).toBe('Body only.\n');
    expect(bundle.edges).toHaveLength(1);
    expect(bundle.edges[0]).toMatchObject({
      source_id: 'fact_src',
      target_id: 'fact_tgt',
      edge_type: 'mentions',
    });
  });

  it('preserves event id from log comment', () => {
    const files: OkfFile[] = [
      conceptFile('entities/alice/facts/fact_aaa.md', { type: 'fact', title: 'A', id: 'fact_aaa' }),
      {
        path: 'entities/alice/log.md',
        content: buildLogMd([
          {
            date: '2023-11-14',
            text: '(observation) [Noted](./facts/fact_aaa.md) <!-- id: evt_persisted -->',
          },
        ]),
      },
    ];
    const events = parseOkfBundle('alice', files).entities.alice.events;
    expect(events[0].id).toBe('evt_persisted');
  });

  it('parses entity summary from index.md', () => {
    const files: OkfFile[] = [
      { path: 'index.md', content: buildRootIndexMd('0.1', [], { profile: 'llm-wiki/1' }) },
      {
        path: 'entities/alice/index.md',
        content: 'Alice summary.\n\n## Facts\n\n[Event log](./log.md)\n',
      },
      conceptFile('entities/alice/facts/x.md', { type: 'fact', title: 'X', id: 'fact_x' }),
    ];
    expect(parseOkfBundle('alice', files).entities.alice.summary).toBe('Alice summary.');
  });

  it('detects profile 0 when root index lacks profile key', () => {
    const files: OkfFile[] = [
      { path: 'index.md', content: buildRootIndexMd('0.1', []) },
      conceptFile('entities/alice/facts/x.md', { type: 'fact', title: 'X', id: 'fact_x' }),
    ];
    const dump = parseOkfBundle('alice', files);
    expect(dump.entities.alice.facts).toHaveLength(1);
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
      id: deriveEventId({ entityId: 'alice', date: '2023-11-14', eventType: 'observation', summary: 'Noted preference', occurrence: 0 }),
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
    const parsed = parseOkfBundle('alice', files);

    const orig = original.entities.alice;
    const round = parsed.entities.alice;

    expect(round.facts.map(f => f.id).sort()).toEqual(orig.facts.map(f => f.id).sort());
    expect(round.tasks.map(t => t.id).sort()).toEqual(orig.tasks.map(t => t.id).sort());

    for (const fact of orig.facts) {
      const found = round.facts.find(f => f.id === fact.id)!;
      expect(found.title).toBe(fact.title);
      expect(found.body.trimEnd()).toBe(fact.body.trimEnd());
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
      expect(round.events[i].id).toBe(orig.events[i].id);
      expect(round.events[i].event_type).toBe(orig.events[i].event_type);
      expect(round.events[i].summary).toBe(orig.events[i].summary);
      expect(round.events[i].related_entry_id).toBe(orig.events[i].related_entry_id);
      expect(new Date(round.events[i].created_at).toISOString().slice(0, 10)).toBe(
        new Date(orig.events[i].created_at).toISOString().slice(0, 10),
      );
    }
  });
});

describe('parseOkfBundle — linear-time log lines (CodeQL #1 #8)', () => {
  const logFiles = (logMd: string): OkfFile[] => [
    conceptFile('entities/alice/facts/fact_aaa.md', { type: 'fact', title: 'A', id: 'fact_aaa' }),
    { path: 'entities/alice/log.md', content: logMd },
  ];

  it('round-trips an escaped linked summary', () => {
    const events = parseOkfBundle(
      'alice',
      logFiles(buildLogMd([{ date: '2023-11-14', text: '(observation) [a\\\\b \\[x\\]](./facts/fact_aaa.md)' }])),
    ).entities.alice.events;
    expect(events[0].summary).toBe('a\\b [x]');
    expect(events[0].related_entry_id).toBe('fact_aaa');
  });

  it('escaped-summary attack completes in bounded time (#8)', () => {
    const t0 = performance.now();
    parseOkfBundle('alice', logFiles('## 2023-11-14\n\n- (()[' + '\\\\'.repeat(50_000) + '\n'));
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it('tightening: an unescaped "[" in a linked summary falls back to a plain summary', () => {
    const events = parseOkfBundle(
      'alice',
      logFiles(buildLogMd([{ date: '2023-11-14', text: '(observation) [a[b](./facts/fact_aaa.md)' }])),
    ).entities.alice.events;
    expect(events[0].summary).toBe('[a[b](./facts/fact_aaa.md)');
    expect(events[0].related_entry_id).toBeNull();
  });
});

// spec specs/import-followups §3.1, §3.6 (#365): id-less log lines get a derived id; plain summaries are unescaped.
describe('parseOkfBundle — derived event ids', () => {
  const log = (content: string, entityId = 'alice'): WikiEvent[] =>
    parseOkfBundle(entityId, [{ path: `entities/${entityId}/log.md`, content }]).entities[entityId].events;
  const id = (date: string, eventType: string, summary: string, occurrence = 0, entityId = 'alice') =>
    deriveEventId({ entityId, date, eventType, summary, occurrence });

  afterEach(() => vi.restoreAllMocks());

  it('parsing the same id-less log twice gives the same ids (fails on main)', () => {
    const md = '## 2023-11-14\n\n- (observation) A\n- (decision) B\n';
    expect(log(md).map((e) => e.id)).toEqual(log(md).map((e) => e.id));
    expect(log(md).map((e) => e.id)).toEqual([id('2023-11-14', 'observation', 'A'), id('2023-11-14', 'decision', 'B')]);
  });

  it('an explicit id is used as written; an illegal id comment gives a derived id', () => {
    const events = log('## 2023-11-14\n\n- (observation) A <!-- id: evt_keep -->\n- (observation) B <!-- id: bad/id -->\n');
    expect(events.map((e) => [e.id, e.summary])).toEqual([['evt_keep', 'A'], [id('2023-11-14', 'observation', 'B'), 'B']]);
  });

  it('two identical lines give two events; swapping lines keeps the same set of ids', () => {
    const a = log('## 2023-11-14\n\n- (observation) X\n- (decision) Y\n- (observation) X\n').map((e) => e.id);
    expect(a).toEqual([id('2023-11-14', 'observation', 'X', 0), id('2023-11-14', 'decision', 'Y'), id('2023-11-14', 'observation', 'X', 1)]);
    const b = log('## 2023-11-14\n\n- (decision) Y\n- (observation) X\n- (observation) X\n').map((e) => e.id);
    expect([...b].sort()).toEqual([...a].sort());
  });

  it('removing an unrelated line leaves the other ids unchanged', () => {
    const full = log('## 2023-11-14\n\n- (observation) A\n- (observation) B\n- (observation) C\n').map((e) => e.id);
    const less = log('## 2023-11-14\n\n- (observation) A\n- (observation) C\n').map((e) => e.id);
    expect(less).toEqual([full[0], full[2]]);
  });

  it('another date or another entity gives another id', () => {
    const base = log('## 2023-11-14\n\n- (observation) A\n')[0].id;
    expect(log('## 2023-11-15\n\n- (observation) A\n')[0].id).not.toBe(base);
    expect(log('## 2023-11-14\n\n- (observation) A\n', 'bob')[0].id).toBe(id('2023-11-14', 'observation', 'A', 0, 'bob'));
    expect(log('## 2023-11-14\n\n- (observation) A\n', 'bob')[0].id).not.toBe(base);
  });

  it('two headings with the same date share one occurrence count', () => {
    const events = log('## 2023-11-14\n\n- (observation) X\n\n## 2023-11-13\n\n- (observation) X\n\n## 2023-11-14\n\n- (observation) X\n');
    expect(events.map((e) => e.id)).toEqual([
      id('2023-11-14', 'observation', 'X', 0), id('2023-11-13', 'observation', 'X', 0), id('2023-11-14', 'observation', 'X', 1),
    ]);
  });

  it('an id-less line identical to an exported one gets the next occurrence, wherever the explicit line sits (rev 2)', () => {
    const exported = id('2023-11-14', 'observation', 'X', 0);
    const after = log(`## 2023-11-14\n\n- (observation) X <!-- id: ${exported} -->\n- (observation) X\n`);
    expect(after.map((e) => e.id)).toEqual([exported, id('2023-11-14', 'observation', 'X', 1)]);
    const before = log(`## 2023-11-14\n\n- (observation) X\n- (observation) X <!-- id: ${exported} -->\n`);
    expect(before.map((e) => e.id)).toEqual([id('2023-11-14', 'observation', 'X', 1), exported]);
  });

  it('the count continues after a skipped occurrence', () => {
    const taken = id('2023-11-14', 'observation', 'X', 0);
    const events = log(`## 2023-11-14\n\n- (observation) X <!-- id: ${taken} -->\n- (observation) X\n- (observation) X\n`);
    expect(events.map((e) => e.id)).toEqual([taken, id('2023-11-14', 'observation', 'X', 1), id('2023-11-14', 'observation', 'X', 2)]);
  });

  it('summaries that differ only by a lone surrogate get different ids', () => {
    const events = log('## 2023-11-14\n\n- (observation) x\uD800\n- (observation) x\uFFFD\n');
    expect(new Set(events.map((e) => e.id)).size).toBe(2);
  });

  it('a line with an explicit id uses up no occurrence', () => {
    const events = log('## 2023-11-14\n\n- (observation) X <!-- id: evt_keep -->\n- (observation) X\n');
    expect(events.map((e) => e.id)).toEqual(['evt_keep', id('2023-11-14', 'observation', 'X', 0)]);
  });

  it('an unknown type is hashed as the stored observation and shares its count', () => {
    const events = log('## 2023-11-14\n\n- (approved) X\n- (observation) X\n');
    expect(events.map((e) => [e.event_type, e.id])).toEqual([
      ['observation', id('2023-11-14', 'observation', 'X', 0)], ['observation', id('2023-11-14', 'observation', 'X', 1)],
    ]);
  });

  it('a line that does not parse, sits under an invalid date, or has an empty summary uses up no occurrence', () => {
    const events = log('## 2023-13-45\n\n- (observation) X\n\n## 2023-11-14\n\n- not a log line\n- (observation)\n- (observation)   \n- (observation) X\n');
    expect(events.map((e) => e.id)).toEqual([id('2023-11-14', 'observation', 'X', 0)]);
  });

  it('never calls generateId for an event', () => {
    const spy = vi.spyOn(ids, 'generateId');
    log('## 2023-11-14\n\n- (observation) A\n- (observation) A\n');
    expect(spy.mock.calls.filter((c) => c[0] === 'evt_')).toEqual([]);
  });

  it('a plain summary with \\, [ and ] survives three export and import cycles', () => {
    for (const summary of ['see [docs] at C:\\tmp', 'C:\\', '\\]', 'a\\[b]']) {
      let events: WikiEvent[] = [{ id: 'evt_1', entity_id: 'alice', event_type: 'observation', summary, related_entry_id: null, created_at: Date.parse('2023-11-14') }];
      for (let i = 0; i < 3; i++) {
        const dump: MemoryDump = { generatedAt: 0, entities: { alice: { facts: [], tasks: [], events, edges: [] } } };
        events = parseOkfBundle('alice', formatOkfBundle(dump).files).entities.alice.events;
      }
      expect(events.map((e) => [e.id, e.summary])).toEqual([['evt_1', summary]]);
    }
  });

  it('a plain line with no backslashes parses as before', () => {
    expect(log('## 2023-11-14\n\n- (observation) see [docs] here\n')[0].summary).toBe('see [docs] here');
  });
});

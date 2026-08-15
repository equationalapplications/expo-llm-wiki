import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { OkfFile } from '@equationalapplications/core-okf';
import { formatOkfBundle } from '../src/utils/formatOkfBundle';
import { parseOkfBundle } from '../src/utils/parseOkfBundle';

const FIXTURES_ROOT = path.resolve(__dirname, '../../okf/fixtures');

function walkMd(dir: string, prefix = ''): string[] {
  return fs.readdirSync(dir).flatMap(entry => {
    const rel = prefix ? `${prefix}/${entry}` : entry;
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) return walkMd(full, rel);
    return rel.endsWith('.md') ? [rel] : [];
  });
}

function loadFixture(name: 'golden-v1' | 'legacy-profile-0'): OkfFile[] {
  const root = path.join(FIXTURES_ROOT, name);
  return walkMd(root).map(rel => ({
    path: rel,
    content: fs.readFileSync(path.join(root, rel), 'utf8'),
  }));
}

describe('OKF profile conformance', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('imports golden-v1 with summary, Related edges, and stable event ids', () => {
    const dump = parseOkfBundle('demo', loadFixture('golden-v1'));
    const bundle = dump.entities.demo;
    expect(bundle.summary).toBe('Demo entity summary prose.');
    expect(bundle.facts.find(f => f.id === 'fact_alpha')!.body.trimEnd()).toBe('Alpha body text.');
    expect(bundle.edges.map(e => [e.source_id, e.target_id, e.edge_type].join('|')).sort()).toEqual(
      ['fact_alpha|fact_beta|references', 'fact_alpha|task_follow|blocks'].sort(),
    );
    expect(bundle.events.map(e => e.id).sort()).toEqual(['evt_golden_1', 'evt_golden_2'].sort());
  });

  it('round-trips golden-v1 losslessly for normative fields', () => {
    const imported = parseOkfBundle('demo', loadFixture('golden-v1'));
    const { files: exported } = formatOkfBundle(imported, { profile: 'llm-wiki/1' });
    const reimported = parseOkfBundle('demo', exported);
    const a = imported.entities.demo;
    const b = reimported.entities.demo;
    expect(b.summary).toBe(a.summary);
    expect(b.facts.map(f => ({ id: f.id, body: f.body.trimEnd(), title: f.title }))).toEqual(
      a.facts.map(f => ({ id: f.id, body: f.body.trimEnd(), title: f.title })),
    );
    expect(
      b.edges.map(e => ({
        source_id: e.source_id,
        target_id: e.target_id,
        edge_type: e.edge_type,
      })),
    ).toEqual(
      a.edges.map(e => ({
        source_id: e.source_id,
        target_id: e.target_id,
        edge_type: e.edge_type,
      })),
    );
    expect(b.events.map(e => ({ id: e.id, summary: e.summary, event_type: e.event_type }))).toEqual(
      a.events.map(e => ({ id: e.id, summary: e.summary, event_type: e.event_type })),
    );
  });

  it('imports legacy-profile-0 without profile key', () => {
    const files = loadFixture('legacy-profile-0');
    expect(files.find(f => f.path === 'index.md')!.content).not.toContain('profile:');
    const dump = parseOkfBundle('demo', files);
    expect(dump.entities.demo.summary).toBeUndefined();
    expect(dump.entities.demo.events.every(e => e.id.startsWith('evt_'))).toBe(true);
  });

  it('rejects README.md mis-parse via allow-list', () => {
    const files = [
      ...loadFixture('legacy-profile-0'),
      {
        path: 'README.md',
        content: '---\ntype: fact\nid: readme_trap\ntitle: Trap\n---\n\nbody',
      },
    ];
    expect(parseOkfBundle('demo', files).entities.demo.facts.some(f => f.id === 'readme_trap')).toBe(
      false,
    );
  });
});

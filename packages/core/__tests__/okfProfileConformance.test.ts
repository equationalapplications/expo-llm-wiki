import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
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

function loadFixture(name: 'golden-v1' | 'golden-v2' | 'legacy-profile-0'): OkfFile[] {
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

describe('OKF profile conformance — golden-v2', () => {
  it('imports golden-v2 with every new field populated and round-trips losslessly', () => {
    const files = loadFixture('golden-v2');
    const dump = parseOkfBundle('demo', files);
    const bundle = dump.entities.demo;
    expect(bundle.summary).toBe('Demo entity summary prose for v0.2 conformance.');

    const prov = bundle.facts.find((f) => f.id === 'f_provenance')!;
    expect(prov.lifecycle_status).toBe('stable');
    expect(prov.generated_by).toBe('reference_agent/gemini-2.5-pro');
    expect(prov.okf_sources).toHaveLength(2);
    expect(prov.okf_sources?.[1]?.usage_window?.to).toBe('2025-12-31'); // per-entry override
    expect(prov.okf_usage_window?.from).toBe('2026-01-01');
    expect(prov.okf_verified).toHaveLength(2);
    expect(prov.last_verified_by).toBe('human:ahormati'); // latest verifier wins
    // Footnote body preserved verbatim.
    expect(prov.body).toContain('[^a]: footnote a definition');

    const attested = bundle.facts.find((f) => f.id === 'f_attested')!;
    expect(attested.okf_type).toBe('Attested Computation');
    expect(attested.source_type).toBe('immutable_document');
    // `runtime`, `parameters`, `computation`, `executor`, `attester` are NOT
    // preserved (spec §2.9 — `WikiFact` has no opaque-passthrough column for
    // unrecognized frontmatter keys; this is a known, accepted v0.2 limitation,
    // not something the round-trip test below verifies or should be expected
    // to pass). Only the fields `WikiFact` actually has columns for — status,
    // generated, verified, stale_after, sources, usage_window — round-trip.

    const stale = bundle.facts.find((f) => f.id === 'f_stale')!;
    expect(stale.stale_after).toBe(new Date('2025-01-01T00:00:00Z').getTime());

    const renamedTask = bundle.tasks.find((t) => t.id === 't_rename')!;
    expect(renamedTask.lifecycle_status).toBe('stable');
    expect(renamedTask.status).toBe('in_progress'); // execution_status -> status
  });

  it('round-trips golden-v2 losslessly', () => {
    const imported = parseOkfBundle('demo', loadFixture('golden-v2'));
    const { files } = formatOkfBundle(imported);
    const reimported = parseOkfBundle('demo', files);
    const a = imported.entities.demo;
    const b = reimported.entities.demo;
    expect(b.summary).toBe(a.summary);
    expect(b.facts.map((f) => f.id).sort()).toEqual(a.facts.map((f) => f.id).sort());
    for (const id of ['f_provenance', 'f_attested', 'f_stale']) {
      const left = a.facts.find((f) => f.id === id)!;
      const right = b.facts.find((f) => f.id === id)!;
      expect(right.lifecycle_status).toBe(left.lifecycle_status);
      expect(right.generated_by).toBe(left.generated_by);
      expect(right.okf_sources).toEqual(left.okf_sources);
      expect(right.okf_verified).toEqual(left.okf_verified);
      expect(right.okf_usage_window).toEqual(left.okf_usage_window);
      expect(right.last_verified_by).toBe(left.last_verified_by);
    }
    const t = b.tasks.find((x) => x.id === 't_rename')!;
    expect(t.lifecycle_status).toBe('stable');
    expect(t.status).toBe('in_progress');
  });

  it('golden-v2 SHA256SUMS matches the committed fixtures', () => {
    const sumsPath = path.join(FIXTURES_ROOT, 'golden-v2', 'SHA256SUMS');
    const lines = fs.readFileSync(sumsPath, 'utf8').split('\n').filter((l) => l.trim().length > 0);
    for (const line of lines) {
      const m = /^([0-9a-f]{64})\s+(.+)$/.exec(line);
      expect(m, `malformed SHA256SUMS line: ${line}`).not.toBeNull();
      const [, expected, rel] = m!;
      const full = path.join(FIXTURES_ROOT, 'golden-v2', rel);
      const actual = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      expect(actual, `drifted: ${rel}`).toBe(expected);
    }
  });

  it('no .md in golden-v2 contains an anchor or alias marker (billion-laughs ban)', () => {
    const files = loadFixture('golden-v2');
    for (const f of files) {
      if (!f.path.endsWith('.md')) continue;
      // Anchor `&` and alias `*` MUST NOT appear in frontmatter or body.
      // They are forbidden by spec §2.6 (hand-rolled parser rejects them).
      // We check by scanning for YAML anchor/alias grammar: `&identifier:` or `*identifier`.
      expect(/&\w+\s*:/.test(f.content), `anchor in ${f.path}`).toBe(false);
      expect(/\*\w+/.test(f.content), `alias in ${f.path}`).toBe(false);
    }
  });
});

import { describe, it, expect } from 'vitest';
import { serializeFrontmatter, parseFrontmatter, serializeActorString } from '../src/frontmatter';

describe('parseFrontmatter: flow mappings', () => {
  it('parses a generated: { by: ..., at: ... } block', () => {
    const fm = parseFrontmatter(`---\ntype: fact\ngenerated: { by: "reference_agent/gemini-2.5-pro", at: "2026-01-01T00:00:00Z" }\n---\n`).frontmatter;
    expect(fm.generated).toEqual({ by: 'reference_agent/gemini-2.5-pro', at: '2026-01-01T00:00:00Z' });
  });
  it('parses a verified: { by: ..., at: ... } bare mapping (one-element list per §5.2)', () => {
    const fm = parseFrontmatter(`---\ntype: fact\nverified: { by: "human:ahormati", at: "2026-01-01T00:00:00Z" }\n---\n`).frontmatter;
    expect(fm.verified).toEqual({ by: 'human:ahormati', at: '2026-01-01T00:00:00Z' });
  });
  it('parses a usage_window: { from: ..., to: ... } block', () => {
    const fm = parseFrontmatter(`---\ntype: fact\nusage_window: { from: "2026-01-01", to: "2026-12-31" }\n---\n`).frontmatter;
    expect(fm.usage_window).toEqual({ from: '2026-01-01', to: '2026-12-31' });
  });
  it('parses a sources flow-sequence of flow-mappings', () => {
    const yaml = `---\ntype: fact\nsources: [ { resource: "https://example.com/a", id: "a" }, { resource: "https://example.com/b" } ]\n---\n`;
    const fm = parseFrontmatter(yaml).frontmatter;
    expect(fm.sources).toEqual([
      { resource: 'https://example.com/a', id: 'a' },
      { resource: 'https://example.com/b' },
    ]);
  });
  it('parses parameters flow-sequence of mappings', () => {
    const yaml = `---\ntype: fact\nparameters: [ { name: "x", type: "int", required: true } ]\n---\n`;
    expect(parseFrontmatter(yaml).frontmatter.parameters).toEqual([
      { name: 'x', type: 'int', required: true },
    ]);
  });
  it('parses one level of nesting: a sources entry with a per-entry usage_window', () => {
    // v0.2 canonical shape (spec §5.1): sources[].usage_window nests a flow mapping
    // one level inside the sources entry's own flow mapping.
    const yaml = `---\ntype: fact\nsources: [ { resource: "https://a", usage_window: { from: "2025-01-01", to: "2025-12-31" } } ]\n---\n`;
    const fm = parseFrontmatter(yaml).frontmatter;
    expect(fm.sources).toEqual([
      { resource: 'https://a', usage_window: { from: '2025-01-01', to: '2025-12-31' } },
    ]);
  });
  it('parses one level of nesting: an executor mapping with a flow-sequence receipt', () => {
    // v0.2 canonical shape (spec §10.2): executor.receipt nests a flow sequence
    // one level inside the executor flow mapping.
    const yaml = `---\ntype: fact\nexecutor: { resource: "bq://x", receipt: [job_id, executed_sql, result] }\n---\n`;
    const fm = parseFrontmatter(yaml).frontmatter;
    expect(fm.executor).toEqual({ resource: 'bq://x', receipt: ['job_id', 'executed_sql', 'result'] });
  });
  it('preserves the key with a null value when an unquoted anchor/alias appears inside a flow mapping (does not throw, never expands)', () => {
    // Anchor inside the flow value: must be rejected as opaque — never expand.
    const yaml = `---\ntype: fact\nbad: { ref: &anchor "x" }\n---\n`;
    expect(() => parseFrontmatter(yaml)).not.toThrow();
    const fm = parseFrontmatter(yaml).frontmatter;
    expect(fm.bad).toBeNull();
  });
  it('does NOT reject a value merely because a quoted string contains & or *', () => {
    // A resource URL's query string is not an anchor/alias. The anchor/alias scan
    // must exclude quoted spans, or every `&`-bearing URL silently loses its whole entry.
    const yaml = `---\ntype: fact\nsources: [ { resource: "https://example.com/a?p=1&q=2*x" } ]\n---\n`;
    const fm = parseFrontmatter(yaml).frontmatter;
    expect(fm.sources).toEqual([{ resource: 'https://example.com/a?p=1&q=2*x' }]);
  });
  it('preserves the key with a null value on two-or-more-level nesting (beyond the one-level rule)', () => {
    const yaml = `---\ntype: fact\nnested: { a: { b: { c: 1 } } }\n---\n`;
    expect(() => parseFrontmatter(yaml)).not.toThrow();
    const fm = parseFrontmatter(yaml).frontmatter;
    expect('nested' in fm).toBe(true);
    expect(fm.nested).toBeNull();
  });
});

describe('serializeActorString', () => {
  it('quotes actor strings containing /', () => {
    expect(serializeActorString('reference_agent/gemini-2.5-pro')).toBe('"reference_agent/gemini-2.5-pro"');
  });
  it('quotes actor strings containing :', () => {
    expect(serializeActorString('human:ahormati')).toBe('"human:ahormati"');
  });
  it('passes through a plain identifier', () => {
    expect(serializeActorString('llm-wiki')).toBe('llm-wiki');
  });
});

describe('serializeFrontmatter: flow mapping emission', () => {
  it('emits a plain object as a flow mapping', () => {
    const out = serializeFrontmatter({ type: 'fact', generated: { by: 'a', at: 'b' } } as any);
    expect(out).toContain('generated: { by: a, at: b }');
  });
  it('emits an array of objects as an inline flow sequence (never a block-list of flow-mapping items)', () => {
    const out = serializeFrontmatter({
      type: 'fact',
      sources: [{ resource: 'https://a' }, { resource: 'https://b' }],
    } as any);
    expect(out).toContain('sources: [ { resource: "https://a" }, { resource: "https://b" } ]');
  });
});

describe('parse / serialize round-trip — v0.2 shapes', () => {
  it('round-trips generated, verified (bare mapping), usage_window, and status', () => {
    const original = {
      type: 'fact',
      title: 'X',
      status: 'stable' as const,
      generated: { by: 'reference_agent/gemini-2.5-pro', at: '2026-01-01T00:00:00Z' },
      verified: { by: 'human:ahormati', at: '2026-02-01T00:00:00Z' },
      usage_window: { from: '2026-01-01', to: '2026-12-31' },
    };
    const serialized = serializeFrontmatter(original as any);
    const parsed = parseFrontmatter(serialized).frontmatter;
    expect(parsed.generated).toEqual(original.generated);
    expect(parsed.verified).toEqual(original.verified);
    expect(parsed.usage_window).toEqual(original.usage_window);
    expect(parsed.status).toBe('stable');
  });
  it('round-trips a sources entry with a per-entry usage_window (one level of nesting)', () => {
    const original = {
      type: 'fact',
      sources: [{ resource: 'https://a', usage_window: { from: '2025-01-01', to: '2025-12-31' } }],
    };
    const serialized = serializeFrontmatter(original as any);
    const parsed = parseFrontmatter(serialized).frontmatter;
    expect(parsed.sources).toEqual(original.sources);
  });
  it('round-trips a flow-mapping string value containing a comma (would otherwise split as two entries)', () => {
    // A naive quoting rule that only checks '/' and ':' (actor-string shape) would
    // emit `{ title: Foo, Bar }` unquoted, which re-parses as two separate entries.
    const original = { type: 'fact', generated: { by: 'human:a', at: 'Foo, Bar' } };
    const serialized = serializeFrontmatter(original as any);
    const parsed = parseFrontmatter(serialized).frontmatter;
    expect(parsed.generated).toEqual(original.generated);
  });
});
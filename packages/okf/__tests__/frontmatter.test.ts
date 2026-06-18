import { describe, it, expect } from 'vitest';
import { serializeFrontmatter } from '../src/frontmatter';

describe('serializeFrontmatter', () => {
  it('serializes a minimal type-only frontmatter block', () => {
    expect(serializeFrontmatter({ type: 'fact' })).toBe('---\ntype: fact\n---\n');
  });

  it('serializes string, number, boolean, and null scalars', () => {
    const result = serializeFrontmatter({
      type: 'fact',
      priority: 5,
      active: true,
      resolved_at: null,
    } as any);
    expect(result).toBe('---\ntype: fact\npriority: 5\nactive: true\nresolved_at: null\n---\n');
  });

  it('serializes a string array as a YAML block list', () => {
    const result = serializeFrontmatter({ type: 'fact', tags: ['a', 'b'] });
    expect(result).toBe('---\ntype: fact\ntags:\n  - a\n  - b\n---\n');
  });

  it('serializes an array with mixed scalar types', () => {
    const result = serializeFrontmatter({
      type: 'fact',
      values: [1, true, null, 'text'],
    } as any);
    expect(result).toBe('---\ntype: fact\nvalues:\n  - 1\n  - true\n  - null\n  - text\n---\n');
  });

  it('does not quote ISO 8601 timestamps with timezone offsets', () => {
    const result = serializeFrontmatter({
      type: 'fact',
      timestamp: '2026-05-28T14:30:00+05:00',
    });
    expect(result).toBe('---\ntype: fact\ntimestamp: 2026-05-28T14:30:00+05:00\n---\n');
  });

  it('renders an empty array as []', () => {
    const result = serializeFrontmatter({ type: 'fact', tags: [] });
    expect(result).toBe('---\ntype: fact\ntags: []\n---\n');
  });

  it('quotes a string value containing a colon', () => {
    const result = serializeFrontmatter({ type: 'fact', title: 'Note: important' });
    expect(result).toBe('---\ntype: fact\ntitle: "Note: important"\n---\n');
  });

  it('quotes a string value containing a hash', () => {
    const result = serializeFrontmatter({ type: 'fact', title: 'foo # bar' });
    expect(result).toBe('---\ntype: fact\ntitle: "foo # bar"\n---\n');
  });

  it('quotes a string value with leading or trailing whitespace', () => {
    const result = serializeFrontmatter({ type: 'fact', title: ' foo' });
    expect(result).toBe('---\ntype: fact\ntitle: " foo"\n---\n');
  });

  it('quotes a tag that would otherwise parse as a YAML boolean literal', () => {
    const result = serializeFrontmatter({ type: 'fact', tags: ['true'] });
    expect(result).toBe('---\ntype: fact\ntags:\n  - "true"\n---\n');
  });

  it('quotes a string value that would otherwise parse as a YAML null literal', () => {
    const result = serializeFrontmatter({ type: 'fact', title: 'null' });
    expect(result).toBe('---\ntype: fact\ntitle: "null"\n---\n');
  });

  it('quotes a string value that would otherwise parse as a YAML number literal', () => {
    const result = serializeFrontmatter({ type: 'fact', title: '123' });
    expect(result).toBe('---\ntype: fact\ntitle: "123"\n---\n');
  });

  it('preserves key insertion order rather than sorting', () => {
    const result = serializeFrontmatter({ type: 'fact', b: 'x', a: 'y' } as any);
    expect(result).toBe('---\ntype: fact\nb: x\na: y\n---\n');
  });

  it('omits keys with an undefined value', () => {
    const result = serializeFrontmatter({ type: 'fact', resource: undefined, title: 'T' });
    expect(result).toBe('---\ntype: fact\ntitle: T\n---\n');
  });

  it('quotes a string value containing a newline', () => {
    const result = serializeFrontmatter({ type: 'fact', description: 'line one\nline two' });
    expect(result).toBe('---\ntype: fact\ndescription: "line one\\nline two"\n---\n');
  });

  it('quotes a string value containing a tab', () => {
    const result = serializeFrontmatter({ type: 'fact', title: 'a\tb' });
    expect(result).toBe('---\ntype: fact\ntitle: "a\\tb"\n---\n');
  });

  it('quotes custom keys containing spaces or colons', () => {
    const result = serializeFrontmatter({
      type: 'fact',
      'custom key': 'v',
      'meta:field': 'w',
    } as any);
    expect(result).toBe('---\ntype: fact\n"custom key": v\n"meta:field": w\n---\n');
  });

  it('quotes custom keys that would parse as YAML literals', () => {
    const result = serializeFrontmatter({ '123': 'n', type: 'fact', true: 'b' } as any);
    expect(result).toBe('---\n"123": n\ntype: fact\n"true": b\n---\n');
  });
});

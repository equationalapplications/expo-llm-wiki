import { describe, it, expect } from 'vitest';
import { serializeFrontmatter, parseFrontmatter } from '../src/frontmatter';

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

  it('quotes a string value containing a carriage return', () => {
    const result = serializeFrontmatter({ type: 'fact', description: 'line one\rline two' });
    expect(result).toBe('---\ntype: fact\ndescription: "line one\\rline two"\n---\n');
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

describe('parseFrontmatter', () => {
  it('parses a minimal type-only frontmatter block', () => {
    const { frontmatter, rest } = parseFrontmatter('---\ntype: fact\n---\n');
    expect(frontmatter).toEqual({ type: 'fact' });
    expect(rest).toBe('');
  });

  it('parses string, number, boolean, and null scalars', () => {
    const { frontmatter } = parseFrontmatter(
      '---\ntype: fact\npriority: 5\nactive: true\nresolved_at: null\n---\n',
    );
    expect(frontmatter).toEqual({ type: 'fact', priority: 5, active: true, resolved_at: null });
  });

  it('parses a YAML block list back into a string array', () => {
    const { frontmatter } = parseFrontmatter('---\ntype: fact\ntags:\n  - a\n  - b\n---\n');
    expect(frontmatter.tags).toEqual(['a', 'b']);
  });

  it('parses an empty array', () => {
    const { frontmatter } = parseFrontmatter('---\ntype: fact\ntags: []\n---\n');
    expect(frontmatter.tags).toEqual([]);
  });

  it('does not unquote ISO 8601 timestamps (none are quoted by the serializer)', () => {
    const { frontmatter } = parseFrontmatter(
      '---\ntype: fact\ntimestamp: 2026-05-28T14:30:00+05:00\n---\n',
    );
    expect(frontmatter.timestamp).toBe('2026-05-28T14:30:00+05:00');
  });

  it('unquotes a value containing a colon', () => {
    const { frontmatter } = parseFrontmatter('---\ntype: fact\ntitle: "Note: important"\n---\n');
    expect(frontmatter.title).toBe('Note: important');
  });

  it('unquotes a value that looks like a YAML boolean/null/number literal', () => {
    const { frontmatter } = parseFrontmatter('---\ntype: fact\ntags:\n  - "true"\n---\n');
    expect(frontmatter.tags).toEqual(['true']);
  });

  it('unquotes escaped newline, tab, and carriage return sequences', () => {
    const { frontmatter } = parseFrontmatter(
      '---\ntype: fact\ndescription: "line one\\nline two"\n---\n',
    );
    expect(frontmatter.description).toBe('line one\nline two');
  });

  it('unquotes a quoted custom key', () => {
    const { frontmatter } = parseFrontmatter('---\ntype: fact\n"custom key": v\n---\n');
    expect(frontmatter['custom key']).toBe('v');
  });

  it('unquotes single-quoted keys and scalar values', () => {
    const { frontmatter } = parseFrontmatter("---\n'type': 'fact'\ntitle: 'It''s fine'\n---\n");
    expect(frontmatter.type).toBe('fact');
    expect(frontmatter.title).toBe("It's fine");
  });

  it('unquotes a quoted custom key containing a colon', () => {
    const { frontmatter } = parseFrontmatter('---\ntype: fact\n"meta:field": w\n---\n');
    expect(frontmatter['meta:field']).toBe('w');
  });

  it('round-trips quoted keys containing colons', () => {
    const serialized = serializeFrontmatter({
      type: 'fact',
      'meta:field': 'w',
      'a:b': 'v',
    } as any);
    const { frontmatter } = parseFrontmatter(serialized);
    expect(frontmatter).toEqual({ type: 'fact', 'meta:field': 'w', 'a:b': 'v' });
  });

  it('returns the body after the closing delimiter as rest', () => {
    const { rest } = parseFrontmatter('---\ntype: fact\n---\n\nBody text\nline two');
    expect(rest).toBe('\nBody text\nline two');
  });

  it('falls back to type: "" when no frontmatter block is present', () => {
    const { frontmatter, rest } = parseFrontmatter('Just plain text, no frontmatter.');
    expect(frontmatter).toEqual({ type: '' });
    expect(rest).toBe('Just plain text, no frontmatter.');
  });

  it('falls back to type: "" when the closing delimiter is missing', () => {
    const { frontmatter } = parseFrontmatter('---\ntype: fact\ntitle: T\n');
    expect(frontmatter).toEqual({ type: '' });
  });

  it('defaults type to "" when the frontmatter block omits it', () => {
    const { frontmatter } = parseFrontmatter('---\ntitle: T\n---\n');
    expect(frontmatter.type).toBe('');
    expect(frontmatter.title).toBe('T');
  });
});

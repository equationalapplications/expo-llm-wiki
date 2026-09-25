import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from '../src/frontmatter';

/**
 * CT #231: the Rust write path (curated-thoughts okf::quote_for_note) now emits
 * additional escape forms beyond the YAML classics. The TS reader must decode
 * all of them:
 *   \\ \" \n \r \t   (existing)
 *   \N  → U+0085, \L → U+2028, \P → U+2029
 *   \xNN → U+00NN (C0 controls + DEL)
 *   \uXXXX → U+XXXX (lowercase hex, 4 digits — other C1, U+FFFE/U+FFFF)
 */

function titleOf(doc: string): string {
  const { frontmatter } = parseFrontmatter(doc);
  return frontmatter['title'] as string;
}

describe('unescapeFrontmatterString: YAML-8601-style line-break escapes (CT #231)', () => {
  it('decodes \\N to U+0085 (NEL)', () => {
    expect(titleOf('---\ntype: fact\ntitle: "a\\Nb"\n---\n')).toBe('a\u0085b');
  });

  it('decodes \\L to U+2028 (LS)', () => {
    expect(titleOf('---\ntype: fact\ntitle: "a\\Lb"\n---\n')).toBe('a\u2028b');
  });

  it('decodes \\P to U+2029 (PS)', () => {
    expect(titleOf('---\ntype: fact\ntitle: "a\\Pb"\n---\n')).toBe('a\u2029b');
  });
});

describe('unescapeFrontmatterString: \\xNN hex escapes (CT #231)', () => {
  it('decodes \\x7f to U+007F (DEL)', () => {
    expect(titleOf('---\ntype: fact\ntitle: "x\\x7fy"\n---\n')).toBe('x\u007fy');
  });

  it('decodes \\x1b to U+001B (ESC)', () => {
    expect(titleOf('---\ntype: fact\ntitle: "a\\x1bb"\n---\n')).toBe('a\u001bb');
  });

  it('decodes \\x00 to U+0000', () => {
    expect(titleOf('---\ntype: fact\ntitle: "a\\x00b"\n---\n')).toBe('a\u0000b');
  });
});

describe('unescapeFrontmatterString: \\uXXXX hex escapes (CT #231)', () => {
  it('decodes \\ufffe to U+FFFE', () => {
    expect(titleOf('---\ntype: fact\ntitle: "a\\ufffeb"\n---\n')).toBe('a\ufffeb');
  });

  it('decodes \\uffff to U+FFFF', () => {
    expect(titleOf('---\ntype: fact\ntitle: "a\\uffffb"\n---\n')).toBe('a\uffffb');
  });

  it('decodes \\u0090 to U+0090 (C1)', () => {
    expect(titleOf('---\ntype: fact\ntitle: "a\\u0090b"\n---\n')).toBe('a\u0090b');
  });

  it('decodes uppercase hex digits in \\uXXXX too', () => {
    expect(titleOf('---\ntype: fact\ntitle: "a\\u00FFb"\n---\n')).toBe('a\u00FFb');
  });
});

describe('unescapeFrontmatterString: regression pins', () => {
  it('a quoted colon title decodes correctly (regression pin)', () => {
    expect(titleOf('---\ntype: fact\ntitle: "Deploy: retro"\n---\n')).toBe('Deploy: retro');
  });

  it('existing classic escapes still decode', () => {
    expect(titleOf('---\ntype: fact\ntitle: "say \\"hi\\""\n---\n')).toBe('say "hi"');
    expect(titleOf('---\ntype: fact\ntitle: "a\\\\b"\n---\n')).toBe('a\\b');
    expect(titleOf('---\ntype: fact\ntitle: "a\\nb"\n---\n')).toBe('a\nb');
    expect(titleOf('---\ntype: fact\ntitle: "a\\rb"\n---\n')).toBe('a\rb');
    expect(titleOf('---\ntype: fact\ntitle: "a\\tb"\n---\n')).toBe('a\tb');
  });
});

describe('unescapeFrontmatterString: malformed/unknown escapes pass through verbatim', () => {
  it('passes through an unknown escape letter verbatim', () => {
    expect(titleOf('---\ntype: fact\ntitle: "a\\qb"\n---\n')).toBe('a\\qb');
  });

  it('passes through a trailing lone backslash verbatim', () => {
    expect(titleOf('---\ntype: fact\ntitle: "a\\\\"\n---\n')).toBe('a\\');
  });

  it('passes through malformed \\x with non-hex digits verbatim', () => {
    expect(titleOf('---\ntype: fact\ntitle: "a\\xzzb"\n---\n')).toBe('a\\xzzb');
  });

  it('passes through short \\u with fewer than 4 hex digits verbatim', () => {
    expect(titleOf('---\ntype: fact\ntitle: "a\\u00b"\n---\n')).toBe('a\\u00b');
  });
});

describe('unescapeFrontmatterString: CT adversarial round-trips', () => {
  it("round-trips 'Plan\\u2028B' as the Rust writer emits it", () => {
    expect(titleOf('---\ntype: fact\ntitle: "Plan\\LB"\n---\n')).toBe('Plan\u2028B');
  });

  it("round-trips 'a\\u0085b' as the Rust writer emits it", () => {
    expect(titleOf('---\ntype: fact\ntitle: "a\\Nb"\n---\n')).toBe('a\u0085b');
  });

  it("round-trips 'x\\u007fy' as the Rust writer emits it", () => {
    expect(titleOf('---\ntype: fact\ntitle: "x\\x7fy"\n---\n')).toBe('x\u007fy');
  });
});

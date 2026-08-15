import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { OkfFile } from '@equationalapplications/core-okf';
import { WikiMemory } from '../src/WikiMemory';
import { parseOkfBundle } from '../src/utils/parseOkfBundle';
import { formatOkfBundle } from '../src/utils/formatOkfBundle';
import type { SQLiteAdapter } from '../src/types';
import { openTestDatabase } from './helpers/sqliteAdapter';

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

const testWikiOptions = {
  llmProvider: { generateText: async () => '{}' },
};

describe('OKF profile conformance through storage', () => {
  let db: SQLiteAdapter;
  let wiki: WikiMemory;

  beforeEach(async () => {
    db = openTestDatabase();
    wiki = new WikiMemory(db, testWikiOptions);
    await wiki.setup();
  });

  it('round-trips the golden-v1 summary through importDump → exportDump → formatOkfBundle', async () => {
    const parsed = parseOkfBundle('demo', loadFixture('golden-v1'));
    await wiki.importDump(parsed, { merge: false });

    expect(await wiki.getEntitySummary('demo')).toBe('Demo entity summary prose.');

    const exported = await wiki.exportDump(['demo']);
    expect(exported.entities.demo.summary).toBe('Demo entity summary prose.');

    const { files } = formatOkfBundle(exported, { profile: 'llm-wiki/1' });
    const reparsed = parseOkfBundle('demo', files);
    expect(reparsed.entities.demo.summary).toBe('Demo entity summary prose.');
  });

  it('imports legacy-profile-0 without writing a summary key', async () => {
    const parsed = parseOkfBundle('demo', loadFixture('legacy-profile-0'));
    await wiki.importDump(parsed, { merge: false });
    expect(await wiki.getEntitySummary('demo')).toBeNull();
  });
});

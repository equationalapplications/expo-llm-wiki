/**
 * Spec forget-erasure Test plan #1 (T10): the canary forensic acceptance suite.
 * Two tiers of whole-file absence (fact-path, full-wipe), the source-document
 * survival tier, and the B1 regression. Scenarios F/G/K/K2 are mirrored from
 * specs/forget-erasure/canary-repro.cjs against a raw FTS5 table.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTestDatabase } from './helpers/sqliteAdapter';
import { WikiMemory } from '../src/index';
import { entitySummaryMetaKey } from '../src/repositories/MetadataRepository';

const P = 'llm_wiki_';
// Single lowercase alphanumeric token: byte-identical under `porter unicode61`
// (no separators, no case, not stemmable). Verified once in the first test.
const CANARY = 'zxq7f3a9k';
const HASH_R = 'a'.repeat(64);
const HASH_S = 'b'.repeat(64);
const E = 'e1';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

type Opts = { outbox?: boolean; generateText?: (a: any) => Promise<string> };
async function make(o: Opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'erase-accept-'));
  dirs.push(dir);
  const path = join(dir, 'w.db');
  const raw = openTestDatabase(path);
  await raw.execAsync('PRAGMA journal_mode=WAL');
  const wiki = new WikiMemory(raw, {
    llmProvider: { generateText: o.generateText ?? (async () => '{}') },
    ...(o.outbox ? { config: { enableOutbox: true } } : {}),
  } as any);
  await wiki.setup();
  return { dir, path, raw, wiki };
}
type H = Awaited<ReturnType<typeof make>>;

/** Whole-file scan: db, -wal, -journal, -shm, and every %_data block. */
async function scan(h: H): Promise<{ files: Record<string, boolean>; data: string[] }> {
  const files: Record<string, boolean> = {};
  for (const suffix of ['', '-wal', '-journal', '-shm']) {
    const f = h.path + suffix;
    files[suffix || 'db'] = existsSync(f) && readFileSync(f).includes(CANARY);
  }
  const tables = await h.raw.getAllAsync<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%\\_data' ESCAPE '\\'`);
  const data: string[] = [];
  for (const t of tables) {
    const rows = await h.raw.getAllAsync<{ block: Uint8Array }>(`SELECT block FROM "${t.name}"`);
    if (rows.some((r) => Buffer.from(r.block).includes(CANARY))) data.push(t.name);
  }
  return { files, data };
}
const expectClean = async (h: H) => {
  const s = await scan(h);
  expect(s.files).toEqual({ db: false, '-wal': false, '-journal': false, '-shm': false });
  expect(s.data).toEqual([]);
};
const expectPresent = async (h: H) => {
  const s = await scan(h);
  expect(Object.values(s.files).some(Boolean) || s.data.length > 0).toBe(true);
};

const ingestStub = async () => JSON.stringify({
  facts: [{ title: 'target fact', body: `${CANARY} unique probe text for the forgotten fact`, tags: [], confidence: 'certain' }],
});

async function fillers(wiki: WikiMemory, n = 320) {
  for (let i = 0; i < n; i++) {
    await wiki.remember(E, { title: `filler ${i}`, body: `innocuous row ${i} fillertext${i} common filler words repeated across every row` } as any);
  }
}
async function factFixture(): Promise<H & { entryId: string }> {
  const h = await make({ generateText: ingestStub });
  await h.wiki.ingestDocument(E, { sourceRef: 'doc-r.md', sourceHash: HASH_R, documentChunk: 'the document body' });
  await fillers(h.wiki);
  await (h.wiki as any).searchService.indexStrategy.drain();
  const row = await h.raw.getFirstAsync<{ id: string }>(
    `SELECT id FROM ${P}entries WHERE entity_id = ? AND title = 'target fact' AND deleted_at IS NULL`, [E]);
  expect(row).toBeTruthy();
  // The fixture's isolation rests on ingest never writing source_documents.
  const docs = await h.raw.getFirstAsync<{ c: number }>(`SELECT COUNT(*) c FROM ${P}source_documents`);
  expect(docs!.c).toBe(0);
  const reg = await h.raw.getFirstAsync<{ c: number }>(`SELECT COUNT(*) c FROM ${P}source_ref_index`);
  expect(reg!.c).toBeGreaterThan(0);
  // Pre-erase the canary really is in the file's live surfaces.
  const live = await h.raw.getFirstAsync<{ body: string }>(`SELECT body FROM ${P}entries WHERE id = ?`, [row!.id]);
  expect(live!.body).toContain(CANARY);
  return Object.assign(h, { entryId: row!.id });
}

describe('canary byte-identity (setup)', () => {
  it('the canary is one stable term under porter unicode61, and MATCH finds exactly the target pre-delete', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE VIRTUAL TABLE ft USING fts5(id UNINDEXED, body, tokenize = 'porter unicode61')`);
    db.exec(`CREATE VIRTUAL TABLE ftv USING fts5vocab(ft, 'row')`);
    db.prepare('INSERT INTO ft(id, body) VALUES (?, ?)').run('T', `${CANARY} probe`);
    db.prepare('INSERT INTO ft(id, body) VALUES (?, ?)').run('O', 'other words');
    expect(CANARY).toMatch(/^[a-z0-9]+$/);
    expect(db.prepare('SELECT term FROM ftv WHERE term = ?').all(CANARY)).toEqual([{ term: CANARY }]);
    expect(db.prepare('SELECT id FROM ft WHERE ft MATCH ?').all(CANARY)).toEqual([{ id: 'T' }]);
    db.close();
  });
});

describe('fact-path tier (spec Test plan #1)', () => {
  it('documented recipe: forget({ entryId }) → erase() — whole-file absence', async () => {
    const h = await factFixture();
    await h.wiki.forget(E, { entryId: h.entryId });
    const report = await h.wiki.erase();
    expect(report.verified).toBe(true);
    await expectClean(h);
    await h.raw.closeAsync();
  }, 60_000);

  it('variant: explicit runPrune(retainSoftDeletedFor: 0, retainEventsFor: null) between forget and erase', async () => {
    const h = await factFixture();
    await h.wiki.forget(E, { entryId: h.entryId });
    await h.wiki.runPrune(E, { retainSoftDeletedFor: 0, retainEventsFor: null });
    const report = await h.wiki.erase();
    expect(report.verified).toBe(true);
    await expectClean(h);
    await h.raw.closeAsync();
  }, 60_000);

  it('negative control: without erase the canary is still in the file after forget', async () => {
    const h = await factFixture();
    await h.wiki.forget(E, { entryId: h.entryId });
    await h.raw.execAsync('PRAGMA wal_checkpoint(TRUNCATE)');
    await expectPresent(h);
    await h.raw.closeAsync();
  }, 60_000);

  it('erase({ rebuild: true }) variant — whole-file absence', async () => {
    const h = await factFixture();
    await h.wiki.forget(E, { entryId: h.entryId });
    const report = await h.wiki.erase({ rebuild: true });
    expect(report.verified).toBe(true);
    await expectClean(h);
    await h.raw.closeAsync();
  }, 60_000);
});

describe('scenarios F/G/K/K2 mirrored (canary-repro.cjs, pragma ON, porter unicode61)', () => {
  const pad = ' common filler words repeated across every row to build real segment pressure ';
  function run(cmd: 'optimize' | 'rebuild', vacuum: boolean) {
    const dir = mkdtempSync(join(tmpdir(), 'canary-fgk-'));
    dirs.push(dir);
    const file = join(dir, 'c.db');
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.pragma('secure_delete = ON');
    db.exec(`CREATE VIRTUAL TABLE ft USING fts5(id UNINDEXED, body, tokenize = 'porter unicode61')`);
    const ins = db.prepare('INSERT INTO ft(id, body) VALUES (?, ?)');
    for (let i = 0; i < 300; i++) ins.run(`f${i}`, `innocuous row ${i} fillertext${i}${pad}`);
    ins.run('TARGET', `${CANARY} probe unique tokens for the deleted row`);
    expect(db.prepare('SELECT id FROM ft WHERE ft MATCH ?').all(CANARY)).toEqual([{ id: 'TARGET' }]);
    db.prepare("DELETE FROM ft WHERE id = 'TARGET'").run();
    db.exec(`INSERT INTO ft(ft) VALUES('${cmd}')`);
    if (vacuum) db.exec('VACUUM');
    db.pragma('wal_checkpoint(TRUNCATE)');
    const segPages = (db.prepare('SELECT count(*) c FROM ft_data WHERE id <> 1 AND id <> 10').get() as any).c;
    let postings = false;
    for (const r of db.prepare('SELECT block FROM ft_data').iterate() as any) {
      if (Buffer.from(r.block).includes(CANARY)) postings = true;
    }
    db.exec("INSERT INTO ft(ft) VALUES('integrity-check')");
    db.close();
    const walHas = existsSync(file + '-wal') && readFileSync(file + '-wal').includes(CANARY);
    return { dbHas: readFileSync(file).includes(CANARY), walHas, postings, segPages };
  }
  const cases: Array<[string, 'optimize' | 'rebuild', boolean]> = [
    ['F2 optimize', 'optimize', false],
    ['G2 rebuild', 'rebuild', false],
    ['K optimize + VACUUM', 'optimize', true],
    ['K2 rebuild + VACUUM', 'rebuild', true],
  ];
  for (const [label, cmd, vac] of cases) {
    it(`${label}: clean file, clean wal, clean postings, multi-segment index`, () => {
      const r = run(cmd, vac);
      expect(r).toMatchObject({ dbHas: false, walHas: false, postings: false });
      expect(r.segPages).toBeGreaterThan(1);
    });
  }
});

describe('full-wipe tier (spec Test plan #1)', () => {
  it('clearAll({ includeEvents }) + outbox drain + erase(), hookless — whole-file absence', async () => {
    const h = await make({ outbox: true });
    await h.wiki.remember(E, { title: 'wipe fact', body: `${CANARY} in a fact body` } as any);
    await h.wiki.write(E, { event_type: 'observation', summary: `event carrying ${CANARY}`, related_entry_id: null } as any);
    await h.raw.runAsync(
      `INSERT OR REPLACE INTO ${P}meta (key, value) VALUES (?, ?)`, [entitySummaryMetaKey(E), `summary carrying ${CANARY}`]);
    await h.wiki.drain();
    await (h.wiki as any).searchService.indexStrategy.drain();

    // Every derived copy exists before the wipe.
    const ev = await h.raw.getFirstAsync<{ c: number }>(`SELECT COUNT(*) c FROM ${P}events WHERE summary LIKE ?`, [`%${CANARY}%`]);
    expect(ev!.c).toBe(1);
    const pending = await h.wiki.getUnprocessedOutboxEvents(1000);
    expect(pending.some((p) => JSON.stringify(p).includes(CANARY))).toBe(true);
    const sum = await h.raw.getFirstAsync<{ value: string }>(`SELECT value FROM ${P}meta WHERE key = ?`, [entitySummaryMetaKey(E)]);
    expect(sum!.value).toContain(CANARY);
    await expectPresent(h);

    await h.wiki.forget(E, { clearAll: true, includeEvents: true } as any);
    for (;;) {
      const batch = await h.wiki.getUnprocessedOutboxEvents(1000);
      if (batch.length === 0) break;
      await h.wiki.markOutboxEventsProcessed(batch.map((b: any) => b.id));
    }
    // The entity summary is a documented carve-out (ruling D): the host clears it.
    await h.raw.runAsync(`DELETE FROM ${P}meta WHERE key = ?`, [entitySummaryMetaKey(E)]);
    const report = await h.wiki.erase();
    expect(report.verified).toBe(true);
    await expectClean(h);
    await h.raw.closeAsync();
  }, 60_000);
});

describe('source-document tier + B1 regression (ruling E)', () => {
  const TEXT = `Stored source text carrying ${CANARY} and nothing else of note.`;

  it('storeSource canary (no facts): forget + erase → document SURVIVES; forget({ sourceRef }) + erase → whole-file clean', async () => {
    const h = await make();
    const stored = await h.wiki.storeSource(E, { sourceRef: 'R.md', sourceHash: HASH_S, text: TEXT });
    expect(stored.stored).toBe(true);
    const f = await h.wiki.remember(E, { title: 'unrelated', body: 'unrelated body' } as any);

    await h.wiki.forget(E, { entryId: f.id });
    expect((await h.wiki.erase()).verified).toBe(true);
    expect((await h.wiki.getStoredSource(E, 'R.md'))?.text).toContain(CANARY);
    await expectPresent(h);

    await h.wiki.forget(E, { sourceRef: 'R.md' });
    expect((await h.wiki.erase()).verified).toBe(true);
    expect(await h.wiki.getStoredSource(E, 'R.md')).toBeNull();
    await expectClean(h);
    await h.raw.closeAsync();
  }, 60_000);

  it('B1: a storeSource-only document with zero facts survives erase(); every stored document survives', async () => {
    const h = await make();
    for (const [ref, ch] of [['one.md', '1'], ['two.md', '2'], ['three.md', '3']] as const) {
      const r = await h.wiki.storeSource(E, { sourceRef: ref, sourceHash: ch.repeat(64), text: `text for ${ref} ${CANARY}` });
      expect(r.stored).toBe(true);
    }
    const before = await h.wiki.listStoredSources(E);
    expect(before).toHaveLength(3);
    expect((await h.wiki.erase()).verified).toBe(true);
    expect(await h.wiki.listStoredSources(E)).toEqual(before);
    for (const ref of ['one.md', 'two.md', 'three.md']) {
      expect((await h.wiki.getStoredSource(E, ref))?.text).toContain(CANARY);
    }
    await h.raw.closeAsync();
  }, 60_000);
});

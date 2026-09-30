import { describe, it, expect } from 'vitest';
import { makeDiagnosticWiki, ofCode } from './helpers/diagnosticsHarness';

const old = Date.now() - 40 * 86_400_000;

async function seed(config: Record<string, unknown>) {
  const h = await makeDiagnosticWiki({ config });
  for (const [id, at] of [['evt_1', old], ['evt_2', old + 1], ['evt_3', old + 2]] as const) {
    await h.db.runAsync(`INSERT INTO llm_wiki_events (id, entity_id, event_type, summary, created_at) VALUES (?, 'u', 'observation', 's', ?)`, [id, at]);
  }
  return h;
}
const ids = async (db: any) => (await db.getAllAsync(`SELECT id FROM llm_wiki_events ORDER BY id`)).map((r: any) => r.id);

describe('runPrune event guard', () => {
  it('legacy auto mode: unchanged (all old events pruned)', async () => {
    const { wiki, db } = await seed({});
    await wiki.runPrune('u');
    expect(await ids(db)).toEqual([]);
  });
  it('deferred mode: keeps events after the watermark and reports it', async () => {
    const { wiki, db, diagnostics } = await seed({ maintenance: 'deferred' });
    await (wiki.__testAccess.metadataRepo as any).setLibrarianWatermark('u', { at: old, id: 'evt_1' }, db);
    await wiki.runPrune('u');
    expect(await ids(db)).toEqual(['evt_2', 'evt_3']);
    expect(ofCode(diagnostics, 'event_retention_held')[0]).toMatchObject({ operation: 'prune', detail: { count: 2 } });
  });
  it('ops strategy with no watermark: prunes nothing', async () => {
    const { wiki, db } = await seed({ librarian: { strategy: 'ops' } });
    await wiki.runPrune('u');
    expect(await ids(db)).toEqual(['evt_1', 'evt_2', 'evt_3']);
  });
});

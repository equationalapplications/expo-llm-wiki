import { it, expect, vi } from 'vitest';
import { WikiMemory } from '../src/WikiMemory';
import { openTestDatabase } from './helpers/sqliteAdapter';
import type { WikiDiagnostic } from '../src/types';

it('debug update pass', async () => {
  const db = openTestDatabase();
  const diagnostics: WikiDiagnostic[] = [];
  const responses: any[] = [
    () => ({ facts: [{ title: 'User has a dog named Rex', body: 'A beagle hound', tags: [], confidence: 'certain', source_event: 'e1' }], tasks: [] }),
    () => ({ facts: [{ title: "Rex is the user's beagle hound", body: 'Now a beagle hound named Rex', tags: [], confidence: 'certain', source_event: 'e2' }], tasks: [] }),
    () => ({ ops: [{ item: 0, op: 'UPDATE', target: 'n1', body: 'Now a beagle hound named Rex, officially' }] }),
  ];
  let i = 0;
  const wiki = new WikiMemory(db, {
    llmProvider: { generateText: vi.fn(async () => JSON.stringify(responses[i++]())), embed: vi.fn(async () => [0.1, 0.2, 0.3, 0.5]) },
    config: { autoLibrarianThreshold: 1000, librarian: { strategy: 'ops' as const } },
    onDiagnostic: (d) => diagnostics.push(d),
  });
  await wiki.setup();
  await db.runAsync(`INSERT INTO llm_wiki_events (id, entity_id, event_type, summary, created_at, occurred_at) VALUES ('evt_1','u','observation','first event summary',100,100)`);
  await wiki.runLibrarian('u');
  const id = (await db.getFirstAsync<any>(`SELECT id FROM llm_wiki_entries WHERE title = 'User has a dog named Rex'`))!.id;
  console.log('ID:', id, '| outbox tables:', JSON.stringify(await db.getAllAsync<any>(`SELECT name FROM sqlite_master WHERE name LIKE '%outbox%'`)));
  await db.runAsync(`INSERT INTO llm_wiki_events (id, entity_id, event_type, summary, created_at) VALUES ('evt_2b','u','observation','rex update',200)`);
  await wiki.runLibrarian('u');
  console.log('CALLS:', i);
  console.log('ENTRIES:', JSON.stringify(await db.getAllAsync<any>(`SELECT id, title, body FROM llm_wiki_entries WHERE deleted_at IS NULL`)));
  console.log('OUTBOX:', JSON.stringify(await db.getAllAsync<any>(`SELECT table_name, record_id, operation FROM llm_wiki_outbox`)).slice(0, 300));
  console.log('DIAGS:', JSON.stringify(diagnostics.map(d => [d.code, d.detail])));
});

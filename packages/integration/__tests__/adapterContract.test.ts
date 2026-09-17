import { expect, it } from 'vitest';
import { openTestDatabase } from '../helpers/db';

it('distinguishes a suppressed conflict write from a permitted value-identical one', async () => {
  const db = openTestDatabase();
  try {
    await db.execAsync('CREATE TABLE ownership_adapter_contract (id TEXT PRIMARY KEY, entity_id TEXT NOT NULL)');
    await db.runAsync("INSERT INTO ownership_adapter_contract VALUES ('shared', 'B')");
    const upsert = (owner: string) => `
      INSERT INTO ownership_adapter_contract(id, entity_id) VALUES ('shared', '${owner}')
      ON CONFLICT(id) DO UPDATE SET entity_id = excluded.entity_id
      WHERE ownership_adapter_contract.entity_id = excluded.entity_id`;
    await db.withTransactionAsync(async tx => {
      // Suppressed: the predicate fails, nothing is written, count must be 0.
      const suppressed = await tx.runAsync(upsert('A'));
      expect(suppressed.changes).toBe(0);
      expect(await tx.getFirstAsync('SELECT entity_id FROM ownership_adapter_contract'))
        .toEqual({ entity_id: 'B' });
      // Permitted but value-identical: the row is still counted, so a
      // permitted write is never mistaken for suppression.
      const permitted = await tx.runAsync(upsert('B'));
      expect(permitted.changes).toBeGreaterThanOrEqual(1);
      expect(await tx.getFirstAsync('SELECT entity_id FROM ownership_adapter_contract'))
        .toEqual({ entity_id: 'B' });
    });
  } finally { await db.closeAsync(); }
});

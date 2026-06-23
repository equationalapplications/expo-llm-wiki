import { describe, it, expect, beforeEach } from 'vitest';
import { openTestDatabase } from '../helpers/sqliteAdapter';
import { setupDatabase } from '../../src/db/schema';
import { MetadataRepository } from '../../src/repositories/MetadataRepository';
import type { OntologyManifest } from '../../src/types';

const PREFIX = 'llm_wiki_';

const sampleManifest: OntologyManifest = {
  node_types: [
    { type: 'person', description: 'An individual.' },
    { type: 'project', description: 'A project.' },
  ],
  edge_types: [
    { type: 'reports_to', source_type: 'person', target_type: 'person', description: 'Hierarchy.' },
  ],
};

describe('MetadataRepository — entity manifests', () => {
  let db: ReturnType<typeof openTestDatabase>;
  let repo: MetadataRepository;

  beforeEach(async () => {
    db = openTestDatabase();
    await setupDatabase(db, PREFIX);
    repo = new MetadataRepository(db, PREFIX);
  });

  it('getManifest returns null when no row exists', async () => {
    const result = await repo.getManifest('entity1');
    expect(result).toBeNull();
  });

  it('setManifest + getManifest round-trip', async () => {
    await db.withTransactionAsync(async (tx) => {
      await repo.setManifest('entity1', { mode: 'strict', manifest: sampleManifest }, tx);
    });

    const result = await repo.getManifest('entity1');
    expect(result).toEqual({ mode: 'strict', manifest: sampleManifest });
  });

  it('mergeManifestUpdates appends novel types only', async () => {
    await db.withTransactionAsync(async (tx) => {
      await repo.setManifest('entity1', { mode: 'emergent', manifest: sampleManifest }, tx);
      const merged = await repo.mergeManifestUpdates('entity1', {
        node_types: [
          { type: 'person', description: 'duplicate ignored' },
          { type: 'vendor', description: 'A supplier.' },
        ],
        edge_types: [
          { type: 'reports_to', source_type: 'person', target_type: 'person', description: 'dup' },
          { type: 'supplies', source_type: 'vendor', target_type: 'project', description: 'Supply chain.' },
        ],
      }, tx);

      expect(merged.node_types).toHaveLength(3);
      expect(merged.node_types.find(n => n.type === 'vendor')).toBeDefined();
      expect(merged.edge_types).toHaveLength(2);
      expect(merged.edge_types.find(e => e.type === 'supplies')).toBeDefined();
    });
  });
});

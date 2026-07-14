import { describe, it, expect } from 'vitest';
import { WikiMemory } from '@equationalapplications/core-llm-wiki';
import { schemaOrgWarmAgentManifest } from '@equationalapplications/schema-org-llm-wiki';
import { openTestDatabase } from '../helpers/db';
import { scriptedLLM } from '../helpers/llm';

describe('schema.org manifest — polymorphic edge round-trip', () => {
  it('librarian classifies facts into polymorphic edges by target type', async () => {
    const db = openTestDatabase();
    const librarianResponse = JSON.stringify({
      facts: [
        {
          title: 'Yosemite Valley',
          body: 'A glacial valley in California.',
          tags: [],
          confidence: 'certain',
          okf_type: 'place',
        },
        {
          title: 'Yosemite Guide',
          body: 'A guidebook about Yosemite Valley.',
          tags: [],
          confidence: 'certain',
          okf_type: 'creativework',
          edges: [{ edge_type: 'about', target_title: 'Yosemite Valley' }],
        },
        {
          title: 'Blender X100',
          body: 'A kitchen blender.',
          tags: [],
          confidence: 'certain',
          okf_type: 'product',
        },
        {
          title: 'Blender X100 review',
          body: 'Loves the blender. Five stars.',
          tags: [],
          confidence: 'certain',
          okf_type: 'review',
          edges: [{ edge_type: 'itemReviewed', target_title: 'Blender X100' }],
        },
      ],
      tasks: [],
    });

    const wiki = new WikiMemory(db, {
      llmProvider: scriptedLLM([librarianResponse]),
      config: { ontology: { mode: 'strict' } },
    });
    await wiki.setup();
    await wiki.setOntologyManifest('user-1', schemaOrgWarmAgentManifest, { mode: 'strict' });

    await wiki.write('user-1', {
      event_type: 'observation',
      summary: 'Read a Yosemite guidebook and reviewed the new blender.',
    });
    await wiki.runLibrarian('user-1');

    const bundle = await wiki.getMemoryBundle('user-1');
    const guide = bundle.facts.find(f => f.title === 'Yosemite Guide');
    const valley = bundle.facts.find(f => f.title === 'Yosemite Valley');
    const review = bundle.facts.find(f => f.title === 'Blender X100 review');
    const blender = bundle.facts.find(f => f.title === 'Blender X100');

    expect(guide?.okf_type).toBe('creativework');
    expect(valley?.okf_type).toBe('place');
    expect(review?.okf_type).toBe('review');
    expect(blender?.okf_type).toBe('product');

    expect(bundle.edges).toHaveLength(2);

    const about = bundle.edges!.find(e => e.edge_type === 'about');
    expect(about?.source_id).toBe(guide?.id);
    expect(about?.target_id).toBe(valley?.id);

    const reviewed = bundle.edges!.find(e => e.edge_type === 'itemReviewed');
    expect(reviewed?.edge_type).toBe('itemReviewed');
    expect(reviewed?.source_id).toBe(review?.id);
    expect(reviewed?.target_id).toBe(blender?.id);
  });
});

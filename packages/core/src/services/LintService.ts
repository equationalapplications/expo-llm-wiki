import type { WikiLintReport } from '../types';
import type { LintRepository } from '../repositories/LintRepository';
import type { OntologyService } from './OntologyService';
import { edgeTripleAllowed } from '../utils/ontology';

const LINT_SAMPLE_SIZE = 20;
const LINT_PAGE_SIZE = 500;

export class LintService {
  constructor(private lintRepo: LintRepository, private ontologyService: OntologyService) {}

  /**
   * Read-only (spec §8.1). Manifest violations stream the entity's live-endpoint
   * edges in keyset pages and check each triple in JS against the effective
   * manifest. `getEffectiveState` is called without a transaction, so a seed
   * manifest is cached, never persisted. Counts come from separate statements,
   * not one snapshot.
   */
  async lint(entityId: string): Promise<WikiLintReport> {
    const health = await this.lintRepo.countFactHealth(entityId);
    const danglingEdges = await this.lintRepo.countDanglingEdges(entityId);
    const danglingEdgeIds = danglingEdges > 0 ? await this.lintRepo.sampleDanglingEdgeIds(entityId, LINT_SAMPLE_SIZE) : [];

    const { mode, manifest } = await this.ontologyService.getEffectiveState(entityId);
    const constrained = mode !== 'off'
      && ((manifest.node_types?.length ?? 0) > 0 || (manifest.edge_types?.length ?? 0) > 0);
    let manifestViolations = 0;
    const manifestViolationEdgeIds: string[] = [];
    if (constrained) {
      let after = '';
      for (;;) {
        const page = await this.lintRepo.pageLiveEdges(entityId, after, LINT_PAGE_SIZE);
        for (const e of page) {
          if (!edgeTripleAllowed(manifest, e.edge_type, e.source_type ?? '', e.target_type ?? '')) {
            manifestViolations++;
            if (manifestViolationEdgeIds.length < LINT_SAMPLE_SIZE) manifestViolationEdgeIds.push(e.id);
          }
        }
        if (page.length < LINT_PAGE_SIZE) break;
        after = page[page.length - 1].id;
      }
    }

    return {
      danglingEdges,
      manifestViolations,
      ...health,
      sample: { danglingEdgeIds, manifestViolationEdgeIds },
    };
  }
}

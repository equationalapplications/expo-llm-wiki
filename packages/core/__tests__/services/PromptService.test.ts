import { describe, it, expect } from 'vitest';
import { PromptService } from '../../src/services/PromptService';
import {
  INGEST_SYSTEM_PROMPT,
  LIBRARIAN_SYSTEM_PROMPT,
  HEAL_SYSTEM_PROMPT,
} from '../../src/prompts';

describe('PromptService', () => {
  describe('buildIngestPrompt', () => {
    it('falls back to base INGEST_SYSTEM_PROMPT when no overrides', () => {
      const svc = new PromptService();
      const { systemPrompt, userPrompt } = svc.buildIngestPrompt('hello doc');
      expect(systemPrompt).toBe(INGEST_SYSTEM_PROMPT);
      expect(userPrompt).toBe('Document Chunk:\nhello doc');
    });

    it('uses global override over base', () => {
      const svc = new PromptService({ ingestSystemPrompt: 'global ingest' });
      const { systemPrompt } = svc.buildIngestPrompt('chunk');
      expect(systemPrompt).toBe('global ingest');
    });

    it('uses runtime override over global', () => {
      const svc = new PromptService({ ingestSystemPrompt: 'global ingest' });
      const { systemPrompt } = svc.buildIngestPrompt('chunk', 'runtime ingest');
      expect(systemPrompt).toBe('runtime ingest');
    });

    it('hydrates {{documentChunk}} into systemPrompt when present', () => {
      const svc = new PromptService();
      const template = 'Process this: {{documentChunk}}';
      const { systemPrompt, userPrompt } = svc.buildIngestPrompt('my content', template);
      expect(systemPrompt).toBe('Process this: my content');
      expect(userPrompt).toBe('Please extract the facts.');
    });

    it('leaves un-hydrated {{unknown}} tags intact', () => {
      const svc = new PromptService();
      const template = 'Data: {{documentChunk}} Extra: {{unknown}}';
      const { systemPrompt } = svc.buildIngestPrompt('val', template);
      expect(systemPrompt).toBe('Data: val Extra: {{unknown}}');
    });
  });

  describe('buildLibrarianPrompt', () => {
    it('falls back to base LIBRARIAN_SYSTEM_PROMPT', () => {
      const svc = new PromptService();
      const { systemPrompt, userPrompt } = svc.buildLibrarianPrompt([{ id: 'e1' }], [{ id: 'f1' }]);
      expect(systemPrompt).toBe(LIBRARIAN_SYSTEM_PROMPT);
      expect(userPrompt).toContain('Events:');
      expect(userPrompt).toContain('Current Facts:');
    });

    it('uses global librarianSystemPrompt override', () => {
      const svc = new PromptService({ librarianSystemPrompt: 'global lib' });
      const { systemPrompt } = svc.buildLibrarianPrompt([], []);
      expect(systemPrompt).toBe('global lib');
    });

    it('uses runtime override over global', () => {
      const svc = new PromptService({ librarianSystemPrompt: 'global lib' });
      const { systemPrompt } = svc.buildLibrarianPrompt([], [], 'runtime lib');
      expect(systemPrompt).toBe('runtime lib');
    });

    it('hydrates {{events}} and {{currentFacts}} into systemPrompt', () => {
      const svc = new PromptService();
      const events = [{ id: 'e1', summary: 'did thing' }];
      const facts = [{ id: 'f1', title: 'fact one' }];
      const template = 'Events: {{events}} Facts: {{currentFacts}}';
      const { systemPrompt, userPrompt } = svc.buildLibrarianPrompt(events, facts, template);
      expect(systemPrompt).toContain('"did thing"');
      expect(systemPrompt).toContain('"fact one"');
      expect(userPrompt).toBe('Please synthesize the context.');
    });

    it('leaves un-hydrated {{unknown}} tags intact', () => {
      const svc = new PromptService();
      const template = 'Events: {{events}} Extra: {{unknown}}';
      const { systemPrompt } = svc.buildLibrarianPrompt([{ id: 'e1' }], [], template);
      expect(systemPrompt).toContain('{{unknown}}');
    });
  });

  describe('buildHealPrompt', () => {
    it('falls back to base HEAL_SYSTEM_PROMPT', () => {
      const svc = new PromptService();
      const { systemPrompt, userPrompt } = svc.buildHealPrompt([], [], [], []);
      expect(systemPrompt).toBe(HEAL_SYSTEM_PROMPT);
      expect(userPrompt).toContain('Heal Candidates:');
    });

    it('uses global healSystemPrompt override', () => {
      const svc = new PromptService({ healSystemPrompt: 'global heal' });
      const { systemPrompt } = svc.buildHealPrompt([], [], [], []);
      expect(systemPrompt).toBe('global heal');
    });

    it('uses runtime override over global', () => {
      const svc = new PromptService({ healSystemPrompt: 'global heal' });
      const { systemPrompt } = svc.buildHealPrompt([], [], [], [], 'runtime heal');
      expect(systemPrompt).toBe('runtime heal');
    });

    it('hydrates {{healCandidates}} into systemPrompt', () => {
      const svc = new PromptService();
      const candidates = [{ id: 'f1', title: 'stale fact' }];
      const template = 'Candidates: {{healCandidates}}';
      const { systemPrompt, userPrompt } = svc.buildHealPrompt(candidates, [], [], [], template);
      expect(systemPrompt).toContain('"stale fact"');
      expect(userPrompt).toBe('Please heal the memory graph.');
    });

    it('leaves un-hydrated {{unknown}} tags intact', () => {
      const svc = new PromptService();
      const template = 'Candidates: {{healCandidates}} Extra: {{unknown}}';
      const { systemPrompt } = svc.buildHealPrompt([{ id: 'f1' }], [], [], [], template);
      expect(systemPrompt).toContain('{{unknown}}');
    });

    it('hydrates {{recentEvents}} even without primary heal variables', () => {
      const svc = new PromptService();
      const events = [{ id: 'ev1', summary: 'recent thing' }];
      const template = 'Recent: {{recentEvents}}';
      const { systemPrompt, userPrompt } = svc.buildHealPrompt([], [], [], events, template);
      expect(systemPrompt).toContain('"recent thing"');
      expect(userPrompt).toBe('Please heal the memory graph.');
    });
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as CoreLlmTools from '../src/index';
import legacy7152 from './fixtures/legacy-declarations-7.15.2.json';

// SynapseTree spec R6 §3.5.1 (2026-11-02): the rename is additive. These tests
// cover the map, the single warning, and the continued export and name-only
// derivation of the legacy declarations.

const PAIRS = [
  ['wikiTraverseGraphManifest', 'graphTraverseManifest', 'wiki_traverse_graph', 'graph_traverse'],
  ['wikiGetOntologyManifest', 'ontologyGetManifest', 'wiki_get_ontology', 'ontology_get'],
  ['wikiGetInstructionsManifest', 'instructionsGetManifest', 'wiki_get_instructions', 'instructions_get'],
] as const;

describe('LEGACY_TOOL_NAMES', () => {
  it('maps exactly the three wiki_* names to their canonical twins', () => {
    expect(CoreLlmTools.LEGACY_TOOL_NAMES).toEqual(Object.fromEntries(PAIRS.map(([, , from, to]) => [from, to])));
    expect(Object.isFrozen(CoreLlmTools.LEGACY_TOOL_NAMES)).toBe(true);
  });
});

describe('legacy declarations', () => {
  it.each(PAIRS)('%s stays exported and is %s with only the name substituted', (legacyExport, canonicalExport, legacyName, canonicalName) => {
    const legacyM = CoreLlmTools[legacyExport];
    const canonicalM = CoreLlmTools[canonicalExport];
    expect(canonicalM.name).toBe(canonicalName);
    expect(canonicalM.schema.name).toBe(canonicalName);
    expect(legacyM.name).toBe(legacyName);
    expect(legacyM.schema.name).toBe(legacyName);
    expect(legacyM).toEqual({ ...canonicalM, name: legacyName, schema: { ...canonicalM.schema, name: legacyName } });
  });

  it('an unchanged host sends byte-identical declarations to 7.15.2', () => {
    for (const [legacyExport] of PAIRS) {
      expect(JSON.stringify(CoreLlmTools[legacyExport])).toBe(JSON.stringify(legacy7152[legacyExport]));
    }
  });

  it.each(PAIRS)('%s shares no nested object with %s', (legacyExport, canonicalExport) => {
    const legacyM = CoreLlmTools[legacyExport];
    const canonicalM = CoreLlmTools[canonicalExport];
    expect(legacyM.schema).not.toBe(canonicalM.schema);
    expect(legacyM.schema.parameters).toBeDefined();
    expect(legacyM.schema.parameters).not.toBe(canonicalM.schema.parameters);
    expect(legacyM.schema.parameters?.properties).not.toBe(canonicalM.schema.parameters?.properties);
  });

  it('the canonical and legacy name sets do not overlap', () => {
    const canonical = new Set(PAIRS.map(([, c]) => CoreLlmTools[c].name));
    for (const [l] of PAIRS) expect(canonical.has(CoreLlmTools[l].name)).toBe(false);
  });
});

describe('canonicalToolName', () => {
  const WARNED = Symbol.for('equationalapplications.core-llm-tools.canonicalToolName.warned');
  const resetFlag = () => {
    delete (globalThis as Record<symbol, unknown>)[WARNED];
  };

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    resetFlag();
  });

  async function fresh() {
    vi.resetModules();
    resetFlag();
    return (await import('../src/legacy')).canonicalToolName;
  }

  it('maps each legacy name to its canonical name', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const canonicalToolName = await fresh();
    for (const [, , from, to] of PAIRS) expect(canonicalToolName(from)).toBe(to);
  });

  it('returns canonical and unknown names unchanged, without warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const canonicalToolName = await fresh();
    for (const name of ['graph_traverse', 'ontology_get', 'instructions_get', 'get_current_time', 'toString', '__proto__', '']) {
      expect(canonicalToolName(name)).toBe(name);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('a non-legacy name does not use up the single warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const canonicalToolName = await fresh();
    canonicalToolName('graph_traverse');
    canonicalToolName('get_current_time');
    expect(warn).not.toHaveBeenCalled();
    canonicalToolName('wiki_traverse_graph');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('warns once per process, naming the replacement, however many legacy names it maps', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const canonicalToolName = await fresh();
    canonicalToolName('wiki_get_ontology');
    canonicalToolName('wiki_get_ontology');
    canonicalToolName('wiki_traverse_graph');
    canonicalToolName('wiki_get_instructions');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('"wiki_get_ontology" is deprecated; use "ontology_get"');
    expect(warn.mock.calls[0][0]).toContain('wiki_traverse_graph → graph_traverse');
  });

  it('two module instances (CJS + ESM in one process) still warn only once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = await fresh();
    vi.resetModules(); // second instance, flag deliberately NOT reset
    const second = (await import('../src/legacy')).canonicalToolName;
    expect(second).not.toBe(first);
    first('wiki_get_ontology');
    second('wiki_traverse_graph');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

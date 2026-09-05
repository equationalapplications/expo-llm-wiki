import { describe, it, expect } from 'vitest';
import { AUTHORIZED_SCOPES, isAuthorizedScope } from '../src/scopes';
import { buildAuthorizedToolsArray } from '../src/injector';
import type { AgentToolManifest } from '../src/types';

describe('AUTHORIZED_SCOPES', () => {
  it('is non-empty and contains the always-on core scope', () => {
    expect(AUTHORIZED_SCOPES.length).toBeGreaterThan(0);
    expect(AUTHORIZED_SCOPES).toContain('core');
  });

  it('isAuthorizedScope accepts every listed scope', () => {
    for (const scope of AUTHORIZED_SCOPES) {
      expect(isAuthorizedScope(scope)).toBe(true);
    }
  });

  it('isAuthorizedScope rejects scopes not in the list', () => {
    expect(isAuthorizedScope('memory:write')).toBe(false);
    expect(isAuthorizedScope('totally:unknown')).toBe(false);
    expect(isAuthorizedScope('')).toBe(false);
  });
});

describe('injector honors AUTHORIZED_SCOPES without a grant', () => {
  const manifestFor = (scope: string): AgentToolManifest =>
    ({
      name: `tool_${scope}`,
      scope,
      schema: { name: `tool_${scope}`, description: 'probe', parameters: { type: 'object', properties: {} } },
    }) as unknown as AgentToolManifest;

  it('advertises every always-on scope when userGrantedScopes is empty', () => {
    const manifests = AUTHORIZED_SCOPES.map((s) => manifestFor(s));
    const entries = buildAuthorizedToolsArray(manifests, []);
    const declared = entries.flatMap((e) => ('functionDeclarations' in e ? e.functionDeclarations : []));
    expect(declared).toHaveLength(AUTHORIZED_SCOPES.length);
    expect(buildAuthorizedToolsArray(manifests, [])).toHaveLength(AUTHORIZED_SCOPES.length);
  });

  it('excludes an ungranted scope that is not always-on', () => {
    const manifests = [manifestFor('memory:write')];
    const entries = buildAuthorizedToolsArray(manifests, []);
    const declared = entries.flatMap((e) => ('functionDeclarations' in e ? e.functionDeclarations : []));
    expect(declared).toHaveLength(0);
    expect(buildAuthorizedToolsArray(manifests, [])).toHaveLength(0);
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONTRACT_INFO, OPERATIONS, OPERATION_IDS, WITHHELD_OPERATION_IDS } from '../src/contract';

const rawContract = readFileSync(new URL('../contract/synapsetree-openapi.subset.json', import.meta.url), 'utf8');

describe('vendored contract (spec §10.2 guard 3: D3 absence)', () => {
  it('lists exactly the eleven operations the server uses', () => {
    expect([...CONTRACT_INFO.operations].sort()).toEqual([...OPERATION_IDS].sort());
    expect(OPERATION_IDS).toHaveLength(11);
  });

  it('contains none of the memory:admin operations withheld from agents', () => {
    for (const id of WITHHELD_OPERATION_IDS) {
      expect(rawContract).not.toContain(`"operationId": "${id}"`);
    }
    expect(WITHHELD_OPERATION_IDS).toEqual([
      'exportMemory', 'importMemory', 'forgetFact', 'forgetSource',
      'deleteNamespace', 'createMaintenanceRun', 'putOntology',
    ]);
  });

  it('is marked generated, not hand-edited', () => {
    expect(rawContract).toContain('"x-generated-by"');
  });
});

describe('OPERATIONS table (spec §5.1)', () => {
  it('derives rememberFact', () => {
    const op = OPERATIONS.rememberFact;
    expect(op.method).toBe('POST');
    expect(op.path).toBe('/v1/memory/facts');
    expect(op.scope).toBe('read_write');
    expect(op.acceptsIdempotencyKey).toBe(true);
    expect(op.pathParameters).toEqual([]);
    expect(op.requestProperties).toEqual(expect.arrayContaining(['namespace', 'title', 'body', 'tags', 'confidence', 'sourceType', 'okfType', 'validFrom']));
    expect(op.requiredProperties).toEqual(expect.arrayContaining(['namespace', 'title', 'body']));
  });

  it('derives supersedeFact with its path parameter', () => {
    const op = OPERATIONS.supersedeFact;
    expect(op.path).toBe('/v1/memory/facts/{factId}/supersede');
    expect(op.pathParameters).toEqual(['factId']);
    expect(op.requestProperties).toEqual(expect.arrayContaining(['namespace', 'validFrom', 'replacement']));
    expect(op.requiredProperties).toEqual(expect.arrayContaining(['namespace', 'replacement']));
  });

  it('derives ingestDocument across its oneOf branches (union of properties, intersection of required)', () => {
    const op = OPERATIONS.ingestDocument;
    expect(op.requestProperties).toEqual(expect.arrayContaining(['mode', 'namespace', 'sourceRef', 'sourceHash', 'content', 'onDuplicateHash', 'chunks', 'planFingerprint']));
    expect(op.requiredProperties).toEqual(expect.arrayContaining(['mode', 'namespace', 'sourceRef', 'sourceHash']));
    expect(op.requiredProperties).not.toContain('content');
  });

  it('derives listNamespaces as a GET with query parameters and no idempotency key', () => {
    const op = OPERATIONS.listNamespaces;
    expect(op.method).toBe('GET');
    expect(op.queryParameters.sort()).toEqual(['after', 'limit', 'prefix']);
    expect(op.acceptsIdempotencyKey).toBe(false);
    expect(op.requestProperties).toEqual([]);
  });

  it('marks the auth.md endpoints as unscoped', () => {
    expect(OPERATIONS.registerAgentIdentity.scope).toBeNull();
    expect(OPERATIONS.oauthToken.scope).toBeNull();
    expect(OPERATIONS.oauthRevoke.scope).toBeNull();
    expect(OPERATIONS.oauthToken.requiredProperties.sort()).toEqual(['assertion', 'grant_type']);
    expect(OPERATIONS.oauthRevoke.requiredProperties).toEqual(['token']);
  });

  it('reads scopes for every read tool operation', () => {
    for (const id of ['queryMemory', 'traverseGraph', 'listNamespaces', 'whoami'] as const) {
      expect(OPERATIONS[id].scope).toBe('read');
    }
  });
});

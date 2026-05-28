import { describe, it, expectTypeOf } from 'vitest';
import type { AgentScope, AgentToolManifest } from '../src/types';

describe('AgentScope', () => {
  it('accepts all valid scope literals', () => {
    const scopes: AgentScope[] = [
      'core',
      'location:read',
      'calendar:read',
      'calendar:write',
      'messages:send',
      'memory:read',
      'memory:write',
    ];
    expectTypeOf(scopes).toMatchTypeOf<AgentScope[]>();
  });
});

describe('AgentToolManifest', () => {
  it('requires name, scope, and schema fields', () => {
    expectTypeOf<AgentToolManifest>().toHaveProperty('name');
    expectTypeOf<AgentToolManifest>().toHaveProperty('scope');
    expectTypeOf<AgentToolManifest>().toHaveProperty('schema');
  });

  it('schema requires name and description', () => {
    type Schema = AgentToolManifest['schema'];
    expectTypeOf<Schema>().toHaveProperty('name');
    expectTypeOf<Schema>().toHaveProperty('description');
  });
});

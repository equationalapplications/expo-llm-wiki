import { describe, it, expectTypeOf } from 'vitest';
import type {
  AgentScope,
  AgentToolManifest,
  AnyAgentToolManifest,
  FunctionToolManifest,
  BuiltInToolManifest,
  BuiltInToolName,
} from '../src/types';

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

describe('FunctionToolManifest', () => {
  it('requires name, scope, and schema fields', () => {
    expectTypeOf<FunctionToolManifest>().toHaveProperty('name');
    expectTypeOf<FunctionToolManifest>().toHaveProperty('scope');
    expectTypeOf<FunctionToolManifest>().toHaveProperty('schema');
  });

  it('schema requires name and description', () => {
    type Schema = FunctionToolManifest['schema'];
    expectTypeOf<Schema>().toHaveProperty('name');
    expectTypeOf<Schema>().toHaveProperty('description');
  });

  it('kind is optional and, when present, is the literal "function"', () => {
    expectTypeOf<FunctionToolManifest['kind']>().toEqualTypeOf<'function' | undefined>();
  });

  it('a manifest literal without a kind field type-checks as FunctionToolManifest', () => {
    const manifest: FunctionToolManifest = {
      name: 'legacy_tool',
      scope: 'core',
      schema: { name: 'legacy_tool', description: 'no kind field' },
    };
    expectTypeOf(manifest).toMatchTypeOf<FunctionToolManifest>();
  });
});

describe('BuiltInToolManifest', () => {
  it('requires name, scope, kind, and builtIn fields', () => {
    expectTypeOf<BuiltInToolManifest>().toHaveProperty('name');
    expectTypeOf<BuiltInToolManifest>().toHaveProperty('scope');
    expectTypeOf<BuiltInToolManifest>().toHaveProperty('kind');
    expectTypeOf<BuiltInToolManifest>().toHaveProperty('builtIn');
  });

  it('kind is the literal "built_in"', () => {
    expectTypeOf<BuiltInToolManifest['kind']>().toEqualTypeOf<'built_in'>();
  });

  it('builtIn is constrained to BuiltInToolName', () => {
    expectTypeOf<BuiltInToolManifest['builtIn']>().toEqualTypeOf<BuiltInToolName>();
  });

  it('name matches builtIn (both BuiltInToolName)', () => {
    expectTypeOf<BuiltInToolManifest['name']>().toEqualTypeOf<BuiltInToolName>();
  });
});

describe('AgentToolManifest', () => {
  it('is an alias for FunctionToolManifest', () => {
    expectTypeOf<AgentToolManifest>().toEqualTypeOf<FunctionToolManifest>();
  });

  it('allows direct schema access without narrowing', () => {
    const manifest: AgentToolManifest = {
      name: 'legacy_tool',
      scope: 'core',
      schema: { name: 'legacy_tool', description: 'stable contract' },
    };
    expectTypeOf(manifest.schema).toMatchTypeOf<FunctionToolManifest['schema']>();
  });
});

describe('AnyAgentToolManifest', () => {
  it('is the union of FunctionToolManifest and BuiltInToolManifest', () => {
    expectTypeOf<AnyAgentToolManifest>().toEqualTypeOf<
      FunctionToolManifest | BuiltInToolManifest
    >();
  });
});

describe('BuiltInToolName', () => {
  it('includes "google_search"', () => {
    expectTypeOf<'google_search'>().toMatchTypeOf<BuiltInToolName>();
  });
});

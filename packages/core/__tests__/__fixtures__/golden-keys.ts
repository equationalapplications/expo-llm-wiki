/**
 * The key contract of guidance-golden.json, mirrored from
 * capture-guidance-golden.ts so the parity test can assert the fixture's
 * key set (drift between generator, fixture and test is caught, not
 * silent). Keep in sync with the generator.
 */
export const OUT = [
  'ingest/plain/default',
  'ingest/plain/runtimeOverride',
  'ingest/plain/ontology',
  'librarian/plain/builtin',
  'librarian/plain/runtimeOverride',
  'librarian/plain/ontology',
  'opsExtract/plain',
  'opsExtract/plain/ontology',
  'ingest/overridden/default',
  'ingest/overridden/runtimeOverride',
  'ingest/overridden/ontology',
  'librarian/overridden/runtimeOverride',
  'opsExtract/overridden',
  'opsExtract/overridden/ontology',
  'ingest/grounded/default',
  'ingest/grounded/runtimeOverride',
  'ingest/grounded/ontology',
  'librarian/grounded/builtin',
  'librarian/grounded/runtimeOverride',
  'librarian/grounded/ontology',
  'opsExtract/grounded',
  'opsExtract/grounded/ontology',
  'instructions/plain/legacy',
  'instructions/plain/ops',
  'instructions/overridden/ops',
];

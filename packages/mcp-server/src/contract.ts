import contractJson from '../contract/synapsetree-openapi.subset.json';

export type OperationId =
  | 'queryMemory'
  | 'rememberFact'
  | 'supersedeFact'
  | 'ingestDocument'
  | 'createEvent'
  | 'traverseGraph'
  | 'listNamespaces'
  | 'whoami'
  | 'registerAgentIdentity'
  | 'oauthToken'
  | 'oauthRevoke';

export const OPERATION_IDS: readonly OperationId[] = [
  'queryMemory',
  'rememberFact',
  'supersedeFact',
  'ingestDocument',
  'createEvent',
  'traverseGraph',
  'listNamespaces',
  'whoami',
  'registerAgentIdentity',
  'oauthToken',
  'oauthRevoke',
];

/** memory:admin operations withheld from agents (SynapseTree ruling D3). Never called, never vendored. */
export const WITHHELD_OPERATION_IDS: readonly string[] = [
  'exportMemory',
  'importMemory',
  'forgetFact',
  'forgetSource',
  'deleteNamespace',
  'createMaintenanceRun',
  'putOntology',
];

export interface Operation {
  operationId: OperationId;
  method: 'GET' | 'POST';
  path: string;
  scope: 'read' | 'read_write' | null;
  /** Top-level request-body property names (union across oneOf/anyOf/allOf branches). */
  requestProperties: string[];
  /** Properties required in every branch. */
  requiredProperties: string[];
  queryParameters: string[];
  pathParameters: string[];
  acceptsIdempotencyKey: boolean;
}

// The subset is a plain OpenAPI 3 document; only the parts below are read.
type Json = Record<string, unknown>;
interface OpenApiDoc {
  info: Json & { version?: string; 'x-operations'?: string[] };
  paths: Record<string, Record<string, unknown>>;
  components: Record<string, Record<string, unknown>>;
}

const doc = contractJson as unknown as OpenApiDoc;

function resolve(node: unknown): Json | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const ref = (node as Json).$ref;
  if (typeof ref === 'string') {
    const [, , kind, name] = ref.split('/');
    return resolve(doc.components[kind]?.[name]);
  }
  return node as Json;
}

function shape(schema: unknown): { props: Set<string>; required: Set<string> } {
  const props = new Set<string>();
  const required = new Set<string>();
  const s = resolve(schema);
  if (!s) return { props, required };
  const branches = (s.oneOf ?? s.anyOf) as unknown[] | undefined;
  if (branches && branches.length > 0) {
    const shapes = branches.map(shape);
    for (const sh of shapes) for (const p of sh.props) props.add(p);
    for (const p of shapes[0].required) if (shapes.every((sh) => sh.required.has(p))) required.add(p);
  }
  for (const part of (s.allOf as unknown[] | undefined) ?? []) {
    const sh = shape(part);
    for (const p of sh.props) props.add(p);
    for (const p of sh.required) required.add(p);
  }
  for (const p of Object.keys((s.properties as Json | undefined) ?? {})) props.add(p);
  for (const p of (s.required as string[] | undefined) ?? []) required.add(p);
  return { props, required };
}

function parameters(pathItem: Record<string, unknown>, op: Json): Json[] {
  const raw = [...((pathItem.parameters as unknown[]) ?? []), ...((op.parameters as unknown[]) ?? [])];
  return raw.map((p) => resolve(p)).filter((p): p is Json => p !== undefined);
}

function build(): Record<OperationId, Operation> {
  const table = {} as Record<OperationId, Operation>;
  for (const [path, pathItem] of Object.entries(doc.paths)) {
    for (const method of ['get', 'post'] as const) {
      const op = pathItem[method] as Json | undefined;
      if (!op) continue;
      const id = op.operationId as OperationId;
      if (!OPERATION_IDS.includes(id)) continue;
      const params = parameters(pathItem, op);
      const body = resolve(op.requestBody);
      const content = (body?.content as Record<string, Json> | undefined) ?? {};
      const media = Object.values(content)[0];
      const { props, required } = shape(media?.schema);
      table[id] = {
        operationId: id,
        method: method.toUpperCase() as 'GET' | 'POST',
        path,
        scope: (op['x-synapsetree-scope'] as 'read' | 'read_write' | undefined) ?? null,
        requestProperties: [...props],
        requiredProperties: [...required],
        queryParameters: params.filter((p) => p.in === 'query').map((p) => String(p.name)),
        pathParameters: params.filter((p) => p.in === 'path').map((p) => String(p.name)),
        acceptsIdempotencyKey: params.some((p) => p.in === 'header' && p.name === 'Idempotency-Key'),
      };
    }
  }
  const missing = OPERATION_IDS.filter((id) => !(id in table));
  if (missing.length > 0) throw new Error(`contract subset is missing operations: ${missing.join(', ')}`);
  return table;
}

export const OPERATIONS: Readonly<Record<OperationId, Operation>> = build();

export const CONTRACT_INFO = {
  version: String(doc.info.version ?? ''),
  operations: [...(doc.info['x-operations'] ?? [])],
};

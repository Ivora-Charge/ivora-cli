import type { JsonSchema } from './json-schema.js';

/**
 * Where the generated parts of the ivora.yaml schema come from (design 1.2): each section that
 * maps to a resource with a request body in the /v1 OpenAPI document takes its item schema from
 * that operation's request body. The operationIds are recorded here; a test compares them to a
 * pinned snapshot of the OpenAPI operation ids, so a renamed operation breaks the build.
 */
export const SCHEMA_SOURCES = {
  stations: 'stations_register_a_station_and_return_it',
} as const;

export type SchemaSection = keyof typeof SCHEMA_SOURCES;

export type RequestBodySchemas = Record<string, JsonSchema>;

interface SpecLike {
  paths?: Record<string, Record<string, unknown>>;
  components?: Record<string, unknown>;
}

function resolveRefs(node: unknown, spec: SpecLike, seen: string[] = []): unknown {
  if (Array.isArray(node)) return node.map((n) => resolveRefs(n, spec, seen));
  if (node === null || typeof node !== 'object') return node;
  const obj = node as Record<string, unknown>;
  if (typeof obj['$ref'] === 'string') {
    const ref = obj['$ref'];
    if (!ref.startsWith('#/')) throw new Error(`unsupported $ref ${ref}`);
    if (seen.includes(ref)) throw new Error(`recursive $ref ${ref}`);
    let target: unknown = spec;
    for (const part of ref.slice(2).split('/')) {
      target = (target as Record<string, unknown> | undefined)?.[part];
    }
    if (target === undefined) throw new Error(`unresolved $ref ${ref}`);
    return resolveRefs(target, spec, [...seen, ref]);
  }
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, resolveRefs(v, spec, seen)]));
}

/** Every operationId in the spec, sorted. */
export function specOperationIds(spec: SpecLike): string[] {
  const ids: string[] = [];
  for (const item of Object.values(spec.paths ?? {})) {
    for (const op of Object.values(item)) {
      const id = (op as { operationId?: unknown } | null)?.operationId;
      if (typeof id === 'string') ids.push(id);
    }
  }
  return ids.sort();
}

/** The JSON request-body schema (references inlined) of an operation, or undefined. */
export function requestBodySchema(spec: SpecLike, operationId: string): JsonSchema | undefined {
  for (const item of Object.values(spec.paths ?? {})) {
    for (const op of Object.values(item)) {
      const o = op as {
        operationId?: string;
        requestBody?: { content?: Record<string, { schema?: unknown }> };
      } | null;
      if (o?.operationId !== operationId) continue;
      const schema = o.requestBody?.content?.['application/json']?.schema;
      return schema === undefined ? undefined : (resolveRefs(schema, spec) as JsonSchema);
    }
  }
  return undefined;
}

/** Extracts the request-body schema of every source operation. Throws on a missing one. */
export function extractRequestBodies(spec: SpecLike): RequestBodySchemas {
  const out: RequestBodySchemas = {};
  for (const operationId of Object.values(SCHEMA_SOURCES)) {
    const schema = requestBodySchema(spec, operationId);
    if (!schema) throw new Error(`operation ${operationId} has no JSON request body in the spec`);
    out[operationId] = schema;
  }
  return out;
}

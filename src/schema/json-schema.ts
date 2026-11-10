/**
 * A small JSON Schema checker for the subset the ivora.yaml schema uses: type, enum, const,
 * required, properties, additionalProperties, items, minItems, minLength, maxLength, pattern,
 * minimum, maximum, anyOf, oneOf. Other keywords are ignored. It exists so `ivora validate`
 * needs no schema-engine dependency and runs offline.
 */

export type JsonSchema = {
  type?: string | string[];
  nullable?: boolean;
  enum?: unknown[];
  const?: unknown;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  minItems?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  description?: string;
  [keyword: string]: unknown;
};

export interface SchemaIssue {
  /** Path to the value, e.g. `stations[0].password`; empty for the document root. */
  path: string;
  message: string;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  const t = typeOf(value);
  if (type === 'integer') return t === 'number' && Number.isInteger(value);
  return t === type;
}

function child(path: string, key: string | number): string {
  if (typeof key === 'number') return `${path}[${key}]`;
  return path ? `${path}.${key}` : key;
}

export function checkSchema(value: unknown, schema: JsonSchema, path = ''): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const at = (message: string): void => {
    issues.push({ path, message });
  };

  if (value === null && schema.nullable === true) return issues;

  if (schema.anyOf || schema.oneOf) {
    const options = schema.anyOf ?? schema.oneOf ?? [];
    const results = options.map((s) => checkSchema(value, s, path));
    const passing = results.filter((r) => r.length === 0).length;
    if (passing === 0) {
      // Report the closest option (fewest issues) so the message stays actionable.
      const best = results.reduce((a, b) => (b.length < a.length ? b : a), results[0] ?? []);
      return best.length > 0 ? best : [{ path, message: 'does not match any allowed shape' }];
    }
    if (schema.oneOf && passing > 1) at('matches more than one allowed shape');
    return issues;
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      at(`must be ${types.join(' or ')}, got ${typeOf(value)}`);
      return issues;
    }
  }
  if (schema.const !== undefined && value !== schema.const) {
    at(`must be ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    at(`must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength)
      at(`must be at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      at(`must be at most ${schema.maxLength} characters`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value))
      at(`does not match the required format (${schema.pattern})`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) at(`must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) at(`must be <= ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      at(`must have at least ${schema.minItems} item(s)`);
    if (schema.items) {
      value.forEach((item, i) => {
        issues.push(...checkSchema(item, schema.items as JsonSchema, child(path, i)));
      });
    }
  }
  if (typeOf(value) === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) issues.push({ path: child(path, key), message: 'is required' });
    }
    const props = schema.properties ?? {};
    for (const [key, v] of Object.entries(obj)) {
      const sub = props[key];
      if (sub) {
        issues.push(...checkSchema(v, sub, child(path, key)));
      } else if (schema.additionalProperties === false) {
        issues.push({ path: child(path, key), message: 'is not a known field' });
      } else if (typeof schema.additionalProperties === 'object') {
        issues.push(...checkSchema(v, schema.additionalProperties, child(path, key)));
      }
    }
  }
  return issues;
}

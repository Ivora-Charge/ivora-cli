import { parseDocument } from 'yaml';
import { buildSchema } from './index.js';
import { checkSchema, type SchemaIssue } from './json-schema.js';
import { ADMIN_SECTIONS } from './handwritten.js';

export interface ValidationResult {
  issues: SchemaIssue[];
  /** Sections present in the file but not checked, with the reason. */
  skipped: { section: string; reason: string }[];
}

const PLACEHOLDER = /\bTODO\b|<[^<>]*>/i;
const SECRET_KEY = /(^|_)(password|secret|token|api_?key|private_?key)$/i;

function child(path: string, key: string | number): string {
  return typeof key === 'number' ? `${path}[${key}]` : path ? `${path}.${key}` : key;
}

/** Placeholder values (TODO, <...>, empty values) and inline secrets are errors. */
function scan(node: unknown, path: string, issues: SchemaIssue[]): void {
  if (node === null || node === undefined) {
    issues.push({ path, message: 'is empty (placeholder)' });
  } else if (typeof node === 'string') {
    if (node.trim() === '') issues.push({ path, message: 'is empty (placeholder)' });
    else if (PLACEHOLDER.test(node))
      issues.push({ path, message: 'is a placeholder (TODO or <...>); fill it in' });
  } else if (Array.isArray(node)) {
    node.forEach((n, i) => scan(n, child(path, i), issues));
  } else if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string' && SECRET_KEY.test(k) && v.trim() !== '') {
        issues.push({
          path: child(path, k),
          message: 'secrets are references only; use { secret_ref: "env:NAME" }',
        });
      }
      scan(v, child(path, k), issues);
    }
  }
}

/** Parses and checks ivora.yaml text offline. Never reads the environment or the network. */
export function validateText(text: string): ValidationResult {
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length > 0) {
    return {
      issues: doc.errors.map((e) => ({ path: '', message: `YAML: ${e.message.split('\n')[0]}` })),
      skipped: [],
    };
  }
  const value: unknown = doc.toJS({ maxAliasCount: 50 });
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {
      issues: [{ path: '', message: 'must be a mapping with a "version" key' }],
      skipped: [],
    };
  }
  const skipped: ValidationResult['skipped'] = [];
  const checked: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    const reason = ADMIN_SECTIONS[key];
    if (reason !== undefined) skipped.push({ section: key, reason });
    else checked[key] = v;
  }
  const issues = checkSchema(checked, buildSchema());
  scan(checked, '', issues);
  return { issues, skipped };
}

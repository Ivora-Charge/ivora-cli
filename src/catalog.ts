/**
 * The command catalog: every (method, path) in the API spec is either mapped to a command or
 * excluded with a reason. The catalog test fails on a spec operation that is neither, so a new
 * API operation is a deliberate decision. Resource commands fill this in from the OpenAPI
 * snapshot; the scaffold lists only the operations the first commands use.
 */

export interface CatalogEntry {
  method: string;
  path: string;
  command: string;
}

export interface Exclusion {
  method: string;
  path: string;
  reason: string;
}

export const COMMANDS: readonly CatalogEntry[] = [
  { method: 'GET', path: '/v1/access', command: 'whoami' },
  { method: 'GET', path: '/v1/capabilities', command: 'whoami' },
  { method: 'GET', path: '/v1/tenants/{tenant_id}/stations', command: 'stations list' },
  {
    method: 'GET',
    path: '/v1/tenants/{tenant_id}/stations/{station_id}',
    command: 'stations show',
  },
  { method: 'POST', path: '/v1/tenants/{tenant_id}/stations', command: 'stations add' },
];

export const EXCLUDED: readonly Exclusion[] = [];

/** Path prefixes that are never commands (the CLI ships no staff commands). */
export const EXCLUDED_PREFIXES = ['/v1/admin', '/v1/host', '/v1/internal'] as const;

const HTTP_METHODS = ['get', 'put', 'post', 'patch', 'delete'] as const;

export interface SpecLike {
  paths?: Record<string, Record<string, unknown>>;
}

export function specOperations(spec: SpecLike): { method: string; path: string }[] {
  const ops: { method: string; path: string }[] = [];
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const m of HTTP_METHODS) {
      if (item[m] !== undefined) ops.push({ method: m.toUpperCase(), path });
    }
  }
  return ops;
}

function isExcludedPrefix(path: string): boolean {
  return EXCLUDED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

export interface CatalogCheck {
  /** Spec operations neither mapped nor excluded. */
  unlisted: string[];
  /** Catalog entries that are not in the spec. */
  unknown: string[];
  /** Catalog commands under a staff prefix. */
  staff: string[];
}

export function checkCatalog(
  spec: SpecLike,
  commands: readonly CatalogEntry[] = COMMANDS,
  excluded: readonly Exclusion[] = EXCLUDED,
): CatalogCheck {
  const key = (o: { method: string; path: string }): string => `${o.method} ${o.path}`;
  const specOps = specOperations(spec);
  const ops = new Set(specOps.map(key));
  const listed = new Set([...commands, ...excluded].map(key));
  return {
    unlisted: specOps.filter((op) => !listed.has(key(op)) && !isExcludedPrefix(op.path)).map(key),
    unknown: [...listed].filter((op) => !ops.has(op)),
    staff: commands.filter((c) => isExcludedPrefix(c.path)).map(key),
  };
}

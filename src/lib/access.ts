import { CliError, ExitCode } from './output.js';
import type { Environment } from './profiles.js';

/** The parts of the `GET /v1/access` response the CLI reads. */
export interface Access {
  /** "test" or "production". */
  environment?: string;
  tenants?: { id: number }[];
  scopes?: string[];
  /** The key itself; newer servers only. */
  key?: {
    id?: unknown;
    prefix?: unknown;
    label?: unknown;
    created_at?: unknown;
    expires_at?: unknown;
  };
}

/**
 * The profile environment for the server's `environment` value: "production" is a live key,
 * "test" a test key. Undefined when the server does not say; an unknown value is refused, so a
 * key is never saved for the wrong environment.
 */
export function accessEnvironment(access: Access): Environment | undefined {
  if (access.environment === undefined) return undefined;
  if (access.environment === 'production') return 'live';
  if (access.environment === 'test') return 'test';
  throw new CliError(
    `The server reported an unknown environment ("${String(access.environment)}").`,
    ExitCode.Usage,
  );
}

/** The tenant ids the key can reach, as strings. */
export function accessTenantIds(access: Access): string[] {
  if (!Array.isArray(access.tenants)) return [];
  return access.tenants
    .map((t) => t?.id)
    .filter((id): id is number => typeof id === 'number' && Number.isSafeInteger(id))
    .map(String);
}

/**
 * The tenant to remember for a key: the only one it can reach. With none or several there is no
 * default, and `note` explains why.
 */
export function defaultTenant(access: Access, note: (text: string) => void): string | undefined {
  const ids = accessTenantIds(access);
  if (ids.length === 1) return ids[0];
  if (ids.length === 0) note('this key has no tenant, so no default tenant is set.');
  else
    note(`this key can reach ${ids.length} tenants (${ids.join(', ')}); no default tenant is set.`);
  return undefined;
}

/** The key details for display, when the server sends them. */
export function accessKeyInfo(access: Access): Record<string, string> | undefined {
  const key = access.key;
  if (!key || typeof key !== 'object') return undefined;
  const info: Record<string, string> = {};
  for (const field of ['id', 'prefix', 'label', 'created_at', 'expires_at'] as const) {
    const value = key[field];
    if (typeof value === 'string' || typeof value === 'number') info[field] = String(value);
  }
  return Object.keys(info).length > 0 ? info : undefined;
}

import { Command } from 'commander';
import { findOperation } from '../catalog.js';
import { accessTenantIds, type Access } from './access.js';
import type { ApiResponse } from './http.js';
import { CliError, ExitCode } from './output.js';
import { openSession, type CommandContext, type Session } from './session.js';

export type Query = Record<string, string | number | boolean | undefined>;

/**
 * Calls a cataloged operation by its operationId. The path comes from the catalog and the
 * `{param}` values are encoded here, so a command never builds a path by hand.
 */
export async function callOperation<T = unknown>(
  s: Session,
  operationId: string,
  params: Record<string, string>,
  opts: { query?: Query; body?: unknown; readOnly?: boolean } = {},
): Promise<ApiResponse<T>> {
  const op = findOperation(operationId);
  if (!op) throw new CliError(`Unknown operation: ${operationId}`, ExitCode.Usage);
  const path = op.path.replace(/\{([^}]+)\}/g, (_m, name: string) => {
    const value = params[name];
    if (value === undefined || value === '') {
      throw new CliError(`Missing value for ${name}.`, ExitCode.Usage);
    }
    return encodeURIComponent(value);
  });
  return s.client.request<T>(op.method as 'GET' | 'POST', path, {
    ...(opts.query ? { query: opts.query } : {}),
    ...(opts.body !== undefined ? { body: opts.body } : {}),
    ...(opts.readOnly ? { readOnly: true } : {}),
  });
}

/** The tenant for a command: `--tenant`, else the profile's, else the key's only tenant. */
export async function resolveTenant(
  ctx: CommandContext,
  s: Session,
  flag: string | undefined,
): Promise<string> {
  const given = flag ?? s.profile.tenantId;
  if (given !== undefined) {
    if (!/^\d+$/.test(given)) throw new CliError('A tenant id is a number.', ExitCode.Usage);
    return given;
  }
  const res = await callOperation<Access>(
    s,
    'access_and_api_keys_discover_current_csms_access',
    {},
  );
  const ids = accessTenantIds(res.data ?? {});
  if (ids.length === 1) return ids[0] as string;
  throw new CliError(
    ids.length === 0
      ? 'This key has no tenant.'
      : `This key can reach several tenants (${ids.join(', ')}): pass --tenant <id>.`,
    ExitCode.Usage,
  );
}

export function addTenantOption(cmd: Command): Command {
  return cmd.option('--tenant <id>', 'tenant id (default: the key’s only tenant)');
}

export function parseIntOption(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new CliError(`${name} must be a positive integer.`, ExitCode.Usage);
  }
  return Number(value);
}

interface Page {
  data?: unknown;
  next_cursor?: unknown;
}

export interface ListSpec {
  operationId: string;
  /** The cursor query parameter: `after` (newer-first by id) or `before`. */
  cursorParam: 'after' | 'before';
  columns: string[];
}

export interface ListOptions {
  tenant?: string;
  limit?: string;
  all?: boolean;
}

const MAX_PAGES = 100;

/** Lists a collection: one page, or every page with `--all`; prints a table or JSON. */
export async function runList(
  ctx: CommandContext,
  spec: ListSpec,
  opts: ListOptions & Record<string, unknown>,
  filters: Query,
): Promise<void> {
  const s = await openSession(ctx);
  const tenant = await resolveTenant(ctx, s, opts.tenant);
  const limit = parseIntOption('--limit', opts.limit);
  const cursorOpt = opts[spec.cursorParam];
  let cursor = typeof cursorOpt === 'string' ? cursorOpt : undefined;
  const rows: unknown[] = [];
  let next: string | undefined;
  for (let pages = 0; ; pages++) {
    const res = await callOperation<Page>(
      s,
      spec.operationId,
      { tenant_id: tenant },
      { query: { ...filters, limit, [spec.cursorParam]: cursor } },
    );
    const body = res.data ?? {};
    if (Array.isArray(body.data)) rows.push(...body.data);
    const nc = body.next_cursor;
    next = nc === null || nc === undefined || nc === '' ? undefined : String(nc);
    if (!opts.all || next === undefined) break;
    if (next === cursor || pages + 1 >= MAX_PAGES) break;
    cursor = next;
  }
  const out = ctx.out();
  if (out.json) {
    out.result({ data: rows, next_cursor: next ?? null });
    return;
  }
  out.result(rows as Record<string, unknown>[], spec.columns);
  if (next !== undefined) out.info(`More results: pass --${spec.cursorParam} ${next} (or --all).`);
}

export function addListOptions(cmd: Command, cursorParam: 'after' | 'before'): Command {
  return addTenantOption(cmd)
    .option('--limit <n>', 'page size')
    .option(`--${cursorParam} <cursor>`, 'continue from the cursor of the previous page')
    .option('--all', 'follow every page');
}

/** Fetches one resource by id and prints it. */
export async function runGet(
  ctx: CommandContext,
  operationId: string,
  paramName: string,
  id: string,
  tenantFlag: string | undefined,
): Promise<void> {
  const s = await openSession(ctx);
  const tenant = await resolveTenant(ctx, s, tenantFlag);
  const res = await callOperation(s, operationId, { tenant_id: tenant, [paramName]: id });
  ctx.out().result(res.data ?? {});
}

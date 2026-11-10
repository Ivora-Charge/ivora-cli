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
  /** The operationId in the OpenAPI snapshot; commands call operations by it, never by path. */
  operationId?: string;
}

export interface Exclusion {
  method: string;
  path: string;
  reason: string;
}

const T = '/v1/tenants/{tenant_id}';

export const COMMANDS: readonly CatalogEntry[] = [
  {
    method: 'GET',
    path: '/v1/access',
    command: 'whoami',
    operationId: 'access_and_api_keys_discover_current_csms_access',
  },
  {
    method: 'GET',
    path: '/v1/capabilities',
    command: 'whoami',
    operationId: 'getting_started_capabilities',
  },
  {
    method: 'GET',
    path: `${T}/stations`,
    command: 'stations list',
    operationId: 'stations_list_tenant_charging_stations',
  },
  {
    method: 'GET',
    path: `${T}/stations/{station_id}`,
    command: 'stations get',
    operationId: 'stations_read_station_and_connector_state',
  },
  {
    method: 'POST',
    path: `${T}/stations`,
    command: 'stations add',
    operationId: 'stations_register_a_station_and_return_it',
  },
  {
    method: 'GET',
    path: `${T}/tariffs`,
    command: 'tariffs list',
    operationId: 'tariffs_and_bills_read_tenant_billing_tariffs',
  },
  {
    method: 'GET',
    path: `${T}/tariffs/{tariff_id}`,
    command: 'tariffs get',
    operationId: 'tariffs_and_bills_read_one_tariff',
  },
  {
    method: 'POST',
    path: `${T}/tariffs/{tariff_id}/quote`,
    command: 'tariffs quote',
    operationId: 'tariffs_and_bills_quote_a_session_s_cost_under_a_stored_tariff',
  },
  {
    method: 'POST',
    path: `${T}/tariffs/simulate`,
    command: 'tariffs simulate',
    operationId: 'tariffs_and_bills_simulate_a_tariff_draft_against_a_session',
  },
  {
    method: 'GET',
    path: `${T}/operations`,
    command: 'operations list',
    operationId: 'charging_and_operations_list_the_project_s_operations',
  },
  {
    method: 'GET',
    path: `${T}/operations/{operation_id}`,
    command: 'operations get',
    operationId: 'charging_and_operations_inspect_an_operation_without_redispatching_it',
  },
  {
    method: 'GET',
    path: `${T}/webhooks`,
    command: 'webhooks list',
    operationId: 'webhooks_and_events_list_webhook_endpoints',
  },
  {
    method: 'GET',
    path: `${T}/webhooks/{webhook_id}`,
    command: 'webhooks get',
    operationId: 'webhooks_and_events_read_one_webhook_endpoint',
  },
  // Other read-only (GET) operations, reachable through `ivora api <operationId>`.
  {
    method: 'GET',
    path: `${T}/webhooks/{webhook_id}/deliveries`,
    command: 'api',
    operationId: 'webhooks_and_events_read_delivery_attempts_for_an_endpoint',
  },
  {
    method: 'GET',
    path: `${T}/events`,
    command: 'api',
    operationId: 'webhooks_and_events_poll_tenant_events_by_cursor',
  },
  {
    method: 'GET',
    path: `${T}/locations`,
    command: 'api',
    operationId: 'locations_list_tenant_locations',
  },
  {
    method: 'GET',
    path: `${T}/locations/{location_id}`,
    command: 'api',
    operationId: 'locations_read_one_location',
  },
  {
    method: 'GET',
    path: `${T}/locations/{location_id}/tax`,
    command: 'plan',
    operationId: 'locations_read_a_location_s_tax_lines',
  },
  {
    method: 'GET',
    path: `${T}/transactions`,
    command: 'api',
    operationId: 'charging_and_operations_read_charging_usage_and_realized_billing',
  },
  {
    method: 'GET',
    path: `${T}/transactions/{transaction_id}`,
    command: 'api',
    operationId: 'charging_and_operations_read_one_transaction_in_detail',
  },
  {
    method: 'GET',
    path: '/v1/currencies',
    command: 'api',
    operationId: 'tariffs_and_bills_list_the_supported_currencies',
  },
];

/** Looks up a cataloged operation by operationId. */
export function findOperation(operationId: string): CatalogEntry | undefined {
  return COMMANDS.find((c) => c.operationId === operationId);
}

/** The operationIds `ivora api` may call: cataloged GET operations only. */
export function getOperationIds(): string[] {
  return COMMANDS.filter((c) => c.method === 'GET' && c.operationId).map(
    (c) => c.operationId as string,
  );
}

/** Names of the `{param}` placeholders in a path template. */
export function pathParams(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1] as string);
}

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

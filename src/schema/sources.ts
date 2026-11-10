import type { JsonSchema } from './json-schema.js';

/**
 * Where the generated parts of the ivora.yaml schema come from (site-as-code design 1.2).
 *
 * `bodies` are the operations whose JSON request body becomes a part of the file's schema;
 * `operations` are every other /v1 operation the section is planned, applied and drift-checked
 * with (create, update, delete, read). All of them are tested against the pinned operation-id
 * snapshot (openapi/operation-ids.json), so a renamed /v1 operation breaks the build rather than
 * the file.
 */
export const SCHEMA_SOURCES = {
  locations: {
    bodies: {
      location: 'locations_create_a_tenant_charging_location_and_return_it',
      tax: 'locations_set_a_location_s_tax_lines',
      default_tariff: 'locations_set_a_location_s_default_tariff',
    },
    operations: [
      'locations_update_a_location_s_details',
      'locations_delete_a_location_no_station_is_at',
      'locations_clear_a_location_s_default_tariff',
      'locations_remove_a_location_s_tax_lines',
      'locations_list_tenant_locations',
      'locations_read_one_location',
      'locations_read_a_location_s_default_tariff',
      'locations_read_a_location_s_tax_lines',
    ],
  },
  stations: {
    bodies: {
      station: 'stations_register_a_station_and_return_it',
      evse: 'stations_add_an_evse_with_its_connectors',
      connector: 'stations_add_a_connector_to_an_evse',
    },
    operations: [
      'stations_edit_a_station_s_name_location_or_metadata',
      'stations_edit_an_evse_s_label',
      'stations_edit_a_connector_s_type_and_ratings',
      'stations_delete_a_station_that_never_charged',
      'stations_delete_an_evse_and_its_connectors',
      'stations_delete_a_connector',
      'stations_list_tenant_charging_stations',
      'stations_read_station_and_connector_state',
      // Hand-written in the file (a secret reference): the API never returns a password.
      'stations_set_the_station_s_ocpp_connection_password',
    ],
  },
  connector_tariff: {
    bodies: { assignment: 'stations_assign_a_tariff_to_a_connector' },
    operations: ['stations_unassign_a_connector_s_tariff', 'stations_read_a_connector_s_tariff'],
  },
  tariffs: {
    bodies: {
      tariff: 'tariffs_and_bills_create_a_core_tariff_version_and_return_it',
      project_default: 'tariffs_and_bills_set_the_project_s_default_tariff',
    },
    operations: [
      'tariffs_and_bills_change_a_tariff_s_prices',
      'tariffs_and_bills_archive_a_tariff',
      'tariffs_and_bills_clear_the_project_s_default_tariff',
      'tariffs_and_bills_read_tenant_billing_tariffs',
      'tariffs_and_bills_read_one_tariff',
      'tariffs_and_bills_read_the_project_s_default_tariff',
    ],
  },
  ocpi_publishing: {
    bodies: { settings: 'ocpi_publishing_set_the_tenant_s_ocpi_publishing_settings' },
    operations: ['ocpi_publishing_read_the_tenant_s_ocpi_publishing_settings'],
  },
  webhooks: {
    bodies: { webhook: 'webhooks_and_events_register_an_https_endpoint_for_tenant_events' },
    operations: [
      'webhooks_and_events_disable_a_webhook_endpoint',
      'webhooks_and_events_list_webhook_endpoints',
      'webhooks_and_events_read_one_webhook_endpoint',
    ],
  },
  displays: {
    bodies: {
      qr: 'charger_displays_set_the_qr_a_charger_screen_shows',
      running_cost: 'charger_displays_switch_running_cost_messages_for_a_station_on_or_off',
      pricing_text:
        'charger_displays_switch_the_california_pricing_price_text_for_a_station_on_or_off',
    },
    operations: ['charger_displays_list_a_station_s_charger_displays'],
  },
} as const;

export type SchemaSection = keyof typeof SCHEMA_SOURCES;

/** Every operationId the schema depends on (request bodies and the other section operations). */
export function sourceOperationIds(): string[] {
  const ids = new Set<string>();
  for (const s of Object.values(SCHEMA_SOURCES)) {
    for (const id of Object.values(s.bodies)) ids.add(id);
    for (const id of s.operations) ids.add(id);
  }
  return [...ids].sort();
}

/** The operationIds whose request bodies are extracted into generated.ts. */
export function bodyOperationIds(): string[] {
  const ids = new Set<string>();
  for (const s of Object.values(SCHEMA_SOURCES))
    for (const id of Object.values(s.bodies)) ids.add(id);
  return [...ids].sort();
}

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
  return Object.fromEntries(
    Object.entries(obj)
      // Schema titles (strings) and examples (arrays) are noise in an inlined schema; a
      // property named `title` or `examples` has a schema object as its value and is kept.
      .filter(
        ([k, v]) =>
          !(k === 'title' && typeof v === 'string') && !(k === 'examples' && Array.isArray(v)),
      )
      .map(([k, v]) => [k, resolveRefs(v, spec, seen)]),
  );
}

/** `METHOD /path` → operationId for every operation in the spec, keys sorted. */
export function specOperationIds(spec: SpecLike): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(item)) {
      const id = (op as { operationId?: unknown } | null)?.operationId;
      if (typeof id === 'string') out[`${method.toUpperCase()} ${path}`] = id;
    }
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
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

/** Extracts the request-body schema of every body operation. Throws on a missing one. */
export function extractRequestBodies(spec: SpecLike): RequestBodySchemas {
  const out: RequestBodySchemas = {};
  for (const operationId of bodyOperationIds()) {
    const schema = requestBodySchema(spec, operationId);
    if (!schema) throw new Error(`operation ${operationId} has no JSON request body in the spec`);
    out[operationId] = schema;
  }
  return out;
}

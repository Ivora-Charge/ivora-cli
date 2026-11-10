import { REQUEST_BODIES } from './generated.js';
import {
  ADMIN_SECTIONS,
  LOCAL_KEY_PATTERN,
  adminSection,
  credentials,
  gridSite,
  keyedMap,
  loadGroup,
  localKeyRef,
  migration,
} from './handwritten.js';
import type { JsonSchema } from './json-schema.js';
import { SCHEMA_SOURCES, type RequestBodySchemas } from './sources.js';

export const SCHEMA_VERSION = 1;

/** A decimal money value: a quoted string so YAML never rounds it, at most 4 places (1.1). */
export const DECIMAL_PATTERN = '^(0|[1-9][0-9]*)(\\.[0-9]{1,4})?$';

function decimalString(description: string): JsonSchema {
  return { type: 'string', pattern: DECIMAL_PATTERN, description };
}

/** Applies `fn` to every schema node, children first. */
function mapSchema(node: unknown, fn: (s: JsonSchema) => JsonSchema): unknown {
  if (Array.isArray(node)) return node.map((n) => mapSchema(n, fn));
  if (node === null || typeof node !== 'object') return node;
  const mapped = Object.fromEntries(
    Object.entries(node as Record<string, unknown>).map(([k, v]) => [k, mapSchema(v, fn)]),
  );
  return fn(mapped as JsonSchema);
}

const enumOf = (s: JsonSchema | undefined): unknown[] => s?.enum ?? [];

/**
 * The file's money rules (1.1, 7.3) on top of the API's shapes: a tariff price is a quoted
 * decimal string in major units, and a tax line's `rate` may be a string (required for
 * `per_kwh`, checked in document.ts) or, for `percent`, a YAML number.
 */
function moneyRules(s: JsonSchema): JsonSchema {
  const p = s.properties;
  if (p?.['price'] && p['step_size'] && enumOf(p['type']).includes('ENERGY')) {
    return {
      ...s,
      properties: {
        ...p,
        price: decimalString(
          'Decimal string in MAJOR units of the tariff currency ("0.45" is USD 0.45), at most ' +
            '4 places, at most 10000: per kWh (ENERGY), per hour (TIME, PARKING_TIME), per ' +
            'session (FLAT). A YAML number is an error.',
        ),
      },
    };
  }
  if (p?.['rate'] && enumOf(p['type']).includes('per_kwh')) {
    return {
      ...s,
      properties: {
        ...p,
        rate: {
          description:
            'percent: a percentage 0 to 100 (a YAML number is fine). per_kwh: MINOR units per ' +
            'kWh as a quoted decimal string, at most 4 places, at most 1000.',
          anyOf: [
            { type: 'number', minimum: 0, maximum: 100 },
            decimalString('per_kwh rate in minor units per kWh'),
          ],
        },
      },
    };
  }
  return s;
}

interface Reshape {
  omit?: string[];
  add?: Record<string, JsonSchema>;
  required?: string[];
  extra?: JsonSchema;
}

/** An object schema from a request body: drop API-only fields, add the file's local-key fields. */
function reshape(
  body: JsonSchema,
  { omit = [], add = {}, required, extra = {} }: Reshape,
): JsonSchema {
  const properties = Object.fromEntries(
    Object.entries(body.properties ?? {}).filter(([k]) => !omit.includes(k)),
  );
  const base = (body.required ?? []).filter((k) => !omit.includes(k));
  const req = required ?? base;
  const out: JsonSchema = {
    ...body,
    ...extra,
    additionalProperties: false,
    properties: { ...properties, ...add },
  };
  if (req.length > 0) out.required = req;
  else delete out.required;
  return out;
}

/** `default_tariff`: a tariff's local key, or with `confirm_currency` (DefaultTariffInput). */
function defaultTariff(body: JsonSchema): JsonSchema {
  return {
    description:
      'A tariff by local key, or { tariff, confirm_currency } when its currency is not the ' +
      "project's default currency.",
    anyOf: [
      localKeyRef('tariffs'),
      reshape(body, {
        omit: ['tariff_id'],
        add: { tariff: localKeyRef('tariffs') },
        required: ['tariff'],
      }),
    ],
  };
}

/** A boolean shorthand (`running_cost: true`) or the full request body. */
function switchOrBody(body: JsonSchema, description: string): JsonSchema {
  return { description, anyOf: [{ type: 'boolean' }, body] };
}

const numberedMap = (pattern: string, item: JsonSchema, description: string): JsonSchema => ({
  type: 'object',
  description,
  propertyNames: { pattern },
  additionalProperties: item,
});

/** Builds the ivora.yaml JSON Schema from the extracted request bodies (design 1.1, 1.2). */
export function buildSchema(input: RequestBodySchemas = REQUEST_BODIES): JsonSchema {
  const bodies = mapSchema(input, moneyRules) as RequestBodySchemas;
  const body = (id: string): JsonSchema => {
    const b = bodies[id];
    if (!b) throw new Error(`missing request body for ${id}`);
    return b;
  };
  const S = SCHEMA_SOURCES;

  const location = reshape(body(S.locations.bodies.location), {
    add: {
      default_tariff: defaultTariff(body(S.locations.bodies.default_tariff)),
      tax: body(S.locations.bodies.tax),
    },
  });

  const connector = reshape(body(S.stations.bodies.connector), {
    add: {
      tariff: {
        ...localKeyRef('tariffs'),
        description: `The connector's tariff, by local key (${S.connector_tariff.bodies.assignment}).`,
      },
    },
  });
  const evseBody = body(S.stations.bodies.evse);
  const evse = reshape(evseBody, {
    omit: ['evse_number', 'connectors'],
    add: {
      connectors: numberedMap(
        '^[1-8]$',
        connector,
        'Connectors keyed by their number on the EVSE (1 to 8).',
      ),
    },
  });
  const station = reshape(body(S.stations.bodies.station), {
    omit: ['location_id', 'connectors'],
    add: {
      location: localKeyRef('locations'),
      credentials,
      evses: numberedMap('^[1-9][0-9]?$', evse, 'EVSEs keyed by their number (1 to 99).'),
    },
    required: ['location'],
    extra: { oneOf: [{ required: ['charger_id'] }, { required: ['name'] }] },
  });

  const tariff = body(S.tariffs.bodies.tariff);

  const ocpi = reshape(body(S.ocpi_publishing.bodies.settings), {
    omit: ['excluded_location_ids'],
    add: {
      excluded_locations: {
        type: 'array',
        description: 'Locations never published, by local key.',
        items: localKeyRef('locations'),
      },
    },
    extra: {
      description:
        'OCPI publishing settings. The API call replaces every setting, so declare them all.',
    },
  });

  const webhook = reshape(body(S.webhooks.bodies.webhook), {
    omit: ['stations'],
    add: {
      stations: {
        type: 'array',
        minItems: 1,
        description: 'Deliver station events of these stations only (local keys). Omit for all.',
        items: localKeyRef('stations'),
      },
    },
  });

  const qr = reshape(body(S.displays.bodies.qr), {
    omit: ['tariff_id'],
    add: { tariff: localKeyRef('tariffs') },
  });
  const display: JsonSchema = {
    type: 'object',
    description: 'Charger screen settings of a station (keyed by its local key).',
    additionalProperties: false,
    properties: {
      qr: numberedMap('^[1-9][0-9]?$', qr, 'The QR each EVSE shows, keyed by EVSE number.'),
      running_cost: switchOrBody(
        body(S.displays.bodies.running_cost),
        'Running-cost messages on the charger screen: true, false or { enabled, interval_seconds }.',
      ),
      pricing_text: switchOrBody(
        body(S.displays.bodies.pricing_text),
        'California Pricing price text on the charger: true, false or { enabled }.',
      ),
    },
  };

  const properties: Record<string, JsonSchema> = {
    version: { const: SCHEMA_VERSION },
    project: {
      type: 'string',
      minLength: 1,
      description: 'The project (tenant) the API key belongs to; plan refuses a key for another.',
    },
    locations: keyedMap(location, 'Locations, keyed by local key.'),
    stations: keyedMap(station, 'Stations with their EVSEs and connectors, keyed by local key.'),
    tariffs: keyedMap(tariff, 'Tariffs, keyed by local key. Tariffs have no name.'),
    default_tariff: defaultTariff(body(S.tariffs.bodies.project_default)),
    load_groups: keyedMap(loadGroup, 'Load groups, keyed by local key.'),
    grid: {
      type: 'object',
      description: "Grid limits per location, keyed by the location's local key.",
      propertyNames: { pattern: LOCAL_KEY_PATTERN },
      additionalProperties: gridSite,
    },
    ocpi_publishing: ocpi,
    webhooks: keyedMap(webhook, 'Webhook endpoints, keyed by local key.'),
    displays: {
      type: 'object',
      description: 'Charger displays, keyed by station local key.',
      propertyNames: { pattern: LOCAL_KEY_PATTERN },
      additionalProperties: display,
    },
    migration,
  };
  for (const key of Object.keys(ADMIN_SECTIONS)) properties[key] = adminSection(key);
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'ivora.yaml',
    description:
      'One Ivora project as code (version 1). Every resource has a local key chosen by the ' +
      'author. Secrets are references only. Generated from the /v1 OpenAPI request bodies ' +
      '(x-ivora-sources) plus hand-written parts (x-ivora-handwritten).',
    'x-ivora-sources': SCHEMA_SOURCES,
    type: 'object',
    required: ['version', 'project'],
    additionalProperties: false,
    properties,
  };
}

import type { JsonSchema } from './json-schema.js';

/**
 * The hand-written parts of the ivora.yaml schema (site-as-code design 1.2): parts the /v1
 * OpenAPI document cannot generate. Station passwords are write-only on the API, so the file
 * holds a secret reference; load groups, grid limits and the migration section have no /v1
 * request body to generate from.
 */

/** A local key: how the file names a resource (`site-1`, `cp-01`) and how plan matches it. */
export const LOCAL_KEY_PATTERN = '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$';

export const localKeyRef = (kind: string): JsonSchema => ({
  type: 'string',
  pattern: LOCAL_KEY_PATTERN,
  description: `The local key of an entry in \`${kind}\`.`,
});

/** A map keyed by local keys. */
export const keyedMap = (item: JsonSchema, description: string): JsonSchema => ({
  type: 'object',
  description,
  propertyNames: { pattern: LOCAL_KEY_PATTERN },
  additionalProperties: item,
});

/**
 * A secret reference (design 1.3): `env:NAME` or `file:path`, never a value. A `file:` path is
 * relative to the ivora.yaml file's directory, `~/` is the home directory; the file must be mode
 * 600 and must not sit in a git work tree unless git ignores it. A literal secret is an error.
 */
export const SECRET_REF_PATTERN = '^(env:[A-Za-z_][A-Za-z0-9_]*|file:\\S.*)$';

export const credentials: JsonSchema = {
  type: 'object',
  description:
    'The station\'s OCPP connection password, as a reference: { secret: "env:NAME" } or ' +
    '{ secret: "file:path" } (mode 600; not in a git work tree unless ignored). Never the ' +
    'password itself. Write-only on the API (stations_set_the_station_s_ocpp_connection_password), ' +
    'so it is hand-written rather than generated.',
  'x-ivora-handwritten': true,
  required: ['secret'],
  additionalProperties: false,
  properties: { secret: { type: 'string', pattern: SECRET_REF_PATTERN } },
};

const positive = { type: 'number', exclusiveMinimum: 0 };

const currentOrPower = (description: string): JsonSchema => ({
  type: 'object',
  description,
  required: ['value', 'unit'],
  additionalProperties: false,
  properties: { value: positive, unit: { type: 'string', enum: ['A', 'W'] } },
});

/** Load groups (design 6.1): written from the load-balancing models until they ship on /v1. */
export const loadGroup: JsonSchema = {
  type: 'object',
  description:
    'A load group: stations that share a limit. Nested by `parent`; a root group names its ' +
    '`location`. Stations sit on leaf groups only. Enforced by the platform, never by the CLI.',
  'x-ivora-handwritten': true,
  required: ['limit'],
  anyOf: [{ required: ['location'] }, { required: ['parent'] }],
  additionalProperties: false,
  properties: {
    location: localKeyRef('locations'),
    parent: localKeyRef('load_groups'),
    limit: currentOrPower('The group limit, in A or W.'),
    supply: {
      type: 'object',
      description: "File-only: the supply, for the plan's A-to-W comparison. Children inherit it.",
      required: ['voltage_v', 'phases'],
      additionalProperties: false,
      properties: {
        voltage_v: { type: 'integer', minimum: 1, maximum: 100000 },
        phases: { type: 'integer', enum: [1, 2, 3] },
      },
    },
    phase_limits: {
      type: 'object',
      description: 'Per-phase limits, in the unit of `limit`.',
      additionalProperties: false,
      properties: { L1: positive, L2: positive, L3: positive },
    },
    fail_safe_limit: currentOrPower(
      'The limit chargers fall back to when they lose the backend, in A or W.',
    ),
    mode: { type: 'string', enum: ['static', 'dynamic'] },
    stations: {
      type: 'array',
      description: 'Local keys of the stations on this (leaf) group.',
      minItems: 1,
      items: localKeyRef('stations'),
    },
  },
};

/** Grid limits and signals (design 6.2, 6.3): not modelled on /v1; plan reads them only. */
export const gridSite: JsonSchema = {
  type: 'object',
  description:
    "Declared grid limits of a location (keyed by its local key). Used by the plan's " +
    'power-impact check only; apply refuses them until the platform has a home for them.',
  'x-ivora-handwritten': true,
  additionalProperties: false,
  properties: {
    transformer_limit: {
      type: 'object',
      required: ['value', 'unit'],
      additionalProperties: false,
      properties: { value: positive, unit: { type: 'string', enum: ['kVA', 'kW', 'A'] } },
    },
    service_limit: {
      type: 'object',
      required: ['value', 'unit'],
      additionalProperties: false,
      properties: { value: positive, unit: { type: 'string', enum: ['kVA', 'kW', 'A'] } },
    },
    signals: {
      type: 'array',
      description: 'Future: utility programs (OpenADR). Accepted here, refused by apply.',
      items: {
        type: 'object',
        required: ['program'],
        additionalProperties: false,
        properties: {
          program: { type: 'string', minLength: 1 },
          ven: { type: 'string', minLength: 1 },
          load_group: localKeyRef('load_groups'),
          max_reduction: { type: 'string', pattern: '^(100|[1-9]?[0-9])%$' },
          credentials,
        },
      },
    },
  },
};

const hhmm = { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' };

const batch: JsonSchema = {
  type: 'object',
  description: 'A Migration Portal batch. `target: incumbent` is a rollback of those chargers.',
  required: ['chargers', 'target'],
  additionalProperties: false,
  properties: {
    chargers: { type: 'array', minItems: 1, items: localKeyRef('stations') },
    target: { type: 'string', enum: ['ivora', 'incumbent'] },
    mode: { type: 'string', enum: ['proxy', 'direct', 'await'] },
    window: {
      type: 'object',
      required: ['from', 'to'],
      additionalProperties: false,
      properties: {
        days: {
          type: 'array',
          minItems: 1,
          items: { type: 'string', enum: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] },
        },
        from: hhmm,
        to: hhmm,
      },
    },
    pacing: {
      type: 'object',
      additionalProperties: false,
      properties: {
        max_in_flight: { type: 'integer', minimum: 1 },
        canary: { type: 'integer', minimum: 0 },
        pace_seconds: { type: 'integer', minimum: 0 },
      },
    },
    preconditions: {
      type: 'object',
      additionalProperties: false,
      properties: {
        idle_only: { type: 'boolean' },
        parity: { type: 'string', enum: ['clean', 'overridden'] },
        parity_max_age_hours: { type: 'integer', minimum: 1 },
        terminal_ready: { type: 'boolean' },
        qr_ready: { type: 'boolean' },
      },
    },
  },
};

/** The migration section (design 5.2), mapped one-to-one onto Migration Portal batches. */
export const migration: JsonSchema = {
  type: 'object',
  description:
    'Migration as code: the source platform, the proxy fleet that routes the chargers, and ' +
    'the batches. Apply may only create and submit draft batches; approve, start and rollback ' +
    'stay with people.',
  'x-ivora-handwritten': true,
  required: ['source'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1, description: 'A Migration Portal migration id.' },
    source: {
      type: 'object',
      description: 'The incumbent platform. Placeholders (TODO, <...>, empty) are errors.',
      required: ['platform'],
      additionalProperties: false,
      properties: {
        platform: { type: 'string', minLength: 1 },
        path: { type: 'string', minLength: 1, description: 'The incumbent OCPP path.' },
      },
    },
    proxy_fleet: {
      description:
        'The proxy deployment that routes these chargers: its name, or an object with a ' +
        'required alarm contact.',
      anyOf: [
        { type: 'string', minLength: 1 },
        {
          type: 'object',
          required: ['name', 'alarm_email'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1 },
            alarm_email: { type: 'string', pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$' },
            initialized: { type: 'boolean' },
          },
        },
      ],
    },
    batches: keyedMap(batch, 'Batches, keyed by local key.'),
    rollback_point: {
      type: 'object',
      required: ['batch', 'target'],
      additionalProperties: false,
      properties: {
        batch: localKeyRef('migration.batches'),
        target: { type: 'string', enum: ['ivora', 'incumbent'] },
      },
    },
  },
};

/**
 * Sections only a signed-in team owner or admin can reach (decision D4): API keys get 403, reads
 * included. They stay in the schema as documentation; validate, plan and drift skip them with a
 * key and print the reason, and apply never touches them.
 */
export const ADMIN_SECTIONS: Record<string, { reason: string; description: string }> = {
  roaming_partners: {
    reason: 'needs a signed-in admin (decision D4); not checked with an API key',
    description:
      'OCPI roaming partners, keyed by local key (ocpi_roaming_partners_* operations). ' +
      'Signed-in team owners and admins only (decision D4): API keys, apps and OAuth grants ' +
      'get 403, reads included. Skipped with an API key; documentation only.',
  },
  apps: {
    reason: 'needs a signed-in user who saw the consent screen; not checked with an API key',
    description:
      'App installs, keyed by local key (apps_install_an_app_in_a_project). Installs are made ' +
      'by a signed-in user who saw the consent screen; API keys and OAuth get 403. Skipped ' +
      'with an API key; documentation only. App client secrets are never in the file.',
  },
};

export const adminSection = (key: string): JsonSchema => {
  const s = ADMIN_SECTIONS[key];
  return {
    type: 'object',
    description: s?.description,
    'x-ivora-skip': { reason: s?.reason, requires: 'signed-in admin', decision: 'D4' },
  };
};

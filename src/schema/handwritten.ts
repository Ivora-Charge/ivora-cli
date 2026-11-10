import type { JsonSchema } from './json-schema.js';

/**
 * The hand-written parts of the ivora.yaml schema (design 1.2): station password secret
 * references, load groups, grid limits and the migration section. Secrets are references only
 * (1.3): a value is never written in the file.
 */

/** `env:NAME` reads the value from an environment variable when the file is used later. */
export const SECRET_REF_PATTERN = '^env:[A-Za-z_][A-Za-z0-9_]*$';

export const secretRef: JsonSchema = {
  type: 'object',
  description:
    'A reference to a secret, never the value. Example: { secret_ref: "env:STATION_PW" }.',
  required: ['secret_ref'],
  additionalProperties: false,
  properties: { secret_ref: { type: 'string', pattern: SECRET_REF_PATTERN } },
};

export const loadGroup: JsonSchema = {
  type: 'object',
  description: 'Stations that share one power budget.',
  required: ['name', 'stations', 'max_power_kw'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1 },
    stations: {
      type: 'array',
      minItems: 1,
      description: 'charger_id of each station in the group.',
      items: { type: 'string', minLength: 1 },
    },
    max_power_kw: { type: 'number', minimum: 0 },
  },
};

export const gridLimit: JsonSchema = {
  type: 'object',
  description: 'The grid connection limit of a location.',
  required: ['location', 'max_power_kw'],
  additionalProperties: false,
  properties: {
    location: { type: 'string', minLength: 1 },
    max_power_kw: { type: 'number', minimum: 0 },
    max_current_a: { type: 'number', minimum: 0 },
  },
};

export const migration: JsonSchema = {
  type: 'object',
  description: 'Where stations are migrated from.',
  required: ['source'],
  additionalProperties: false,
  properties: {
    source: {
      type: 'object',
      required: ['kind', 'path'],
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['csv', 'json', 'ocpp_csms_export'] },
        path: { type: 'string', minLength: 1 },
      },
    },
    station_map: {
      type: 'array',
      items: {
        type: 'object',
        required: ['from', 'to'],
        additionalProperties: false,
        properties: {
          from: { type: 'string', minLength: 1 },
          to: { type: 'string', minLength: 1 },
        },
      },
    },
  },
};

/**
 * Sections that need a signed-in admin. Phase 1 skips them with a key and prints the reason (1.2);
 * their content is not checked.
 */
export const ADMIN_SECTIONS: Record<string, string> = {
  roaming_partners: 'needs a signed-in admin; not available with an API key',
  apps: 'needs a signed-in admin; not available with an API key',
};

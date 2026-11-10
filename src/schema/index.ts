import { REQUEST_BODIES } from './generated.js';
import { ADMIN_SECTIONS, gridLimit, loadGroup, migration, secretRef } from './handwritten.js';
import type { JsonSchema } from './json-schema.js';
import { SCHEMA_SOURCES, type RequestBodySchemas } from './sources.js';

export const SCHEMA_VERSION = 1;

/** A station item: the registration request body plus the hand-written password reference. */
function stationItem(body: JsonSchema): JsonSchema {
  return {
    ...body,
    properties: { ...body.properties, password: secretRef },
  };
}

/** Builds the ivora.yaml JSON Schema from the extracted request bodies. */
export function buildSchema(bodies: RequestBodySchemas = REQUEST_BODIES): JsonSchema {
  const station = bodies[SCHEMA_SOURCES.stations];
  if (!station) throw new Error('missing request body for stations');
  const properties: Record<string, JsonSchema> = {
    version: { const: SCHEMA_VERSION },
    stations: { type: 'array', items: stationItem(station) },
    load_groups: { type: 'array', items: loadGroup },
    grid_limits: { type: 'array', items: gridLimit },
    migration,
  };
  for (const key of Object.keys(ADMIN_SECTIONS)) properties[key] = {};
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'ivora.yaml',
    type: 'object',
    required: ['version'],
    additionalProperties: false,
    properties,
  };
}

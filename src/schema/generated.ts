// Generated from the /v1 OpenAPI request bodies listed in sources.ts. Do not edit by hand:
// run the tests with UPDATE_SCHEMA=1 to regenerate it (test/schema.test.ts checks it is current).
import type { RequestBodySchemas } from './sources.js';

export const REQUEST_BODIES: RequestBodySchemas = {
  stations_register_a_station_and_return_it: {
    type: 'object',
    required: ['charger_id'],
    additionalProperties: false,
    properties: {
      charger_id: {
        type: 'string',
        minLength: 1,
        maxLength: 48,
      },
      name: {
        type: 'string',
      },
      location_id: {
        type: 'string',
      },
      vendor: {
        type: 'string',
      },
      model: {
        type: 'string',
      },
    },
  },
};

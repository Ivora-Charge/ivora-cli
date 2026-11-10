// Generated from the /v1 OpenAPI request bodies listed in sources.ts. Do not edit by hand:
// run the tests with UPDATE_SCHEMA=1 to regenerate it (test/schema.test.ts checks it is current).
import type { RequestBodySchemas } from './sources.js';

export const REQUEST_BODIES: RequestBodySchemas = {
  charger_displays_set_the_qr_a_charger_screen_shows: {
    properties: {
      qr: {
        type: 'string',
        maxLength: 500,
        minLength: 1,
        description:
          'https URL the screen encodes as a QR, usually your checkout page for this EVSE. No customer data or secrets.',
      },
      show_price: {
        type: 'boolean',
        description:
          "Also show the price where the adapter supports it: the tariff_id tariff when set, else the EVSE's connector tariff.",
        default: true,
      },
      tariff_id: {
        anyOf: [
          {
            type: 'integer',
            exclusiveMinimum: 0,
          },
          {
            type: 'null',
          },
        ],
        description:
          "A tariff in this tenant whose price the screen shows, usually the one your application bills with. Omit to use the EVSE's connector tariff.",
      },
      visibility: {
        type: 'string',
        enum: ['idle', 'always'],
        description:
          'idle shows the QR only while the connector is payable, on adapters that can clear; always keeps it up.',
        default: 'idle',
      },
    },
    additionalProperties: false,
    type: 'object',
    required: ['qr'],
  },
  charger_displays_switch_running_cost_messages_for_a_station_on_or_off: {
    properties: {
      enabled: {
        type: 'boolean',
        description:
          "Send the running and final cost of this station's bills to the charger screen (California CTEP). On by default; an explicit choice always wins over the default.",
      },
      interval_seconds: {
        type: 'integer',
        maximum: 900,
        minimum: 15,
        description:
          'Least time between two running cost messages of one session; a message goes out only when energy or cost changed.',
        default: 60,
      },
    },
    additionalProperties: false,
    type: 'object',
    required: ['enabled'],
  },
  charger_displays_switch_the_california_pricing_price_text_for_a_station_on_or_off: {
    properties: {
      enabled: {
        type: 'boolean',
        description:
          "Let the generic OCPP 1.6 California Pricing adapter write the tariff's price text to this charger. An explicit choice always wins over this environment's default.",
      },
    },
    additionalProperties: false,
    type: 'object',
    required: ['enabled'],
  },
  locations_create_a_tenant_charging_location_and_return_it: {
    properties: {
      name: {
        type: 'string',
        maxLength: 80,
        minLength: 2,
      },
      address: {
        type: 'string',
        maxLength: 120,
        default: '',
      },
      city: {
        type: 'string',
        maxLength: 120,
        default: '',
      },
      state: {
        type: 'string',
        maxLength: 120,
        default: '',
      },
      country: {
        type: 'string',
        pattern: '^[A-Z]{3}$',
        default: 'USA',
      },
      postal_code: {
        type: 'string',
        maxLength: 20,
        default: '',
      },
      latitude: {
        anyOf: [
          {
            type: 'number',
            maximum: 90,
            minimum: -90,
          },
          {
            type: 'null',
          },
        ],
        description: 'Optional; supply latitude and longitude together.',
      },
      longitude: {
        anyOf: [
          {
            type: 'number',
            maximum: 180,
            minimum: -180,
          },
          {
            type: 'null',
          },
        ],
      },
      time_zone: {
        type: 'string',
        maxLength: 80,
        minLength: 1,
        default: 'America/New_York',
      },
      opening_hours: {
        anyOf: [
          {
            properties: {
              twenty_four_seven: {
                type: 'boolean',
                description:
                  'Open around the clock; then regular_hours must be empty (exceptional_closings may still apply).',
              },
              regular_hours: {
                items: {
                  properties: {
                    weekday: {
                      type: 'integer',
                      maximum: 7,
                      minimum: 1,
                      description: '1 is Monday, 7 is Sunday.',
                    },
                    period_begin: {
                      type: 'string',
                      pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$',
                      description: "HH:MM, 24-hour, in the location's time zone.",
                    },
                    period_end: {
                      type: 'string',
                      pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$',
                      description:
                        'HH:MM, after period_begin on the same day. For an overnight opening send two periods (22:00-23:59, then 00:00-06:00 on the next weekday).',
                    },
                  },
                  additionalProperties: false,
                  type: 'object',
                  required: ['weekday', 'period_begin', 'period_end'],
                },
                type: 'array',
                maxItems: 28,
                description:
                  'The weekly schedule (weekday 1 is Monday, 7 is Sunday); required unless twenty_four_seven. A weekday without a period is closed.',
              },
              exceptional_openings: {
                items: {
                  properties: {
                    period_begin: {
                      type: 'string',
                      maxLength: 40,
                      description: 'RFC 3339 date-time with an offset or Z; returned in UTC.',
                    },
                    period_end: {
                      type: 'string',
                      maxLength: 40,
                      description: 'After period_begin.',
                    },
                  },
                  additionalProperties: false,
                  type: 'object',
                  required: ['period_begin', 'period_end'],
                },
                type: 'array',
                maxItems: 50,
              },
              exceptional_closings: {
                items: {
                  properties: {
                    period_begin: {
                      type: 'string',
                      maxLength: 40,
                      description: 'RFC 3339 date-time with an offset or Z; returned in UTC.',
                    },
                    period_end: {
                      type: 'string',
                      maxLength: 40,
                      description: 'After period_begin.',
                    },
                  },
                  additionalProperties: false,
                  type: 'object',
                  required: ['period_begin', 'period_end'],
                },
                type: 'array',
                maxItems: 50,
              },
            },
            additionalProperties: false,
            type: 'object',
            required: ['twenty_four_seven'],
          },
          {
            type: 'null',
          },
        ],
        description:
          "Opening hours, published as OCPI opening_times: twenty_four_seven, or a weekly regular_hours schedule in the location's time_zone (weekday 1 Monday to 7 Sunday, HH:MM, end after begin, no overlap), plus optional exceptional_openings and exceptional_closings (RFC 3339 instants, returned in UTC).",
      },
      external_reference: {
        anyOf: [
          {
            type: 'string',
            pattern: '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$',
          },
          {
            type: 'null',
          },
        ],
        description:
          'Your stable identifier for this resource (for example a property or listing ID). Unique per tenant and resource type. Filter lists with ?external_reference=. No customer data or secrets.',
      },
      metadata: {
        anyOf: [
          {
            additionalProperties: {
              anyOf: [
                {
                  type: 'string',
                  maxLength: 500,
                },
                {
                  type: 'null',
                },
              ],
            },
            propertyNames: {
              pattern: '^[A-Za-z0-9_.-]{1,40}$',
            },
            type: 'object',
            maxProperties: 50,
          },
          {
            type: 'null',
          },
        ],
        description:
          'Your own key/value pairs (strings), such as a site host or a contract ID: at most 50 keys of 1-40 characters of A-Z, a-z, 0-9, underscore, period and hyphen, values of at most 500 characters. Never secrets or personal data. Never published to OCPI roaming partners. On create, sets the pairs; on PATCH, merges them into the stored ones: a key sent as "" or null is deleted, other keys keep their values.',
      },
    },
    additionalProperties: false,
    type: 'object',
    required: ['name'],
  },
  locations_set_a_location_s_default_tariff: {
    properties: {
      tariff_id: {
        type: 'integer',
        exclusiveMinimum: 0,
        description: 'An active tariff in this tenant (id from the tariff routes).',
      },
      confirm_currency: {
        type: 'boolean',
        description:
          "Required (true) when the tariff's currency is not the project's default_currency; without it such a tariff is refused with 409 tariff_currency_mismatch.",
        default: false,
      },
    },
    additionalProperties: false,
    type: 'object',
    required: ['tariff_id'],
  },
  locations_set_a_location_s_tax_lines: {
    properties: {
      price_mode: {
        anyOf: [
          {
            type: 'string',
            enum: ['tax_exclusive', 'tax_inclusive'],
          },
          {
            type: 'null',
          },
        ],
        description:
          "tax_exclusive (the US norm): tariff prices exclude tax and the lines are added to them. tax_inclusive: tariff prices include every line, and the lines are taken out of the price the driver pays. Default tax_exclusive, or the preset's.",
      },
      lines: {
        anyOf: [
          {
            items: {
              properties: {
                name: {
                  type: 'string',
                  maxLength: 40,
                  minLength: 1,
                  description:
                    'Printed on receipts: GST, HST, PST, QST, state sales tax, county, city, EV excise.',
                },
                type: {
                  type: 'string',
                  enum: ['percent', 'per_kwh'],
                  description:
                    "percent: rate is a percentage of the components it taxes. per_kwh: rate is minor units of the bill's currency per kWh delivered (2.6 is 2.6 cents per kWh in USD).",
                },
                rate: {
                  type: 'number',
                  maximum: 1000,
                  minimum: 0,
                  description:
                    'At most 4 decimal places (9.975 for QST). percent: 0 to 100. per_kwh: 0 to 1000 minor units per kWh.',
                },
                registration_number: {
                  anyOf: [
                    {
                      type: 'string',
                      maxLength: 64,
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description: 'Your tax registration number for this tax, printed on receipts.',
                },
                order: {
                  anyOf: [
                    {
                      type: 'integer',
                      maximum: 100,
                      minimum: 1,
                    },
                    {
                      type: 'null',
                    },
                  ],
                  description:
                    'Position among the lines, ascending; lines without one keep their place after those with one.',
                },
                compound: {
                  type: 'boolean',
                  description:
                    "percent lines: the base includes the earlier lines' tax. Never on the first line or a per_kwh line.",
                  default: false,
                },
                excluded_components: {
                  items: {
                    type: 'string',
                    enum: ['ENERGY', 'TIME', 'PARKING_TIME', 'FLAT'],
                  },
                  type: 'array',
                  maxItems: 4,
                  description:
                    'percent lines: tariff components this line does not tax (for example PARKING_TIME). Empty: all of them.',
                },
              },
              additionalProperties: false,
              type: 'object',
              required: ['name', 'type', 'rate'],
            },
            type: 'array',
            maxItems: 10,
          },
          {
            type: 'null',
          },
        ],
        description:
          'The tax lines, applied in order. [] removes every line: the location has no tax.',
      },
      preset: {
        anyOf: [
          {
            type: 'string',
            pattern: '^[A-Za-z]{2}-[A-Za-z]{2}$',
          },
          {
            type: 'null',
          },
        ],
        description:
          "A preset from GET /v1/tax-presets as the configuration, instead of lines. Ivora does not guarantee a preset's legal correctness: check it applies to you.",
      },
      confirm_preset: {
        type: 'boolean',
        description:
          'With preset: true confirms that you checked the preset applies to this location.',
        default: false,
      },
    },
    additionalProperties: false,
    type: 'object',
    description:
      "Replaces the location's tax configuration. Give lines (with price_mode), or a preset with confirm_preset true.",
  },
  ocpi_publishing_set_the_tenant_s_ocpi_publishing_settings: {
    properties: {
      publish: {
        type: 'boolean',
        description:
          "Publish this tenant's locations and tariffs over OCPI. Off by default; refused (409 ocpi_tenant_private) for a tenant Ivora keeps private.",
      },
      display_name: {
        anyOf: [
          {
            type: 'string',
            maxLength: 100,
            minLength: 1,
          },
          {
            type: 'null',
          },
        ],
        description:
          'The operator name partners show (Location operator and owner). Required to publish.',
      },
      website: {
        anyOf: [
          {
            type: 'string',
            maxLength: 255,
            pattern: '^https://[^\\s/@]+(/\\S*)?$',
          },
          {
            type: 'null',
          },
        ],
        description: "The operator's https website, in Location operator and owner.",
      },
      time_zone: {
        anyOf: [
          {
            type: 'string',
            maxLength: 64,
            pattern: '^[A-Za-z_]+(/[A-Za-z0-9_+\\-]+)+$',
          },
          {
            type: 'null',
          },
        ],
        description:
          'IANA zone, such as America/Los_Angeles, for locations without one. Without either, a location is not published.',
      },
      connector_defaults: {
        anyOf: [
          {
            properties: {
              standard: {
                anyOf: [
                  {
                    type: 'string',
                    enum: [
                      'CHADEMO',
                      'CHAOJI',
                      'DOMESTIC_A',
                      'DOMESTIC_B',
                      'DOMESTIC_C',
                      'DOMESTIC_D',
                      'DOMESTIC_E',
                      'DOMESTIC_F',
                      'DOMESTIC_G',
                      'DOMESTIC_H',
                      'DOMESTIC_I',
                      'DOMESTIC_J',
                      'DOMESTIC_K',
                      'DOMESTIC_L',
                      'DOMESTIC_M',
                      'DOMESTIC_N',
                      'DOMESTIC_O',
                      'GBT_AC',
                      'GBT_DC',
                      'IEC_60309_2_single_16',
                      'IEC_60309_2_three_16',
                      'IEC_60309_2_three_32',
                      'IEC_60309_2_three_64',
                      'IEC_62196_T1',
                      'IEC_62196_T1_COMBO',
                      'IEC_62196_T2',
                      'IEC_62196_T2_COMBO',
                      'IEC_62196_T3A',
                      'IEC_62196_T3C',
                      'NEMA_10_30',
                      'NEMA_10_50',
                      'NEMA_14_30',
                      'NEMA_14_50',
                      'NEMA_5_20',
                      'NEMA_6_30',
                      'NEMA_6_50',
                      'PANTOGRAPH_BOTTOM_UP',
                      'PANTOGRAPH_TOP_DOWN',
                      'TESLA_R',
                      'TESLA_S',
                    ],
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'OCPI 2.2.1 ConnectorType.',
              },
              format: {
                anyOf: [
                  {
                    type: 'string',
                    enum: ['CABLE', 'SOCKET'],
                  },
                  {
                    type: 'null',
                  },
                ],
              },
              power_type: {
                anyOf: [
                  {
                    type: 'string',
                    enum: ['AC_1_PHASE', 'AC_2_PHASE', 'AC_2_PHASE_SPLIT', 'AC_3_PHASE', 'DC'],
                  },
                  {
                    type: 'null',
                  },
                ],
              },
              max_voltage: {
                anyOf: [
                  {
                    type: 'integer',
                    maximum: 2000,
                    minimum: 1,
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Volts.',
              },
              max_amperage: {
                anyOf: [
                  {
                    type: 'integer',
                    maximum: 2000,
                    minimum: 1,
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'Amperes.',
              },
            },
            additionalProperties: false,
            type: 'object',
          },
          {
            type: 'null',
          },
        ],
        description:
          'Connector facts for connectors the charging core has none for; unset ones are a North American Level 2 J1772 cable, 240 V and 32 A.',
      },
      excluded_location_ids: {
        items: {
          type: 'integer',
          exclusiveMinimum: 0,
        },
        type: 'array',
        maxItems: 1000,
        description: 'Location IDs never published.',
      },
      own_party: {
        anyOf: [
          {
            properties: {
              country_code: {
                type: 'string',
                pattern: '^[A-Z]{2}$',
                description:
                  'ISO 3166 alpha-2 country of the registry that issued the party ID, such as US.',
              },
              party_id: {
                type: 'string',
                pattern: '^[A-Z0-9]{3}$',
                description: 'The party ID the registry issued: 3 capital letters or digits.',
              },
            },
            additionalProperties: false,
            type: 'object',
            required: ['country_code', 'party_id'],
          },
          {
            type: 'null',
          },
        ],
        description:
          "Your own OCPI party. Used only once Ivora staff approved it (own_party.status approved); until then, and with null, locations publish under Ivora's shared party US*IVR with your display_name as operator.",
      },
      audience: {
        anyOf: [
          {
            type: 'string',
            enum: ['public', 'own_partners'],
          },
          {
            type: 'null',
          },
        ],
        description:
          "Who is told about your locations. public (the default for projects that publish): every connection that carries your party, Ivora's roaming partners included. own_partners: only the roaming partners you added yourself. own_partners needs an approved own_party (409 ocpi_party_required). Omit to leave unchanged.",
      },
    },
    additionalProperties: false,
    type: 'object',
    required: ['publish'],
  },
  stations_add_a_connector_to_an_evse: {
    properties: {
      type: {
        anyOf: [
          {
            type: 'string',
            enum: [
              'CHAdeMO',
              'ChaoJi',
              'DomesticA',
              'DomesticB',
              'DomesticC',
              'DomesticD',
              'DomesticE',
              'DomesticF',
              'DomesticG',
              'DomesticH',
              'DomesticI',
              'DomesticJ',
              'DomesticK',
              'DomesticL',
              'DomesticM',
              'DomesticN',
              'DomesticO',
              'GBTAC',
              'GBTDC',
              'IEC603092Single16',
              'IEC603092Three16',
              'IEC603092Three32',
              'IEC603092Three64',
              'IEC62196T1',
              'IEC62196T1COMBO',
              'IEC62196T2',
              'IEC62196T2COMBO',
              'IEC62196T3A',
              'IEC62196T3C',
              'NEMA520',
              'NEMA630',
              'NEMA650',
              'NEMA1030',
              'NEMA1050',
              'NEMA1430',
              'NEMA1450',
              'PantographBottomUp',
              'PantographTopDown',
              'TeslaR',
              'TeslaS',
            ],
          },
          {
            type: 'null',
          },
        ],
        description:
          'OCPP 2.x connector type, for example IEC62196T1 (J1772), IEC62196T1COMBO (CCS1) or CHAdeMO.',
      },
      format: {
        anyOf: [
          {
            type: 'string',
            enum: ['Socket', 'Cable'],
          },
          {
            type: 'null',
          },
        ],
      },
      power_type: {
        anyOf: [
          {
            type: 'string',
            enum: ['AC1Phase', 'AC2Phase', 'AC2PhaseSplit', 'AC3Phase', 'DC'],
          },
          {
            type: 'null',
          },
        ],
      },
      max_power_w: {
        anyOf: [
          {
            type: 'integer',
            maximum: 1000000,
            minimum: 1,
          },
          {
            type: 'null',
          },
        ],
        description: 'Maximum power in W (watts), for example 7400 or 150000.',
      },
      max_amperage_a: {
        anyOf: [
          {
            type: 'integer',
            maximum: 2000,
            minimum: 1,
          },
          {
            type: 'null',
          },
        ],
        description: 'Maximum current in A (amperes).',
      },
      max_voltage_v: {
        anyOf: [
          {
            type: 'integer',
            maximum: 2000,
            minimum: 1,
          },
          {
            type: 'null',
          },
        ],
        description: 'Maximum voltage in V (volts).',
      },
    },
    additionalProperties: false,
    type: 'object',
    description:
      "A new connector's physical description; omitted fields stay unknown. Its tariff is set as for any connector (tariffs).",
  },
  stations_add_an_evse_with_its_connectors: {
    properties: {
      evse_number: {
        anyOf: [
          {
            type: 'integer',
            maximum: 99,
            minimum: 1,
          },
          {
            type: 'null',
          },
        ],
        description:
          "The EVSE's number on the station (OCPP 2.x evseId); omit for the next free number.",
      },
      physical_reference: {
        anyOf: [
          {
            type: 'string',
            maxLength: 16,
            minLength: 1,
          },
          {
            type: 'null',
          },
        ],
        description: 'Label printed on the EVSE, for example A or 2 (OCPI physical_reference).',
      },
      connectors: {
        items: {
          properties: {
            type: {
              anyOf: [
                {
                  type: 'string',
                  enum: [
                    'CHAdeMO',
                    'ChaoJi',
                    'DomesticA',
                    'DomesticB',
                    'DomesticC',
                    'DomesticD',
                    'DomesticE',
                    'DomesticF',
                    'DomesticG',
                    'DomesticH',
                    'DomesticI',
                    'DomesticJ',
                    'DomesticK',
                    'DomesticL',
                    'DomesticM',
                    'DomesticN',
                    'DomesticO',
                    'GBTAC',
                    'GBTDC',
                    'IEC603092Single16',
                    'IEC603092Three16',
                    'IEC603092Three32',
                    'IEC603092Three64',
                    'IEC62196T1',
                    'IEC62196T1COMBO',
                    'IEC62196T2',
                    'IEC62196T2COMBO',
                    'IEC62196T3A',
                    'IEC62196T3C',
                    'NEMA520',
                    'NEMA630',
                    'NEMA650',
                    'NEMA1030',
                    'NEMA1050',
                    'NEMA1430',
                    'NEMA1450',
                    'PantographBottomUp',
                    'PantographTopDown',
                    'TeslaR',
                    'TeslaS',
                  ],
                },
                {
                  type: 'null',
                },
              ],
              description:
                'OCPP 2.x connector type, for example IEC62196T1 (J1772), IEC62196T1COMBO (CCS1) or CHAdeMO.',
            },
            format: {
              anyOf: [
                {
                  type: 'string',
                  enum: ['Socket', 'Cable'],
                },
                {
                  type: 'null',
                },
              ],
            },
            power_type: {
              anyOf: [
                {
                  type: 'string',
                  enum: ['AC1Phase', 'AC2Phase', 'AC2PhaseSplit', 'AC3Phase', 'DC'],
                },
                {
                  type: 'null',
                },
              ],
            },
            max_power_w: {
              anyOf: [
                {
                  type: 'integer',
                  maximum: 1000000,
                  minimum: 1,
                },
                {
                  type: 'null',
                },
              ],
              description: 'Maximum power in W (watts), for example 7400 or 150000.',
            },
            max_amperage_a: {
              anyOf: [
                {
                  type: 'integer',
                  maximum: 2000,
                  minimum: 1,
                },
                {
                  type: 'null',
                },
              ],
              description: 'Maximum current in A (amperes).',
            },
            max_voltage_v: {
              anyOf: [
                {
                  type: 'integer',
                  maximum: 2000,
                  minimum: 1,
                },
                {
                  type: 'null',
                },
              ],
              description: 'Maximum voltage in V (volts).',
            },
          },
          additionalProperties: false,
          type: 'object',
          description:
            "A new connector's physical description; omitted fields stay unknown. Its tariff is set as for any connector (tariffs).",
        },
        type: 'array',
        maxItems: 8,
        minItems: 1,
        description:
          'Its connectors, numbered 1, 2, ... on the EVSE; one undescribed connector when omitted.',
      },
    },
    additionalProperties: false,
    type: 'object',
  },
  stations_assign_a_tariff_to_a_connector: {
    properties: {
      tariff_id: {
        type: 'integer',
        exclusiveMinimum: 0,
        description: 'An active tariff in this tenant (id from the tariff routes).',
      },
    },
    additionalProperties: false,
    type: 'object',
    required: ['tariff_id'],
  },
  stations_register_a_station_and_return_it: {
    properties: {
      name: {
        anyOf: [
          {
            type: 'string',
            pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{2,35}$',
          },
          {
            type: 'null',
          },
        ],
        description:
          'Globally unique OCPP connection name; the charger connects at <connection_url>. Supply name or charger_id. Once the global charger URL is closed to new registrations in an environment, name answers 409 global_charger_url_retired: register with charger_id.',
      },
      charger_id: {
        anyOf: [
          {
            type: 'string',
            pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$',
          },
          {
            type: 'null',
          },
        ],
        description:
          "The charger's own OCPP identity, unique within this project. Per-project charger URLs are on by default where offered (409 project_urls_disabled where they are off for the project or not offered). The charger connects at connection_url, or appends this ID to connection_base_url, and uses it as its Basic authentication username. At most 36 characters together with p<tenant_id>-, for example 31 for tenant 18.",
      },
      location_id: {
        type: 'integer',
        exclusiveMinimum: 0,
      },
      connectors: {
        type: 'integer',
        maximum: 8,
        minimum: 1,
        default: 1,
      },
      external_reference: {
        anyOf: [
          {
            type: 'string',
            pattern: '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$',
          },
          {
            type: 'null',
          },
        ],
        description:
          'Your stable identifier for this resource (for example a property or listing ID). Unique per tenant and resource type. Filter lists with ?external_reference=. No customer data or secrets.',
      },
      metadata: {
        anyOf: [
          {
            additionalProperties: {
              anyOf: [
                {
                  type: 'string',
                  maxLength: 500,
                },
                {
                  type: 'null',
                },
              ],
            },
            propertyNames: {
              pattern: '^[A-Za-z0-9_.-]{1,40}$',
            },
            type: 'object',
            maxProperties: 50,
          },
          {
            type: 'null',
          },
        ],
        description:
          'Your own key/value pairs (strings), such as a site host or a contract ID: at most 50 keys of 1-40 characters of A-Z, a-z, 0-9, underscore, period and hyphen, values of at most 500 characters. Never secrets or personal data. Never published to OCPI roaming partners. On create, sets the pairs; on PATCH, merges them into the stored ones: a key sent as "" or null is deleted, other keys keep their values.',
      },
    },
    additionalProperties: false,
    type: 'object',
    required: ['location_id'],
  },
  tariffs_and_bills_create_a_core_tariff_version_and_return_it: {
    properties: {
      currency: {
        type: 'string',
        pattern: '^[A-Z]{3}$',
        description:
          'ISO 4217 code, upper-case: one of the supported currencies (GET /v1/currencies), else 422 currency_unsupported. Every amount of the tariff and of its bills is in this currency; there is no conversion.',
      },
      rate_minor_per_kwh: {
        anyOf: [
          {
            type: 'integer',
            maximum: 100000,
            minimum: 0,
          },
          {
            type: 'null',
          },
        ],
        description:
          'Integer minor units of currency per kWh (cents for USD and CAD). Required without elements.',
      },
      authorization_minor: {
        type: 'integer',
        maximum: 100000,
        minimum: 0,
        description: 'Integer minor units held before charging.',
      },
      rate_minor_per_minute: {
        anyOf: [
          {
            type: 'integer',
            maximum: 100000,
            minimum: 0,
          },
          {
            type: 'null',
          },
        ],
        description:
          'Optional integer minor units per minute. The simple fields are kWh-only: a simple tariff bills rate_minor_per_kwh × kWh and no time or session fee, so only 0 is accepted (and stored as 0); a non-zero value returns 422. Price charging time, idle time or a session fee with elements (TIME, PARKING_TIME, FLAT). Tariffs created elsewhere may still carry one, which is returned unchanged and not billed.',
      },
      session_fee_minor: {
        anyOf: [
          {
            type: 'integer',
            maximum: 100000,
            minimum: 0,
          },
          {
            type: 'null',
          },
        ],
        description:
          'Optional integer minor units per session. The simple fields are kWh-only: a simple tariff bills rate_minor_per_kwh × kWh and no time or session fee, so only 0 is accepted (and stored as 0); a non-zero value returns 422. Price charging time, idle time or a session fee with elements (TIME, PARKING_TIME, FLAT). Tariffs created elsewhere may still carry one, which is returned unchanged and not billed.',
      },
      external_reference: {
        anyOf: [
          {
            type: 'string',
            pattern: '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$',
          },
          {
            type: 'null',
          },
        ],
        description:
          'Your stable identifier for this resource (for example a property or listing ID). Unique per tenant and resource type. Filter lists with ?external_reference=. No customer data or secrets.',
      },
      elements: {
        anyOf: [
          {
            items: {
              properties: {
                price_components: {
                  items: {
                    properties: {
                      type: {
                        type: 'string',
                        enum: ['ENERGY', 'TIME', 'PARKING_TIME', 'FLAT'],
                        description:
                          "ENERGY: price per kWh. TIME: price per hour while charging. PARKING_TIME: price per hour idle (connected, not charging). FLAT: a fee per session (per reservation in a reservation element). Bills tell charging from idle time from the charger's reports and charge TIME and PARKING_TIME accordingly; when a session has too little data, all of it is charging time.",
                      },
                      price: {
                        type: 'number',
                        maximum: 10000,
                        minimum: 0,
                        description:
                          "Major units excluding tax, at most 4 decimal places (OCPI): 0.35 is 0.35 of the tariff's currency (35 cents for USD) per kWh.",
                      },
                      step_size: {
                        type: 'integer',
                        maximum: 86400,
                        minimum: 1,
                        description:
                          "OCPI step size: ENERGY in Wh, TIME and PARKING_TIME in seconds; the dimension's total rounds up to a multiple of the last billed element's step. 1 bills the metered quantity exactly. Ignored for FLAT.",
                        default: 1,
                      },
                    },
                    additionalProperties: false,
                    type: 'object',
                    required: ['type', 'price'],
                  },
                  type: 'array',
                  maxItems: 4,
                  minItems: 1,
                },
                restrictions: {
                  anyOf: [
                    {
                      properties: {
                        start_time: {
                          anyOf: [
                            {
                              type: 'string',
                              pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'Local time of day (HH:MM) from which the element applies.',
                        },
                        end_time: {
                          anyOf: [
                            {
                              type: 'string',
                              pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description:
                            'Local time of day (HH:MM) until which the element applies (exclusive).',
                        },
                        start_date: {
                          anyOf: [
                            {
                              type: 'string',
                              pattern: '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'Local date (YYYY-MM-DD) from which the element applies.',
                        },
                        end_date: {
                          anyOf: [
                            {
                              type: 'string',
                              pattern: '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$',
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description:
                            'Local date (YYYY-MM-DD) until which the element applies (exclusive).',
                        },
                        min_kwh: {
                          anyOf: [
                            {
                              type: 'number',
                              maximum: 100000,
                              minimum: 0,
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'Energy already charged in the session, kWh (inclusive).',
                        },
                        max_kwh: {
                          anyOf: [
                            {
                              type: 'number',
                              maximum: 100000,
                              minimum: 0,
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'Energy already charged in the session, kWh (exclusive).',
                        },
                        min_current: {
                          anyOf: [
                            {
                              type: 'number',
                              maximum: 10000,
                              minimum: 0,
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description:
                            'Charging current, A (inclusive). An element restricting current never applies when the current is unknown.',
                        },
                        max_current: {
                          anyOf: [
                            {
                              type: 'number',
                              maximum: 10000,
                              minimum: 0,
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'Charging current, A (exclusive).',
                        },
                        min_power: {
                          anyOf: [
                            {
                              type: 'number',
                              maximum: 10000,
                              minimum: 0,
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description:
                            'Charging power, kW (inclusive). Unknown power matches no power-restricted element.',
                        },
                        max_power: {
                          anyOf: [
                            {
                              type: 'number',
                              maximum: 10000,
                              minimum: 0,
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'Charging power, kW (exclusive).',
                        },
                        min_duration: {
                          anyOf: [
                            {
                              type: 'integer',
                              maximum: 604800,
                              minimum: 0,
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'Session duration so far, seconds (inclusive).',
                        },
                        max_duration: {
                          anyOf: [
                            {
                              type: 'integer',
                              maximum: 604800,
                              minimum: 0,
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description: 'Session duration so far, seconds (exclusive).',
                        },
                        day_of_week: {
                          anyOf: [
                            {
                              items: {
                                type: 'string',
                                enum: [
                                  'MONDAY',
                                  'TUESDAY',
                                  'WEDNESDAY',
                                  'THURSDAY',
                                  'FRIDAY',
                                  'SATURDAY',
                                  'SUNDAY',
                                ],
                              },
                              type: 'array',
                              maxItems: 7,
                              minItems: 1,
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description:
                            'Local days on which the element applies. A time window that wraps midnight belongs to the day it opens (OCPI 2.2.1): FRIDAY with 22:00–02:00 runs from Friday 22:00 to Saturday 02:00.',
                        },
                        reservation: {
                          anyOf: [
                            {
                              type: 'string',
                              enum: ['RESERVATION', 'RESERVATION_EXPIRES'],
                            },
                            {
                              type: 'null',
                            },
                          ],
                          description:
                            'Prices a reservation (TIME: reserved time, FLAT: reservation fee) instead of charging; RESERVATION_EXPIRES only when the reservation expires unused.',
                        },
                      },
                      additionalProperties: false,
                      type: 'object',
                      description:
                        "OCPI 2.2.1 TariffRestrictions, evaluated in the tariff's local time. All given restrictions must hold. min values\nare inclusive, max values and end times/dates exclusive; an end_time before its start_time wraps midnight.",
                    },
                    {
                      type: 'null',
                    },
                  ],
                },
              },
              additionalProperties: false,
              type: 'object',
              required: ['price_components'],
            },
            type: 'array',
            maxItems: 16,
            minItems: 1,
          },
          {
            type: 'null',
          },
        ],
        description:
          "Optional OCPI 2.2.1-aligned price blocks; omit for a simple tariff (one ENERGY block at rate_minor_per_kwh). With elements, rate_minor_per_kwh may be omitted: it becomes the base rate (the last unrestricted element's ENERGY price) that charger screens and clients before API version 2026-10-15 read; if you send it, it must equal that base rate. OCPI 2.2.1 TariffElements, the native tariff format. For each moment of a session the first element that prices a dimension and whose restrictions all hold applies. Overlapping time windows must nest (narrower first) and an element may not hide a later one.",
      },
      tariff_alt_text: {
        anyOf: [
          {
            items: {
              properties: {
                language: {
                  type: 'string',
                  pattern: '^[a-z]{2}$',
                  description: 'ISO 639-1 language code.',
                },
                text: {
                  type: 'string',
                  maxLength: 512,
                  minLength: 1,
                  description: 'Driver-facing description of the tariff.',
                },
              },
              additionalProperties: false,
              type: 'object',
              required: ['language', 'text'],
            },
            type: 'array',
            maxItems: 10,
            minItems: 1,
          },
          {
            type: 'null',
          },
        ],
        description:
          'Driver-facing descriptions (OCPI tariff_alt_text), at most one per language. Omit to have Ivora generate an English one from the elements; a tariff too complex to describe in 512 characters is refused unless you supply it.',
      },
      rules: {
        anyOf: [
          {
            properties: {
              group_discounts: {
                items: {
                  properties: {
                    id: {
                      type: 'string',
                      pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$',
                      description:
                        'Your name for this discount; shown on quote and bill adjustments.',
                    },
                    groups: {
                      items: {
                        type: 'string',
                      },
                      type: 'array',
                      maxItems: 50,
                      description:
                        "Member or RFID groups (the session's group) the discount applies to.",
                    },
                    id_tokens: {
                      items: {
                        type: 'string',
                      },
                      type: 'array',
                      maxItems: 500,
                      description:
                        "RFID or app tokens (the session's id_token) the discount applies to.",
                    },
                    percent_off: {
                      type: 'integer',
                      maximum: 100,
                      minimum: 1,
                    },
                  },
                  additionalProperties: false,
                  type: 'object',
                  required: ['id', 'percent_off'],
                },
                type: 'array',
                maxItems: 20,
                description:
                  'Member/RFID group discounts: the largest matching one applies; they never stack.',
              },
              merchant_validation: {
                anyOf: [
                  {
                    properties: {
                      percent_off: {
                        anyOf: [
                          {
                            type: 'integer',
                            maximum: 100,
                            minimum: 1,
                          },
                          {
                            type: 'null',
                          },
                        ],
                      },
                      amount_off_minor: {
                        anyOf: [
                          {
                            type: 'integer',
                            maximum: 10000000,
                            minimum: 1,
                          },
                          {
                            type: 'null',
                          },
                        ],
                        description: 'Integer minor units off, never below 0.',
                      },
                      codes: {
                        items: {
                          type: 'string',
                        },
                        type: 'array',
                        maxItems: 100,
                        description:
                          'Accepted validation codes; empty accepts any code the session carries.',
                      },
                    },
                    additionalProperties: false,
                    type: 'object',
                  },
                  {
                    type: 'null',
                  },
                ],
                description: 'A discount when the session carries a merchant validation code.',
              },
              max_session_cost_minor: {
                anyOf: [
                  {
                    type: 'integer',
                    maximum: 100000000,
                    minimum: 1,
                  },
                  {
                    type: 'null',
                  },
                ],
                description: "Cap on a session's total, integer minor units.",
              },
              idle_grace_minutes: {
                anyOf: [
                  {
                    type: 'integer',
                    maximum: 1440,
                    minimum: 0,
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  "Free idle minutes: PARKING_TIME is charged only for idle time beyond the first N minutes of each session, counted from when charging ends. Partners over OCPI still see the plain PARKING_TIME price; the generated tariff text says 'idle fee after N free minutes' and the CDR carries the parking time actually charged. 0 or omitted: no grace.",
              },
              prepaid_limit: {
                type: 'boolean',
                description:
                  'Report, on quotes for sessions with prepaid_balance_minor, how much the balance covers and whether the session reaches it. It never changes the total; your application stops or tops up.',
                default: false,
              },
            },
            additionalProperties: false,
            type: 'object',
            description:
              'Ivora billing rules applied after the elements, in this order, and never published over OCPI: partners see the\nelements and tariff_alt_text only.',
          },
          {
            type: 'null',
          },
        ],
        description:
          'Ivora billing rules, applied after the elements in billing only; never published over OCPI.',
      },
      time_zone: {
        anyOf: [
          {
            type: 'string',
            maxLength: 64,
          },
          {
            type: 'null',
          },
        ],
        description:
          "IANA time zone of the restrictions' local times. Omit to use the station location's time zone when billing (UTC without one).",
      },
      metadata: {
        anyOf: [
          {
            additionalProperties: {
              anyOf: [
                {
                  type: 'string',
                  maxLength: 500,
                },
                {
                  type: 'null',
                },
              ],
            },
            propertyNames: {
              pattern: '^[A-Za-z0-9_.-]{1,40}$',
            },
            type: 'object',
            maxProperties: 50,
          },
          {
            type: 'null',
          },
        ],
        description:
          'Your own key/value pairs (strings), such as a site host or a contract ID: at most 50 keys of 1-40 characters of A-Z, a-z, 0-9, underscore, period and hyphen, values of at most 500 characters. Never secrets or personal data. Never published to OCPI roaming partners. On create, sets the pairs; on PATCH, merges them into the stored ones: a key sent as "" or null is deleted, other keys keep their values.',
      },
    },
    additionalProperties: false,
    type: 'object',
    required: ['currency', 'authorization_minor'],
  },
  tariffs_and_bills_set_the_project_s_default_tariff: {
    properties: {
      tariff_id: {
        type: 'integer',
        exclusiveMinimum: 0,
        description: 'An active tariff in this tenant (id from the tariff routes).',
      },
      confirm_currency: {
        type: 'boolean',
        description:
          "Required (true) when the tariff's currency is not the project's default_currency; without it such a tariff is refused with 409 tariff_currency_mismatch.",
        default: false,
      },
    },
    additionalProperties: false,
    type: 'object',
    required: ['tariff_id'],
  },
  webhooks_and_events_register_an_https_endpoint_for_tenant_events: {
    properties: {
      url: {
        type: 'string',
        maxLength: 512,
        minLength: 12,
      },
      events: {
        items: {
          type: 'string',
          enum: [
            'operation.completed',
            'charging_session.status_changed',
            'charging_session.settlement_reported',
            'bill.finalized',
            'bill.limit_reached',
            'tariff.updated',
            'tariff.archived',
            'webhook.test',
            'display.delivery_changed',
            'display.message_status_changed',
            'station.connected',
            'station.disconnected',
            'station.booted',
            'connector.status_changed',
            'station.fault_opened',
            'station.fault_cleared',
            'meter.sampled',
            'token.created',
            'token.updated',
            'token.deleted',
            'station.firmware_status',
            'station.diagnostics_status',
            'charging_profile.accepted',
            'charging_profile.rejected',
            'charging_profile.cleared',
            'station.ocpp_message',
            'station.credentials_changed',
            'station.configuration_changed',
            'station.decommissioned',
            'station.recommissioned',
            'site.flipped',
            'site.flip_rolled_back',
            'migration.charger_rolled_back',
          ],
        },
        type: 'array',
        maxItems: 33,
        minItems: 1,
        description: 'Event types to deliver. Each requires the read scope of the data it carries.',
      },
      description: {
        type: 'string',
        maxLength: 120,
        default: '',
      },
      stations: {
        anyOf: [
          {
            items: {
              type: 'integer',
            },
            type: 'array',
            maxItems: 500,
            minItems: 1,
          },
          {
            type: 'null',
          },
        ],
        description:
          'Deliver station, connector, fault, meter, firmware, diagnostics, charging profile and OCPP message events of these station resource IDs only. Omit for every station. Other event types are unaffected.',
      },
      meter: {
        anyOf: [
          {
            properties: {
              sample_interval_seconds: {
                type: 'integer',
                maximum: 3600,
                minimum: 10,
                description:
                  "Minimum seconds between meter.sampled deliveries of one transaction to this endpoint. A transaction's first and last samples are always delivered.",
                default: 60,
              },
            },
            additionalProperties: false,
            type: 'object',
          },
          {
            type: 'null',
          },
        ],
        description: 'meter.sampled options; the default interval is 60 seconds.',
      },
      ocpp_messages: {
        anyOf: [
          {
            properties: {
              actions: {
                anyOf: [
                  {
                    items: {
                      type: 'string',
                    },
                    type: 'array',
                    maxItems: 20,
                    minItems: 1,
                  },
                  {
                    type: 'null',
                  },
                ],
                description:
                  "Deliver station.ocpp_message for these OCPP actions only (a reply carries its request's action). null delivers every action, MeterValues and Heartbeat included: choose the actions you need.",
              },
            },
            additionalProperties: false,
            type: 'object',
          },
          {
            type: 'null',
          },
        ],
        description:
          "station.ocpp_message options. The event carries one redacted message as the station's OCPP message log shows it and requires stations:diagnostics. Volume: an endpoint with 1000 or more pending deliveries gets no new station.ocpp_message delivery; each one it misses is listed in its deliveries as dropped and stays in the event log and the message log.",
      },
    },
    additionalProperties: false,
    type: 'object',
    required: ['url', 'events'],
  },
};

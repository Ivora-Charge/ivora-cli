import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { parse } from 'yaml';
import { ExitCode } from '../../src/lib/output.js';
import { MAX_PAGES, PAGE_LIMIT } from '../../src/lib/export/fetch.js';
import { decimal } from '../../src/lib/export/build.js';
import { validateText } from '../../src/schema/document.js';
import { loadSpec, startMockApi, type MockApi } from '../mock-server.js';
import { sandbox, TEST_KEY } from './helpers.js';

const LEAK = 'whsec_SHOULD_NEVER_APPEAR';
const META_LEAK = 'sk_SHOULD_NEVER_APPEAR';
const T = '/v1/tenants/{tenant_id}';
const P = '/v1/tenants/42';

/** A fake project: two locations, three tariffs (one archived elsewhere), two stations. */
function fakeSpec() {
  const spec = loadSpec();
  const set = (path: string, example: unknown): void => {
    const op = spec.paths[path]?.get as {
      responses: Record<string, { content: Record<string, { example?: unknown }> }>;
    };
    assert.ok(op, path);
    (op.responses['200'] as { content: Record<string, { example?: unknown }> }).content[
      'application/json'
    ] = { example };
  };
  set(`${T}/locations`, {
    data: [
      {
        id: 1,
        tenant_id: 42,
        name: 'Depot North',
        city: 'Example City',
        country: 'USA',
        address: null,
        time_zone: 'America/Los_Angeles',
        opening_hours: {
          twenty_four_seven: false,
          regular_hours: [{ weekday: 1, period_begin: '06:00', period_end: '22:00' }],
          exceptional_openings: [],
          exceptional_closings: [],
        },
        metadata: { 'ivora.key': 'depot' },
      },
      {
        id: 2,
        tenant_id: 42,
        name: 'Mall',
        opening_hours: null,
        metadata: { api_key: META_LEAK, floor: 'B1' },
      },
    ],
    next_cursor: 2,
  });
  set(`${T}/locations/{location_id}`, {
    id: 2,
    tenant_id: 42,
    name: 'Mall',
    metadata: { floor: 'B1' },
  });
  set(`${T}/locations/{location_id}/default-tariff`, { scope: 'location', tariff_id: 7 });
  set(`${T}/default-tariff`, { scope: 'project', tariff_id: 8 });
  set(`${T}/tariffs`, {
    data: [
      {
        id: 7,
        tenant_id: 42,
        currency: 'USD',
        authorization_minor: 5000,
        archived: false,
        is_complex: true,
        pricing_summary: 'x',
        elements: [
          {
            price_components: [
              { type: 'ENERGY', price: 0.45, step_size: 1 },
              { type: 'PARKING_TIME', price: 6, step_size: 60 },
            ],
          },
        ],
        rules: { idle_grace_minutes: 10 },
        metadata: { 'ivora.key': 'standard' },
      },
      {
        id: 8,
        tenant_id: 42,
        currency: 'USD',
        authorization_minor: 5000,
        archived: false,
        elements: [{ price_components: [{ type: 'ENERGY', price: '0.59', step_size: 1 }] }],
        metadata: {},
      },
    ],
    next_cursor: null,
  });
  set(`${T}/stations`, {
    data: [
      {
        id: 100,
        tenant_id: 42,
        name: 'Bay 1',
        charger_id: 'CP-01',
        location_id: 1,
        username: 'CP-01',
        online: true,
        evses: [{ evse_number: 1, physical_reference: null }],
        connectors: [
          {
            id: 9,
            number: 1,
            evse_number: 1,
            evse_connector_number: 1,
            status: 'Available',
            type: 'IEC62196T1COMBO',
            power_type: 'DC',
            max_power_w: 150000,
            max_amperage_a: 300,
            max_voltage_v: 500,
            tariff_id: 8,
          },
          {
            id: 10,
            number: 2,
            evse_number: 1,
            evse_connector_number: 2,
            type: 'IEC62196T1',
            tariff_id: 999, // archived: not in the active list
          },
        ],
        metadata: { 'ivora.key': 'cp-01' },
      },
      {
        id: 101,
        tenant_id: 42,
        name: 'Bay 2',
        charger_id: 'CP-02',
        location_id: 2,
        evses: [],
        connectors: [],
        metadata: { password: 'hunter2-SHOULD_NEVER_APPEAR' },
      },
    ],
    next_cursor: null,
  });
  set(`${T}/stations/{station_id}/displays`, { data: [] });
  set(`${T}/webhooks`, {
    data: [
      {
        id: 'wh_1',
        url: 'https://hooks.example.com/ivora',
        events: ['connector.status_changed'],
        status: 'active',
        stations: [100],
        api_version: '2026-01-01',
        secret: LEAK,
      },
      {
        id: 'wh_2',
        url: 'https://hooks.example.com/old',
        events: ['bill.finalized'],
        status: 'disabled',
      },
    ],
  });
  set(`${T}/ocpi`, {
    tenant_id: 42,
    publish: true,
    private: false,
    published: true,
    display_name: 'Example',
    excluded_location_ids: [2],
    own_party: [{ country_code: 'US', party_id: 'EXA', status: 'approved' }],
    audience: 'public',
    connector_defaults: { standard: null, format: null },
  });
  return spec;
}

let api: MockApi;
before(async () => {
  api = await startMockApi(fakeSpec());
});
after(async () => {
  await api.close();
});

/** Per-station and per-location reads that differ from the spec's examples. */
function enqueueRich(): void {
  api.enqueue('GET', `${P}/locations/1/tax`, {
    status: 200,
    body: {
      location_id: 1,
      configured: true,
      price_mode: 'tax_exclusive',
      lines: [
        { order: 1, name: 'State sales tax', type: 'percent', rate: '7.25', compound: false },
        { order: 2, name: 'Energy tax', type: 'per_kwh', rate: 0.3, excluded_components: [] },
      ],
      preset: null,
      updated_at: '2026-11-01T00:00:00Z',
    },
  });
  api.enqueue('GET', `${P}/stations/100/displays`, {
    status: 200,
    body: {
      data: [
        {
          id: 'd1',
          station_id: 100,
          evse_number: 1,
          qr: 'https://pay.example.com/cp-01',
          show_price: true,
          visibility: 'idle',
          tariff_id: 7,
          revision: 3,
          delivery: { state: 'applied' },
        },
        { id: 'd2', station_id: 100, evse_number: 2, qr: 'x', deleted: true },
      ],
    },
  });
  api.enqueue('GET', `${P}/stations/100/running-cost`, {
    status: 200,
    body: { station_id: 100, enabled: true, interval_seconds: 30, source: 'manual' },
  });
  api.enqueue('GET', `${P}/stations/100/display-pricing`, {
    status: 200,
    body: { station_id: 100, enabled: true, source: 'manual', status: 'active' },
  });
}

describe('ivora export', () => {
  it('writes the 1.1 shape with GETs only, and the output passes ivora validate', async () => {
    const s = await sandbox(api);
    const file = join(s.dir, 'ivora.yaml');
    const start = api.requests.length;
    enqueueRich();
    assert.equal(await s.go(['export', '-o', file]), ExitCode.Ok, s.err.text);
    const text = await readFile(file, 'utf8');

    const result = validateText(text);
    assert.deepEqual(result.issues, [], 'the export validates against the P1a schema');
    assert.deepEqual(
      result.skipped.map((x) => x.section),
      [],
      'admin sections are not written as entries',
    );
    assert.doesNotMatch(s.err.text, /does not validate/);

    for (const leak of [LEAK, META_LEAK, 'hunter2', TEST_KEY]) {
      assert.ok(!text.includes(leak), `${leak} is not in the file`);
      assert.ok(!s.err.text.includes(leak), `${leak} is not on stderr`);
      assert.ok(!s.out.text.includes(leak), `${leak} is not on stdout`);
    }

    const doc = parse(text);
    assert.equal(doc.version, 1);
    assert.equal(doc.project, '42', 'project is the tenant id string');
    assert.equal(doc.default_tariff, 'tariff-8', 'the project default sits at the root');

    // Keyed maps, keys from metadata["ivora.key"] or generated; no platform ids.
    assert.deepEqual(Object.keys(doc.locations), ['depot', 'mall']);
    const depot = doc.locations.depot;
    assert.equal(depot.name, 'Depot North');
    assert.equal(depot.id, undefined);
    assert.equal(depot.address, undefined, 'nulls are dropped');
    assert.equal(depot.metadata, undefined, 'ivora.key is the map key, not metadata');
    assert.equal(depot.default_tariff, 'standard');
    assert.deepEqual(depot.opening_hours, {
      twenty_four_seven: false,
      regular_hours: [{ weekday: 1, period_begin: '06:00', period_end: '22:00' }],
    });
    assert.deepEqual(depot.tax, {
      price_mode: 'tax_exclusive',
      lines: [
        { name: 'State sales tax', type: 'percent', rate: '7.25', order: 1, compound: false },
        { name: 'Energy tax', type: 'per_kwh', rate: '0.3', order: 2 },
      ],
    });
    assert.deepEqual(doc.locations.mall.metadata, { floor: 'B1' }, 'secret-like metadata is cut');
    assert.equal(doc.locations.mall.tax, undefined, 'unconfigured tax is not declared');

    assert.deepEqual(Object.keys(doc.tariffs), ['standard', 'tariff-8']);
    const std = doc.tariffs.standard;
    assert.equal(std.id, undefined);
    assert.equal(std.archived, undefined);
    assert.equal(std.pricing_summary, undefined);
    assert.deepEqual(std.elements[0].price_components, [
      { type: 'ENERGY', price: '0.45', step_size: 1 },
      { type: 'PARKING_TIME', price: '6', step_size: 60 },
    ]);
    assert.match(text, /price: "0\.45"/, 'money is a quoted string in the YAML text');

    assert.deepEqual(Object.keys(doc.stations), ['cp-01', 'cp-02']);
    const cp1 = doc.stations['cp-01'];
    assert.equal(cp1.location, 'depot');
    assert.equal(cp1.location_id, undefined);
    assert.equal(cp1.name, undefined, 'the platform derives the name from charger_id');
    assert.deepEqual(cp1.credentials, { secret: 'env:IVORA_CP_01_PASSWORD' });
    assert.equal(cp1.connectors, undefined, 'no connector count');
    assert.deepEqual(cp1.evses['1'].connectors['1'], {
      type: 'IEC62196T1COMBO',
      power_type: 'DC',
      max_power_w: 150000,
      max_amperage_a: 300,
      max_voltage_v: 500,
      tariff: 'tariff-8',
    });
    assert.deepEqual(cp1.evses['1'].connectors['2'], { type: 'IEC62196T1' });
    assert.match(s.err.text, /tariff 999 is not an active tariff/);
    assert.equal(doc.stations['cp-02'].location, 'mall');
    assert.equal(doc.stations['cp-02'].metadata, undefined);

    assert.deepEqual(doc.displays, {
      'cp-01': {
        qr: {
          1: {
            qr: 'https://pay.example.com/cp-01',
            show_price: true,
            visibility: 'idle',
            tariff: 'standard',
          },
        },
        running_cost: { enabled: true, interval_seconds: 30 },
        pricing_text: true,
      },
    });

    assert.deepEqual(doc.webhooks, {
      'webhook-wh-1': {
        url: 'https://hooks.example.com/ivora',
        events: ['connector.status_changed'],
        stations: ['cp-01'],
      },
    });
    assert.match(s.err.text, /endpoint wh_2 is disabled/);

    assert.deepEqual(doc.ocpi_publishing, {
      publish: true,
      display_name: 'Example',
      audience: 'public',
      excluded_locations: ['mall'],
      own_party: { country_code: 'US', party_id: 'EXA' },
    });

    assert.equal(doc.roaming_partners, undefined);
    assert.equal(doc.apps, undefined);
    assert.match(s.err.text, /skipped roaming_partners: needs a signed-in admin/);
    assert.match(s.err.text, /skipped apps: needs a signed-in user/);
    assert.match(text, /^# {3}roaming_partners: needs a signed-in admin/m);

    const seen = api.requests.slice(start);
    assert.ok(seen.length > 10);
    assert.ok(
      seen.every((r) => r.method === 'GET'),
      'only GET requests',
    );
    assert.ok(seen.every((r) => !r.path.startsWith('/v1/admin')));
    await s.cleanup();
  });

  it('exports one location with its stations and only the tariffs they use', async () => {
    const s = await sandbox(api);
    assert.equal(await s.go(['export', '--location', '2', '-o', '-']), ExitCode.Ok, s.err.text);
    assert.deepEqual(validateText(s.out.text).issues, []);
    const doc = parse(s.out.text);
    assert.deepEqual(Object.keys(doc.locations), ['mall']);
    assert.deepEqual(Object.keys(doc.stations), ['cp-02']);
    assert.deepEqual(Object.keys(doc.tariffs), ['standard'], 'the location default only');
    assert.equal(doc.locations.mall.default_tariff, 'standard');
    assert.equal(doc.default_tariff, undefined);
    assert.equal(doc.webhooks, undefined);
    assert.equal(doc.ocpi_publishing, undefined);
    await s.cleanup();
  });

  it('a failed default-tariff read leaves out that field only', async () => {
    const s = await sandbox(api);
    api.enqueue('GET', `${P}/locations/1/default-tariff`, {
      status: 403,
      body: { error: { code: 'forbidden', message: 'no' } },
    });
    assert.equal(await s.go(['export', '-o', '-']), ExitCode.Ok);
    const doc = parse(s.out.text);
    assert.deepEqual(Object.keys(doc.locations), ['depot', 'mall']);
    assert.equal(doc.locations.depot.default_tariff, undefined);
    assert.equal(doc.locations.mall.default_tariff, 'standard');
    assert.match(s.err.text, /skipped location 1 default_tariff: the API answered 403/);
    await s.cleanup();
  });

  it('skips a section the key cannot read and refuses to overwrite without --force', async () => {
    const s = await sandbox(api);
    const file = join(s.dir, 'ivora.yaml');
    api.enqueue('GET', `${P}/ocpi`, {
      status: 403,
      body: { error: { code: 'forbidden', message: 'no' } },
    });
    assert.equal(await s.go(['export', '-o', file]), ExitCode.Ok);
    const text = await readFile(file, 'utf8');
    assert.equal(parse(text).ocpi_publishing, undefined);
    assert.match(text, /^# {3}ocpi_publishing: the API answered 403/m);
    assert.match(s.err.text, /skipped ocpi_publishing/);
    assert.equal(await s.go(['export', '-o', file]), ExitCode.Usage);
    await writeFile(file, 'old');
    assert.equal(await s.go(['export', '-o', file, '--force']), ExitCode.Ok);
    assert.match(await readFile(file, 'utf8'), /^# ivora.yaml/);
    await s.cleanup();
  });

  it('errors rather than truncate a collection past MAX_PAGES', async () => {
    const s = await sandbox(api);
    const row = { id: 1, tenant_id: 42, name: 'x', metadata: {} };
    const page = Array.from({ length: PAGE_LIMIT }, () => row);
    for (let i = 0; i < MAX_PAGES; i++) {
      api.enqueue('GET', `${P}/locations`, {
        status: 200,
        body: { data: page, next_cursor: i + 10 },
      });
    }
    const file = join(s.dir, 'ivora.yaml');
    assert.equal(await s.go(['export', '-o', file]), ExitCode.ApiError);
    assert.match(s.err.text, /more than 10000 entries/);
    await assert.rejects(readFile(file), 'no partial file is written');
    await s.cleanup();
  });

  it('rejects --project with --location', async () => {
    const s = await sandbox(api);
    assert.equal(await s.go(['export', '--project', '--location', '1']), ExitCode.Usage);
    await s.cleanup();
  });
});

describe('decimal', () => {
  it('writes money as decimal strings', () => {
    assert.equal(decimal(0.45), '0.45');
    assert.equal(decimal(6), '6');
    assert.equal(decimal('0.59'), '0.59');
    assert.equal(decimal(1e-7), '0');
    assert.equal(decimal(0.12346), '0.1235');
  });
});

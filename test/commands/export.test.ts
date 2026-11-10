import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { parse } from 'yaml';
import { ExitCode } from '../../src/lib/output.js';
import { loadSpec, startMockApi, type MockApi } from '../mock-server.js';
import { sandbox } from './helpers.js';

const LEAK = 'whsec_SHOULD_NEVER_APPEAR';
const T = '/v1/tenants/{tenant_id}';

/** The fixture spec with richer examples: a fake project with two locations and a webhook. */
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
      { id: 1, tenant_id: 42, name: 'Depot', city: 'Oslo', address: null, metadata: {} },
      { id: 2, tenant_id: 42, name: 'Mall', metadata: { api_key: 'sk_SHOULD_NEVER_APPEAR' } },
    ],
    next_cursor: null,
  });
  set(`${T}/locations/{location_id}`, { id: 2, name: 'Mall', metadata: {} });
  set(`${T}/locations/{location_id}/default-tariff`, { scope: 'location', tariff_id: 7 });
  set(`${T}/default-tariff`, { scope: 'project', tariff_id: 7 });
  set(`${T}/tariffs`, {
    data: [{ id: 7, tenant_id: 42, currency: 'EUR', rate_minor_per_kwh: 30, archived: false }],
    next_cursor: null,
  });
  set(`${T}/stations`, {
    data: [
      {
        id: 100,
        name: 'Bay 1',
        charger_id: 'CP-1',
        location_id: 1,
        username: 'CP-1',
        evses: [{ evse_number: 1, physical_reference: null }],
        connectors: [{ id: 9, evse_number: 1, type: 'IEC_62196_T2', tariff_id: 7, status: 'x' }],
      },
      { id: 101, name: 'Bay 2', charger_id: 'CP-2', location_id: 2, evses: [], connectors: [] },
    ],
    next_cursor: null,
  });
  set(`${T}/stations/{station_id}/displays`, {
    data: [
      { id: 'd1', station_id: 100, evse_number: 1, qr: 'https://x.example', show_price: true },
      { id: 'd2', station_id: 100, evse_number: 2, qr: 'x', deleted: true },
    ],
  });
  set(`${T}/webhooks`, {
    data: [
      {
        id: 'wh_1',
        url: 'https://hooks.example/x',
        events: ['bill.finalized'],
        status: 'active',
        secret: LEAK,
      },
    ],
  });
  set(`${T}/ocpi`, {
    tenant_id: 42,
    publish: true,
    private: false,
    published: true,
    own_party: null,
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

describe('ivora export', () => {
  it('writes the project as ivora.yaml with read-only GETs and no secret values', async () => {
    const s = await sandbox(api);
    const file = join(s.dir, 'ivora.yaml');
    const before = api.requests.length;
    assert.equal(await s.go(['export', '-o', file]), ExitCode.Ok);
    const text = await readFile(file, 'utf8');
    assert.ok(!text.includes(LEAK) && !text.includes('sk_SHOULD_NEVER_APPEAR'));
    const doc = parse(text);
    assert.equal(doc.version, 1);
    assert.deepEqual(doc.project, { default_tariff: 7 });
    assert.equal(doc.locations[0].name, 'Depot');
    assert.equal(doc.locations[0].address, undefined, 'nulls are dropped');
    assert.equal(doc.locations[0].default_tariff, 7);
    assert.match(doc.locations[1].metadata.api_key.secret_ref, /^env:[A-Z0-9_]+$/);
    assert.equal(doc.tariffs[0].currency, 'EUR');
    assert.equal(doc.tariffs[0].archived, undefined);
    assert.equal(doc.stations[0].charger_id, 'CP-1');
    assert.equal(doc.stations[0].connectors, 1);
    assert.equal(doc.stations[0].password.secret_ref, 'env:IVORA_STATION_CP_1_PASSWORD');
    assert.equal(doc.stations[0].evses[0].connectors[0].tariff, 7);
    assert.equal(doc.stations[1].password, undefined);
    assert.ok(doc.displays.length > 0);
    assert.ok(
      doc.displays.every((d: { evse_number: number }) => d.evse_number === 1),
      'deleted displays are left out',
    );
    assert.equal(doc.webhooks[0].secret.secret_ref, 'env:IVORA_WEBHOOK_WH_1_SECRET');
    assert.equal(doc.ocpi_publishing.publish, true);
    assert.match(doc.roaming_partners.skipped, /signed-in admin/);
    assert.match(doc.apps.skipped, /signed-in admin/);
    assert.match(s.err.text, /skipped roaming_partners: needs a signed-in admin/);
    const seen = api.requests.slice(before);
    assert.ok(seen.length > 5);
    assert.ok(
      seen.every((r) => r.method === 'GET'),
      'only GET requests',
    );
    assert.ok(seen.every((r) => !r.path.startsWith('/v1/admin')));
    await s.cleanup();
  });

  it('exports one location with its stations only', async () => {
    const s = await sandbox(api);
    assert.equal(await s.go(['export', '--location', '2', '-o', '-']), ExitCode.Ok);
    const doc = parse(s.out.text);
    assert.equal(doc.locations.length, 1);
    assert.deepEqual(
      doc.stations.map((x: { charger_id: string }) => x.charger_id),
      ['CP-2'],
      'only the stations of that location',
    );
    assert.equal(doc.project, undefined);
    assert.equal(doc.webhooks, undefined);
    await s.cleanup();
  });

  it('skips a section the key cannot read and refuses to overwrite without --force', async () => {
    const s = await sandbox(api);
    const file = join(s.dir, 'ivora.yaml');
    api.enqueue('GET', '/v1/tenants/42/ocpi', {
      status: 403,
      body: { error: { code: 'forbidden', message: 'no' } },
    });
    assert.equal(await s.go(['export', '-o', file]), ExitCode.Ok);
    const doc = parse(await readFile(file, 'utf8'));
    assert.match(doc.ocpi_publishing.skipped, /403/);
    assert.match(s.err.text, /skipped ocpi_publishing/);
    assert.equal(await s.go(['export', '-o', file]), ExitCode.Usage);
    await writeFile(file, 'old');
    assert.equal(await s.go(['export', '-o', file, '--force']), ExitCode.Ok);
    assert.match(await readFile(file, 'utf8'), /^# ivora.yaml/);
    await s.cleanup();
  });

  it('rejects --project with --location', async () => {
    const s = await sandbox(api);
    assert.equal(await s.go(['export', '--project', '--location', '1']), ExitCode.Usage);
    await s.cleanup();
  });
});

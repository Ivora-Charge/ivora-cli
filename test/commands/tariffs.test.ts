import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ExitCode } from '../../src/lib/output.js';
import { startMockApi, type MockApi } from '../mock-server.js';
import { calls, sandbox } from './helpers.js';

let api: MockApi;
before(async () => {
  api = await startMockApi();
});
after(async () => {
  await api.close();
});

const SESSION = { start_at: '2026-10-15T17:30:00-07:00', duration_minutes: 30, energy_kwh: 12 };

describe('ivora tariffs', () => {
  it('lists and gets tariffs', async () => {
    const s = await sandbox(api);
    assert.equal(await s.go(['tariffs', 'list', '--include-archived']), ExitCode.Ok);
    assert.match(s.out.text, /Fixture tariff\s+EUR/);
    assert.equal(calls(api).at(-1)?.query.get('include_archived'), 'true');
    assert.equal(await s.go(['tariffs', 'get', '7', '--json']), ExitCode.Ok);
    assert.equal(calls(api).at(-1)?.path, '/v1/tenants/42/tariffs/7');
    await s.cleanup();
  });

  it('quotes a session from stdin with no Idempotency-Key', async () => {
    const s = await sandbox(api, JSON.stringify(SESSION));
    assert.equal(
      await s.go(['tariffs', 'quote', '7', '--session', '-', '--location-id', '3', '--json']),
      ExitCode.Ok,
    );
    assert.equal((JSON.parse(s.out.text) as { total: string }).total, '4.20');
    const req = calls(api).at(-1);
    assert.equal(req?.method, 'POST');
    assert.equal(req?.path, '/v1/tenants/42/tariffs/7/quote');
    assert.deepEqual(req?.body, { session: SESSION, location_id: 3 });
    assert.equal(req?.headers['idempotency-key'], undefined);
    await s.cleanup();
  });

  it('simulates a draft tariff from files', async () => {
    const s = await sandbox(api);
    const tariff = join(s.dir, 'tariff.json');
    const session = join(s.dir, 'session.json');
    await writeFile(tariff, JSON.stringify({ currency: 'EUR' }));
    await writeFile(session, JSON.stringify(SESSION));
    assert.equal(
      await s.go(['tariffs', 'simulate', '--tariff', tariff, '--session', session]),
      ExitCode.Ok,
    );
    const req = calls(api).at(-1);
    assert.equal(req?.path, '/v1/tenants/42/tariffs/simulate');
    assert.deepEqual(req?.body, { tariff: { currency: 'EUR' }, session: SESSION });
    assert.equal(req?.headers['idempotency-key'], undefined);
    await s.cleanup();
  });

  it('rejects bad input without calling the API', async () => {
    const s = await sandbox(api, 'not json');
    const before = api.requests.length;
    assert.equal(await s.go(['tariffs', 'quote', '7', '--session', '-']), ExitCode.Usage);
    assert.equal(
      await s.go(['tariffs', 'simulate', '--tariff', '-', '--session', '-']),
      ExitCode.Usage,
    );
    assert.equal(await s.go(['tariffs', 'quote', '7']), ExitCode.Usage);
    assert.equal(api.requests.length, before);
    await s.cleanup();
  });
});

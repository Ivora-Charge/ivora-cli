import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { COMMANDS, getOperationIds } from '../../src/catalog.js';
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

describe('ivora api', () => {
  it('lists the GET operationIds when called without one', async () => {
    const s = await sandbox(api);
    assert.equal(await s.go(['api']), ExitCode.Ok);
    assert.match(s.out.text, /locations_list_tenant_locations/);
    assert.doesNotMatch(s.out.text, /register_a_station/);
    await s.cleanup();
  });

  it('calls a GET operation by id with path and query params', async () => {
    const s = await sandbox(api);
    assert.equal(
      await s.go([
        'api',
        'locations_read_one_location',
        '--path',
        'location_id=1',
        '--query',
        'x=y',
      ]),
      ExitCode.Ok,
    );
    assert.equal((JSON.parse(s.out.text) as { id: number }).id, 1);
    const req = calls(api).at(-1);
    assert.equal(req?.path, '/v1/tenants/42/locations/1');
    assert.equal(req?.query.get('x'), 'y');
    await s.cleanup();
  });

  it('prints JSON for list responses and exits 2 on a missing path param', async () => {
    const s = await sandbox(api);
    assert.equal(await s.go(['api', 'locations_list_tenant_locations']), ExitCode.Ok);
    assert.ok(Array.isArray((JSON.parse(s.out.text) as { data: unknown[] }).data));
    assert.equal(await s.go(['api', 'locations_read_one_location']), ExitCode.Usage);
    await s.cleanup();
  });

  it('refuses non-GET and unknown operations without sending anything', async () => {
    const s = await sandbox(api);
    const before = api.requests.length;
    const posts = COMMANDS.filter((c) => c.method !== 'GET' && c.operationId);
    assert.ok(posts.length > 0);
    for (const c of posts) {
      assert.equal(await s.go(['api', c.operationId as string]), ExitCode.Usage, c.operationId);
    }
    assert.match(s.err.text, /only calls GET/);
    assert.equal(await s.go(['api', 'no_such_operation']), ExitCode.Usage);
    assert.equal(api.requests.length, before);
    assert.ok(
      getOperationIds().every((id) => COMMANDS.find((c) => c.operationId === id)?.method === 'GET'),
    );
    await s.cleanup();
  });

  it('never reaches a staff path or a raw path', async () => {
    const s = await sandbox(api);
    assert.equal(await s.go(['api', '/v1/admin/example']), ExitCode.Usage);
    assert.equal(
      await s.go(['api', 'locations_read_one_location', '--path', 'location_id=1/../../x']),
      ExitCode.Usage,
    );
    await s.cleanup();
  });
});

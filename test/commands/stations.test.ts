import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ExitCode } from '../../src/lib/output.js';
import { startMockApi, type MockApi } from '../mock-server.js';
import { calls, sandbox, TEST_KEY } from './helpers.js';

let api: MockApi;
before(async () => {
  api = await startMockApi();
});
after(async () => {
  await api.close();
});

describe('ivora stations', () => {
  it('lists stations as a table, using the key’s tenant', async () => {
    const s = await sandbox(api);
    assert.equal(await s.go(['stations', 'list']), ExitCode.Ok);
    assert.match(s.out.text, /^ID\s+NAME\s+CHARGER_ID\s+ONLINE\s+LAST_SEEN/);
    assert.match(s.out.text, /st_fixture_1\s+FIXTURE-001\s+true/);
    const last = calls(api).at(-1);
    assert.equal(last?.method, 'GET');
    assert.equal(last?.path, '/v1/tenants/42/stations');
    assert.equal(last?.headers.authorization, `Bearer ${TEST_KEY}`);
    assert.doesNotMatch(s.out.text + s.err.text, /fakekey1234567890/);
    await s.cleanup();
  });

  it('prints JSON and passes filters and paging', async () => {
    const s = await sandbox(api);
    assert.equal(
      await s.go(['stations', 'list', '--json', '--tenant', '9', '--limit', '5', '--name', 'a b']),
      ExitCode.Ok,
    );
    const body = JSON.parse(s.out.text) as { data: unknown[]; next_cursor: unknown };
    assert.equal(body.data.length, 1);
    assert.equal(body.next_cursor, null);
    const last = calls(api).at(-1);
    assert.equal(last?.path, '/v1/tenants/9/stations');
    assert.equal(last?.query.get('limit'), '5');
    assert.equal(last?.query.get('name'), 'a b');
    await s.cleanup();
  });

  it('follows next_cursor with --all and hints at the next page otherwise', async () => {
    const s = await sandbox(api);
    const page = (id: string, next: number | null) => ({
      status: 200,
      body: { data: [{ id, charger_id: id }], next_cursor: next },
    });
    api.enqueue('GET', '/v1/tenants/42/stations', page('a', 10));
    api.enqueue('GET', '/v1/tenants/42/stations', page('b', null));
    assert.equal(await s.go(['stations', 'list', '--all', '--json']), ExitCode.Ok);
    assert.deepEqual(
      (JSON.parse(s.out.text) as { data: { id: string }[] }).data.map((r) => r.id),
      ['a', 'b'],
    );
    assert.equal(calls(api).at(-1)?.query.get('after'), '10');

    const t = await sandbox(api);
    api.enqueue('GET', '/v1/tenants/42/stations', page('c', 20));
    assert.equal(await t.go(['stations', 'list']), ExitCode.Ok);
    assert.match(t.err.text, /--after 20/);
    await s.cleanup();
    await t.cleanup();
  });

  it('ends when the last page echoes the cursor sent, or comes back empty or short', async () => {
    const page = (ids: string[], next: number | null) => ({
      status: 200,
      body: { data: ids.map((id) => ({ id, charger_id: id })), next_cursor: next },
    });
    type Out = { data: { id: string }[]; next_cursor: unknown };

    // --all: the last page returns next_cursor = the cursor that was sent.
    const s = await sandbox(api);
    api.enqueue('GET', '/v1/tenants/42/stations', page(['a'], 10));
    api.enqueue('GET', '/v1/tenants/42/stations', page(['b'], 10));
    const before = calls(api).length;
    assert.equal(await s.go(['stations', 'list', '--all', '--json']), ExitCode.Ok);
    const all = JSON.parse(s.out.text) as Out;
    assert.deepEqual(
      all.data.map((r) => r.id),
      ['a', 'b'],
    );
    assert.equal(all.next_cursor, null);
    assert.equal(calls(api).length - before, 2);

    // One page, continuing from --after 10: the echoed cursor means no hint and a null cursor.
    const t = await sandbox(api);
    api.enqueue('GET', '/v1/tenants/42/stations', page(['b'], 10));
    assert.equal(await t.go(['stations', 'list', '--after', '10']), ExitCode.Ok);
    assert.doesNotMatch(t.err.text, /More results/);
    api.enqueue('GET', '/v1/tenants/42/stations', page(['b'], 10));
    assert.equal(await t.go(['stations', 'list', '--after', '10', '--json']), ExitCode.Ok);
    assert.equal((JSON.parse(t.out.text.slice(t.out.text.indexOf('{'))) as Out).next_cursor, null);

    // An empty page, then a page shorter than --limit, both end the listing.
    const u = await sandbox(api);
    api.enqueue('GET', '/v1/tenants/42/stations', page([], 11));
    assert.equal(await u.go(['stations', 'list', '--after', '10']), ExitCode.Ok);
    assert.doesNotMatch(u.err.text, /More results/);
    api.enqueue('GET', '/v1/tenants/42/stations', page(['a'], 12));
    assert.equal(await u.go(['stations', 'list', '--limit', '5']), ExitCode.Ok);
    assert.doesNotMatch(u.err.text, /More results/);

    // A full page keeps the API's integer cursor in JSON.
    const v = await sandbox(api);
    api.enqueue('GET', '/v1/tenants/42/stations', page(['a', 'b'], 12));
    assert.equal(await v.go(['stations', 'list', '--limit', '2', '--json']), ExitCode.Ok);
    assert.equal((JSON.parse(v.out.text) as Out).next_cursor, 12);

    for (const x of [s, t, u, v]) await x.cleanup();
  });

  it('gets one station and encodes the id', async () => {
    const s = await sandbox(api);
    assert.equal(await s.go(['stations', 'get', 'st_fixture_1']), ExitCode.Ok);
    assert.match(s.out.text, /charger_id\s+FIXTURE-001/);
    assert.equal(calls(api).at(-1)?.path, '/v1/tenants/42/stations/st_fixture_1');
    assert.equal(await s.go(['stations', 'get', '../x']), ExitCode.Usage);
    await s.cleanup();
  });

  it('shows the API error code and request id, and exits 1', async () => {
    const s = await sandbox(api);
    api.enqueue('GET', '/v1/tenants/42/stations/nope', {
      status: 404,
      body: { error: { code: 'not_found', message: 'No such station.' }, request_id: 'req_abc123' },
    });
    assert.equal(await s.go(['stations', 'get', 'nope']), ExitCode.ApiError);
    assert.match(s.err.text, /not_found/);
    assert.match(s.err.text, /req_abc123/);
    await s.cleanup();
  });

  it('exits 5 on an auth error and 2 when the tenant is ambiguous', async () => {
    const s = await sandbox(api);
    api.enqueue('GET', '/v1/tenants/42/stations', {
      status: 401,
      body: { error: { code: 'unauthenticated', message: 'bad key' }, request_id: 'req_1' },
    });
    assert.equal(await s.go(['stations', 'list']), ExitCode.Auth);
    api.enqueue('GET', '/v1/access', {
      status: 200,
      body: { environment: 'test', tenants: [{ id: 1 }, { id: 2 }], scopes: [] },
    });
    assert.equal(await s.go(['stations', 'list']), ExitCode.Usage);
    assert.match(s.err.text, /--tenant/);
    await s.cleanup();
  });
});

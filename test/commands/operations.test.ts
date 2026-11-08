import assert from 'node:assert/strict';
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

describe('ivora operations', () => {
  it('lists operations with filters and the before cursor', async () => {
    const s = await sandbox(api);
    api.enqueue('GET', '/v1/tenants/42/operations', {
      status: 200,
      body: { data: [{ id: 'op_1', kind: 'reset', status: 'failed' }], next_cursor: 'op_0' },
    });
    assert.equal(
      await s.go([
        'operations',
        'list',
        '--status',
        'failed',
        '--station-id',
        'st_1',
        '--before',
        'op_9',
      ]),
      ExitCode.Ok,
    );
    assert.match(s.out.text, /op_1\s+reset\s+failed/);
    assert.match(s.err.text, /--before op_0/);
    const q = calls(api).at(-1)?.query;
    assert.equal(q?.get('status'), 'failed');
    assert.equal(q?.get('station_id'), 'st_1');
    assert.equal(q?.get('before'), 'op_9');
    await s.cleanup();
  });

  it('gets one operation as JSON, with GET only', async () => {
    const s = await sandbox(api);
    assert.equal(await s.go(['--json', 'operations', 'get', 'op_fixture_1']), ExitCode.Ok);
    assert.equal((JSON.parse(s.out.text) as { id: string }).id, 'op_fixture_1');
    assert.ok(calls(api).every((r) => r.method === 'GET'));
    await s.cleanup();
  });
});

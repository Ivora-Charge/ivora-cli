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

describe('ivora webhooks', () => {
  it('lists and gets webhook endpoints', async () => {
    const s = await sandbox(api);
    assert.equal(await s.go(['webhooks', 'list']), ExitCode.Ok);
    assert.match(s.out.text, /^ID\s+URL\s+STATUS\s+EVENTS/);
    assert.match(s.out.text, /https:\/\/example\.com\/hook/);
    assert.equal(calls(api).at(-1)?.path, '/v1/tenants/42/webhooks');
    s.out.text = '';
    assert.equal(await s.go(['webhooks', 'get', '3', '--json']), ExitCode.Ok);
    assert.equal((JSON.parse(s.out.text) as { id: number }).id, 3);
    assert.equal(calls(api).at(-1)?.path, '/v1/tenants/42/webhooks/3');
    await s.cleanup();
  });

  it('has no write subcommands', async () => {
    const s = await sandbox(api);
    for (const sub of ['create', 'delete', 'test']) {
      assert.equal(await s.go(['webhooks', sub]), ExitCode.Usage);
    }
    await s.cleanup();
  });
});

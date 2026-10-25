import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  ApiClient,
  ApiError,
  assertPublicPath,
  parseRetryAfter,
  validateIdempotencyKey,
} from '../src/lib/http.js';
import { ExitCode } from '../src/lib/output.js';
import { startMockApi, type MockApi } from './mock-server.js';

const TEST_KEY = 'iv_test_fixturekey0001';

describe('ApiClient against the mock /v1', () => {
  let api: MockApi;
  const debugLines: string[] = [];
  const client = (): ApiClient =>
    new ApiClient({
      baseUrl: api.url,
      apiKey: TEST_KEY,
      apiVersion: '2026-10-15',
      sleep: async () => undefined,
      debug: (line) => debugLines.push(line),
    });

  before(async () => {
    api = await startMockApi();
  });
  after(async () => {
    await api.close();
  });

  it('sends the bearer key, Ivora-Version and no Idempotency-Key on reads', async () => {
    const res = await client().request<{ environment: string }>('GET', '/v1/access');
    assert.equal(res.status, 200);
    assert.equal(res.data.environment, 'test');
    const req = api.requests.at(-1)!;
    assert.equal(req.headers.authorization, `Bearer ${TEST_KEY}`);
    assert.equal(req.headers['ivora-version'], '2026-10-15');
    assert.equal(req.headers['idempotency-key'], undefined);
    assert.match(String(req.headers['user-agent']), /^ivora-cli\//);
  });

  it('adds a UUID Idempotency-Key and a JSON body on writes', async () => {
    const res = await client().request('POST', '/v1/tenants/ten_fixture/stations', {
      body: { charger_id: 'FIXTURE-002' },
    });
    assert.equal(res.status, 201);
    const req = api.requests.at(-1)!;
    assert.match(String(req.headers['idempotency-key']), /^[0-9a-f-]{36}$/);
    assert.equal(res.idempotencyKey, req.headers['idempotency-key']);
    assert.deepEqual(req.body, { charger_id: 'FIXTURE-002' });
  });

  it('retries 429 after Retry-After', async () => {
    api.enqueue('GET', '/v1/capabilities', {
      status: 429,
      headers: { 'retry-after': '1' },
      body: { error: { code: 'rate_limited' } },
    });
    const before = api.requests.length;
    const res = await client().request('GET', '/v1/capabilities');
    assert.equal(res.status, 200);
    assert.equal(api.requests.length - before, 2);
  });

  it('replays a write after 503 outcome_unknown with the same Idempotency-Key', async () => {
    const path = '/v1/tenants/ten_fixture/stations';
    api.enqueue('POST', path, { status: 503, body: { error: { code: 'outcome_unknown' } } });
    const start = api.requests.length;
    await client().request('POST', path, { body: {}, idempotencyKey: 'fixed-key-123' });
    const sent = api.requests.slice(start);
    assert.equal(sent.length, 2);
    assert.deepEqual(
      sent.map((r) => r.headers['idempotency-key']),
      ['fixed-key-123', 'fixed-key-123'],
    );
  });

  it('maps errors to ApiError with exit codes', async () => {
    api.enqueue('GET', '/v1/tenants/ten_fixture/stations/st_x', {
      status: 404,
      body: { error: { code: 'station_not_found', message: 'No such station.' } },
    });
    await assert.rejects(
      client().request('GET', '/v1/tenants/ten_fixture/stations/st_x'),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 404);
        assert.equal(err.code, 'station_not_found');
        assert.equal(err.exitCode, ExitCode.ApiError);
        assert.match(err.message, /No such station/);
        return true;
      },
    );
    const bad = new ApiClient({ baseUrl: api.url, apiKey: 'not-a-key', apiVersion: '2026-10-15' });
    await assert.rejects(
      bad.request('GET', '/v1/access'),
      (err: unknown) => err instanceof ApiError && err.exitCode === ExitCode.Auth,
    );
  });

  it('never writes the key to debug output', () => {
    assert.ok(debugLines.length > 0);
    for (const line of debugLines) assert.ok(!line.includes(TEST_KEY), line);
  });

  it('times out with exit code 4', async () => {
    const hanging = new ApiClient({
      baseUrl: api.url,
      apiKey: TEST_KEY,
      apiVersion: '2026-10-15',
      maxRetries: 0,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        }),
      timeoutMs: 20,
    });
    await assert.rejects(
      hanging.request('GET', '/v1/access'),
      (err: unknown) => (err as ApiError).exitCode === ExitCode.Timeout,
    );
  });
});

describe('request guards', () => {
  it('refuses staff and non-/v1 paths', () => {
    for (const path of [
      '/v1/admin',
      '/v1/admin/x',
      '/v1/ADMIN/x',
      '/v1/host/a',
      '/v1/internal/b',
      '/openapi.json',
      'https://evil.example/v1/x',
      '/v1/../admin',
    ]) {
      assert.throws(() => assertPublicPath(path), path);
    }
    for (const path of [
      '/v1/access',
      '/v1/tenants/t/stations',
      '/v1/administrators-are-not-a-prefix',
    ]) {
      assert.doesNotThrow(() => assertPublicPath(path), path);
    }
  });

  it('validates idempotency keys', () => {
    assert.equal(validateIdempotencyKey('abcdefgh'), 'abcdefgh');
    assert.throws(() => validateIdempotencyKey('short'));
    assert.throws(() => validateIdempotencyKey('has space in it'));
    assert.throws(() => validateIdempotencyKey('x'.repeat(129)));
  });

  it('parses Retry-After seconds and dates, capped', () => {
    assert.equal(parseRetryAfter('5'), 5);
    assert.equal(parseRetryAfter('9999'), 60);
    assert.equal(parseRetryAfter(null), 1);
    const now = Date.parse('2026-01-01T00:00:00Z');
    assert.equal(parseRetryAfter('Thu, 01 Jan 2026 00:00:10 GMT', now), 10);
  });

  it('refuses staff paths in encoded forms', () => {
    for (const p of [
      '/v1/admin',
      '/v1//admin',
      '/v1/%61dmin',
      '/v1/%2e%2e/v1/admin',
      '/v1/x/%2E%2E/admin',
      '/v1/x\\..\\admin',
      '/v1/admin#',
      '/v1/admin;x',
      '/v1/admin%2fx',
    ]) {
      assert.throws(() => assertPublicPath(p), p);
    }
    assert.doesNotThrow(() => assertPublicPath('/v1/tenants/ten_1/stations?limit=5'));
  });

  it('refuses a non-https base URL before sending the key', () => {
    assert.throws(
      () => new ApiClient({ baseUrl: 'http://api.example.com', apiKey: TEST_KEY, apiVersion: 'v' }),
    );
  });
});

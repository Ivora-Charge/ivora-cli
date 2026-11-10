import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, it } from 'node:test';
import { run, type RunIo } from '../src/cli.js';
import { ApiClient } from '../src/lib/http.js';
import { ExitCode } from '../src/lib/output.js';
import {
  challengeFor,
  createPkce,
  fetchOAuthMetadata,
  oauthRefs,
  startLoopbackListener,
} from '../src/lib/oauth.js';
import {
  KeychainSecretStore,
  MemorySecretStore,
  UnavailableSecretStore,
  type Exec,
} from '../src/lib/secrets.js';

// Fake values only. The server below is a local stand-in; no real API is contacted.
const KEY = 'iv_test_fakekey1234567890';

interface Seen {
  method: string;
  path: string;
  auth?: string;
  form?: URLSearchParams;
}

interface AsOptions {
  metadata?: Record<string, unknown> | null;
  /** Merged into the default metadata document. */
  patch?: Record<string, unknown>;
  revokeStatus?: number;
}

/** A local authorization server and /v1 stub on 127.0.0.1. */
async function startAs(options: AsOptions = {}) {
  const seen: Seen[] = [];
  const valid = new Set<string>();
  let counter = 0;
  let refreshValid = true;
  const metadata = (base: string): Record<string, unknown> | null =>
    options.metadata === undefined
      ? {
          issuer: base,
          authorization_endpoint: `${base}/oauth/authorize`,
          token_endpoint: `${base}/oauth/token`,
          revocation_endpoint: `${base}/oauth/revoke`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          ivora_cli: {
            client_id: 'ivora-cli',
            token_endpoint_auth_method: 'none',
            redirect_uri_template: 'http://127.0.0.1:{port}/callback',
          },
          resource: `${base}/v1`,
          ...options.patch,
        }
      : options.metadata;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const url = new URL(req.url ?? '/', base);
      const text = Buffer.concat(chunks).toString('utf8');
      const form =
        text && req.headers['content-type']?.includes('urlencoded')
          ? new URLSearchParams(text)
          : undefined;
      seen.push({
        method: req.method ?? '',
        path: url.pathname,
        ...(req.headers.authorization ? { auth: req.headers.authorization } : {}),
        ...(form ? { form } : {}),
      });
      const json = (status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        const m = metadata(base);
        return m ? json(200, m) : json(404, { error: 'not_found' });
      }
      if (url.pathname === '/oauth/token') {
        const grant = form?.get('grant_type');
        if (grant === 'refresh_token' && !refreshValid)
          return json(400, { error: 'invalid_grant' });
        counter += 1;
        const access = `at.${counter}.fake-access-token`;
        valid.add(access);
        return json(200, {
          access_token: access,
          refresh_token: `rt.${counter}.fake-refresh-token`,
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'stations:read',
        });
      }
      if (url.pathname === '/oauth/revoke') {
        return json(options.revokeStatus ?? 200, {});
      }
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      if (!token || !valid.has(token)) return json(401, { error: { code: 'unauthorized' } });
      if (url.pathname === '/v1/access') {
        return json(200, {
          environment: 'test',
          tenants: [{ id: 42 }],
          scopes: ['stations:read'],
        });
      }
      if (url.pathname === '/v1/capabilities') return json(200, {});
      if (url.pathname.startsWith('/v1/imports')) {
        return json(403, { error: { code: 'forbidden', message: 'Not allowed.' } });
      }
      return json(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    valid,
    invalidateAccess: () => valid.clear(),
    breakRefresh: () => {
      refreshValid = false;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

type As = Awaited<ReturnType<typeof startAs>>;

function capture() {
  return {
    text: '',
    write(s: string) {
      this.text += s;
    },
  };
}

interface BrowserOptions {
  /** One callback per entry, in order; each maps the real state to the one sent. */
  states?: ((state: string) => string)[];
  /** Sent as the RFC 9207 `iss` parameter. */
  iss?: string;
  /** The code for each callback, by index; defaults to 'fake-auth-code'. */
  codes?: string[];
}

/** Plays the browser: fetches the redirect URI with a code and the given state(s). */
function browser(options: BrowserOptions = {}) {
  const opened: string[] = [];
  const statuses: number[] = [];
  const openUrl = async (url: string): Promise<void> => {
    opened.push(url);
    const u = new URL(url);
    const state = u.searchParams.get('state') ?? '';
    for (const [i, mutate] of (options.states ?? [(x: string) => x]).entries()) {
      const redirect = new URL(u.searchParams.get('redirect_uri') ?? '');
      redirect.searchParams.set('code', options.codes?.[i] ?? 'fake-auth-code');
      redirect.searchParams.set('state', mutate(state));
      if (options.iss !== undefined) redirect.searchParams.set('iss', options.iss);
      statuses.push(await get(redirect.href).catch(() => 0));
    }
  };
  return { opened, statuses, openUrl };
}

let dirs: string[] = [];
let as: As | undefined;
afterEach(async () => {
  await as?.close();
  as = undefined;
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

async function sandbox(server: As, io: Partial<RunIo> = {}, extraEnv: NodeJS.ProcessEnv = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ivora-cli-oauth-'));
  dirs.push(dir);
  const secrets = new MemorySecretStore();
  const stdout = capture();
  const stderr = capture();
  const env = { XDG_CONFIG_HOME: dir, IVORA_API_BASE: server.url, ...extraEnv };
  const go = (argv: string[], stdin = '', more: Partial<RunIo> = {}) =>
    run(argv, {
      stdout,
      stderr,
      env,
      secrets,
      stdin: Readable.from([stdin]),
      prompter: { interactive: false, ask: async () => '' },
      ...io,
      ...more,
    });
  return { dir, secrets, stdout, stderr, go };
}

describe('PKCE', () => {
  it('matches the RFC 7636 S256 test vector', () => {
    assert.equal(
      challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('creates a 43-character URL-safe verifier whose challenge is its S256 hash', () => {
    const a = createPkce();
    const b = createPkce();
    assert.match(a.verifier, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(a.challenge, challengeFor(a.verifier));
    assert.notEqual(a.verifier, b.verifier);
  });
});

// Short timeouts everywhere: a broken check must fail the test, not hang CI.
const QUICK = { timeout: 10_000 };

describe('loopback listener', QUICK, () => {
  it('binds 127.0.0.1 only, on a random port', async () => {
    const l = await startLoopbackListener('s', { timeoutMs: 2000 });
    try {
      assert.equal(l.address, '127.0.0.1'); // not 0.0.0.0 or ::, which would reach the LAN
      assert.equal(l.redirectUri, `http://127.0.0.1:${l.port}/callback`);
      assert.equal(await probe('127.0.0.1', l.port), true);
      assert.equal(await probe('::1', l.port), false);
    } finally {
      await l.close();
    }
  });

  it('refuses a wrong state, keeps waiting, and times out without a code', async () => {
    const l = await startLoopbackListener('right-state', { timeoutMs: 300 });
    try {
      const waiting = l.waitForCode();
      assert.equal(await get(`${l.redirectUri}?code=abc&state=wrong-state`), 400);
      await assert.rejects(waiting, (err: { exitCode: number; message: string }) => {
        assert.equal(err.exitCode, ExitCode.Timeout);
        assert.match(err.message, /1 callback\(s\) with a wrong or missing state were refused/);
        assert.doesNotMatch(err.message, /abc/);
        return true;
      });
    } finally {
      await l.close();
    }
  });

  it('refuses a missing state', async () => {
    const l = await startLoopbackListener('right-state', { timeoutMs: 300 });
    try {
      const waiting = l.waitForCode();
      assert.equal(await get(`${l.redirectUri}?code=abc`), 400);
      await assert.rejects(waiting, { exitCode: ExitCode.Timeout });
    } finally {
      await l.close();
    }
  });

  it('refuses a bad Host header', async () => {
    const l = await startLoopbackListener('right-state', { timeoutMs: 300 });
    try {
      const waiting = l.waitForCode();
      const path = '/callback?code=abc&state=right-state';
      assert.equal(await get(`http://127.0.0.1:${l.port}${path}`, 'localhost'), 400);
      assert.equal(await get(`http://127.0.0.1:${l.port}${path}`, 'evil.example'), 400);
      await assert.rejects(waiting, { exitCode: ExitCode.Timeout });
    } finally {
      await l.close();
    }
  });

  it('ignores bad callbacks and still accepts the good one that follows', async () => {
    const l = await startLoopbackListener('right-state', { timeoutMs: 2000 });
    try {
      const waiting = l.waitForCode();
      assert.equal(await get(`http://127.0.0.1:${l.port}/other?code=x&state=right-state`), 404);
      assert.equal(await get(`${l.redirectUri}?code=bad&state=wrong`), 400);
      assert.equal(await get(`${l.redirectUri}?code=bad`), 400);
      assert.equal(await get(`${l.redirectUri}?code=abc&state=right-state`), 200);
      assert.equal(await waiting, 'abc');
    } finally {
      await l.close();
    }
  });

  it('keeps the first good code; a second good callback cannot replace it', async () => {
    const l = await startLoopbackListener('right-state', { timeoutMs: 2000 });
    try {
      const waiting = l.waitForCode();
      assert.equal(await get(`${l.redirectUri}?code=first&state=right-state`), 200);
      await get(`${l.redirectUri}?code=second&state=right-state`).catch(() => 0);
      // Let any deferred settle run before checking which code won.
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(await waiting, 'first');
    } finally {
      await l.close();
    }
  });

  it('checks iss when the server sends it', async () => {
    const l = await startLoopbackListener('st', { timeoutMs: 2000, issuer: 'https://as.example' });
    try {
      const waiting = l.waitForCode();
      const expectation = assert.rejects(waiting, { exitCode: ExitCode.Auth });
      assert.equal(await get(`${l.redirectUri}?code=abc&state=st&iss=https://other.example`), 400);
      await expectation;
    } finally {
      await l.close();
    }
    const ok = await startLoopbackListener('st', { timeoutMs: 2000, issuer: 'https://as.example' });
    try {
      const waiting = ok.waitForCode();
      const iss = encodeURIComponent('https://as.example');
      assert.equal(await get(`${ok.redirectUri}?code=abc&state=st&iss=${iss}`), 200);
      assert.equal(await waiting, 'abc');
    } finally {
      await ok.close();
    }
  });
});

function get(url: string, host?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    httpRequest(url, { timeout: 2000, ...(host ? { headers: { host } } : {}) }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    })
      .on('error', reject)
      .end();
  });
}

function probe(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpRequest({ host, port, path: '/callback', timeout: 2000 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

/** A complete metadata document for a server at `base`, with `patch` applied. */
function doc(base: string, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    code_challenge_methods_supported: ['S256'],
    ivora_cli: { client_id: 'ivora-cli', token_endpoint_auth_method: 'none' },
    ...patch,
  };
}

/** Serves one metadata document and returns what fetchOAuthMetadata makes of it. */
async function metaFor(build: (base: string) => Record<string, unknown> | null) {
  const server = createServer((_req, res) => {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const m = build(base);
    res.writeHead(m ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(m ?? {}));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    return await fetchOAuthMetadata(base);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe('authorization-server metadata', QUICK, () => {
  it('reads the metadata the CLI needs', async () => {
    as = await startAs();
    const meta = await fetchOAuthMetadata(as.url);
    assert.equal(meta?.clientId, 'ivora-cli');
    assert.equal(meta?.tokenEndpoint, `${as.url}/oauth/token`);
    assert.equal(meta?.issuer, as.url);
  });

  it('is undefined without the document, without S256, or with a client secret method', async () => {
    assert.equal(await metaFor(() => null), undefined);
    assert.equal(
      await metaFor((b) => doc(b, { code_challenge_methods_supported: ['plain'] })),
      undefined,
    );
    assert.equal(
      await metaFor((b) =>
        doc(b, {
          ivora_cli: { client_id: 'ivora-cli', token_endpoint_auth_method: 'client_secret_basic' },
        }),
      ),
      undefined,
    );
  });

  it('requires the ivora_cli block, with a client id and (if given) S256', async () => {
    assert.notEqual(await metaFor((b) => doc(b)), undefined);
    assert.equal(await metaFor((b) => doc(b, { ivora_cli: undefined })), undefined);
    assert.equal(
      await metaFor((b) => doc(b, { ivora_cli: { token_endpoint_auth_method: 'none' } })),
      undefined,
    );
    assert.equal(
      await metaFor((b) =>
        doc(b, { ivora_cli: { client_id: 'ivora-cli', code_challenge_method: 'plain' } }),
      ),
      undefined,
    );
  });

  it('requires the issuer to be the API base origin', async () => {
    assert.equal(await metaFor((b) => doc(b, { issuer: undefined })), undefined);
    assert.equal(await metaFor((b) => doc(b, { issuer: 'https://elsewhere.example' })), undefined);
  });

  it('prefers ivora_cli.resource over a top-level resource, and notes iss support', async () => {
    const meta = await metaFor((b) =>
      doc(b, {
        resource: 'https://top.example/v1',
        authorization_response_iss_parameter_supported: true,
        ivora_cli: { client_id: 'ivora-cli', resource: 'https://cli.example/v1' },
      }),
    );
    assert.equal(meta?.resource, 'https://cli.example/v1');
    assert.equal(meta?.requireIss, true);
  });

  it('with an unsafe loopback template, treats OAuth as unavailable', async () => {
    assert.equal(
      await metaFor((b) =>
        doc(b, {
          ivora_cli: {
            client_id: 'ivora-cli',
            redirect_uri_template: 'http://[::1]:{port}/callback',
          },
        }),
      ),
      undefined,
    );
  });
});

describe('ivora login (browser)', QUICK, () => {
  it('runs the PKCE flow, stores tokens in the keychain only, and whoami shows OAuth', async () => {
    as = await startAs();
    const b = browser();
    const s = await sandbox(as, { openUrl: b.openUrl });
    assert.equal(await s.go(['login']), ExitCode.Ok);

    const authorize = new URL(b.opened[0] ?? '');
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(authorize.searchParams.get('client_id'), 'ivora-cli');
    assert.match(
      authorize.searchParams.get('redirect_uri') ?? '',
      /^http:\/\/127\.0\.0\.1:\d+\/callback$/,
    );
    const exchange = as.seen.find((r) => r.path === '/oauth/token')?.form;
    assert.equal(exchange?.get('grant_type'), 'authorization_code');
    assert.equal(
      challengeFor(exchange?.get('code_verifier') ?? ''),
      authorize.searchParams.get('code_challenge'),
    );

    const refs = oauthRefs('test');
    assert.match((await s.secrets.get(refs.access)) ?? '', /^at\./);
    assert.match((await s.secrets.get(refs.refresh)) ?? '', /^rt\./);

    // Nothing secret on disk, in stdout or in stderr.
    const files = await readdir(join(s.dir, 'ivora'));
    assert.deepEqual(files, ['config.toml']);
    const config = await readFile(join(s.dir, 'ivora', 'config.toml'), 'utf8');
    assert.match(config, /auth_type = "oauth"/);
    assert.doesNotMatch(config, /fake-(access|refresh)-token|fake-auth-code/);
    const output = s.stdout.text + s.stderr.text;
    assert.doesNotMatch(output, /fake-(access|refresh)-token|fake-auth-code/);
    assert.match(s.stderr.text, /oauth\/authorize/); // the URL is printed for when no browser opens

    s.stdout.text = '';
    assert.equal(await s.go(['--json', 'whoami']), ExitCode.Ok);
    const who = JSON.parse(s.stdout.text) as { auth: string; scopes: string[] };
    assert.equal(who.auth, 'oauth');
    assert.deepEqual(who.scopes, ['stations:read']);
  });

  it('refuses a state mismatch and saves nothing', async () => {
    as = await startAs();
    const b = browser({ states: [(state) => `${state}x`] });
    const s = await sandbox(as, { openUrl: b.openUrl, loginTimeoutMs: 300 });
    assert.equal(await s.go(['login']), ExitCode.Timeout);
    assert.deepEqual(b.statuses, [400]);
    assert.match(s.stderr.text, /wrong or missing state were refused/);
    assert.equal(
      as.seen.some((r) => r.path === '/oauth/token'),
      false,
    );
    assert.equal(await s.secrets.get(oauthRefs('test').access), undefined);
  });

  it('a bad callback does not end the sign-in; the real one still completes it', async () => {
    as = await startAs();
    const b = browser({ states: [() => 'forged', () => '', (state) => state] });
    const s = await sandbox(as, { openUrl: b.openUrl, loginTimeoutMs: 2000 });
    assert.equal(await s.go(['login']), ExitCode.Ok);
    assert.deepEqual(b.statuses, [400, 400, 200]);
    assert.equal(as.seen.filter((r) => r.path === '/oauth/token').length, 1);
  });

  it('exchanges only the first good code, once, when a second good callback follows', async () => {
    as = await startAs();
    const same = (state: string): string => state;
    const b = browser({ states: [same, same], codes: ['first', 'second'] });
    const s = await sandbox(as, { openUrl: b.openUrl, loginTimeoutMs: 2000 });
    assert.equal(await s.go(['login']), ExitCode.Ok);
    assert.equal(b.statuses[0], 200);
    const exchanges = as.seen.filter((r) => r.path === '/oauth/token');
    assert.equal(exchanges.length, 1);
    assert.equal(exchanges[0]?.form?.get('grant_type'), 'authorization_code');
    assert.equal(exchanges[0]?.form?.get('code'), 'first');
  });

  it('checks iss on the callback when the server advertises it', async () => {
    as = await startAs({ patch: { authorization_response_iss_parameter_supported: true } });
    const bad = browser({ iss: 'https://elsewhere.example' });
    const s = await sandbox(as, { openUrl: bad.openUrl, loginTimeoutMs: 2000 });
    assert.equal(await s.go(['login']), ExitCode.Auth);
    assert.match(s.stderr.text, /did not come from this environment/);
    assert.equal(
      as.seen.some((r) => r.path === '/oauth/token'),
      false,
    );
    const good = browser({ iss: as.url });
    assert.equal(await s.go(['login'], '', { openUrl: good.openUrl }), ExitCode.Ok);
  });

  it('without a keychain, refuses before opening the browser', async () => {
    as = await startAs();
    const s = await sandbox(as, {
      secrets: new UnavailableSecretStore(),
      openUrl: async () => assert.fail('the browser must not open'),
    });
    assert.equal(await s.go(['login']), ExitCode.Usage);
    assert.match(s.stderr.text, /No OS keychain is available/);
    assert.equal(
      as.seen.some((r) => r.path === '/oauth/token'),
      false,
    );
  });

  it('revokes the new tokens when the keychain cannot store them', async () => {
    as = await startAs();
    const secrets = new MemorySecretStore();
    const realSet = secrets.set.bind(secrets);
    secrets.set = async (ref, secret) => {
      if (ref.endsWith(':refresh')) throw new Error('keychain write failed');
      return realSet(ref, secret);
    };
    const b = browser();
    const s = await sandbox(as, { openUrl: b.openUrl, secrets });
    assert.notEqual(await s.go(['login']), ExitCode.Ok);
    const revokes = as.seen.filter((r) => r.path === '/oauth/revoke');
    assert.deepEqual(revokes.map((r) => r.form?.get('token_type_hint')).sort(), [
      'access_token',
      'refresh_token',
    ]);
    assert.equal(await secrets.get(oauthRefs('test').access), undefined);
    assert.doesNotMatch(s.stdout.text + s.stderr.text, /fake-(access|refresh)-token/);
  });

  it('keeps tokens out of argv, stdout, stderr and --debug logs', async () => {
    as = await startAs();
    const b = browser();
    const s = await sandbox(as, { openUrl: b.openUrl });
    assert.equal(await s.go(['login']), ExitCode.Ok);
    assert.equal(await s.go(['--debug', 'whoami']), ExitCode.Ok);
    const tokens = [
      await s.secrets.get(oauthRefs('test').access),
      await s.secrets.get(oauthRefs('test').refresh),
    ] as string[];
    const everything = s.stdout.text + s.stderr.text + b.opened.join('\n');
    for (const t of tokens) assert.equal(everything.includes(t), false);
    // The browser is opened with the URL only.
    assert.equal(b.opened.length, 1);
    assert.match(s.stderr.text, /"Authorization":"\[redacted\]"/);
  });

  it('puts tokens on stdin, never argv, for both keychains', async () => {
    const calls: { cmd: string; args: string[]; input?: string }[] = [];
    const exec: Exec = async (cmd, args, input) => {
      calls.push({ cmd, args, ...(input !== undefined ? { input } : {}) });
      return { code: 0, stdout: '' };
    };
    const token = 'at.12345.fake-access-token';
    for (const platform of ['linux', 'darwin'] as const) {
      await new KeychainSecretStore(platform, exec).set('oauth:test:access', token);
    }
    for (const c of calls) {
      assert.equal(c.args.join(' ').includes(token), false);
      assert.equal(c.input?.includes(token), true);
    }
  });

  it('keeps the live-profile rule: --live is explicit and must match the profile', async () => {
    as = await startAs();
    const b = browser();
    const s = await sandbox(as, { openUrl: b.openUrl });
    // The server says this sign-in is a test one, so `--live login` saves nothing.
    assert.equal(await s.go(['--live', 'login', '--base-url', as.url]), ExitCode.Usage);
    assert.equal(await s.secrets.get(oauthRefs('live').access), undefined);
    assert.equal(await s.go(['login']), ExitCode.Ok);
    assert.equal(await s.go(['--live', 'logout']), ExitCode.Usage);
    assert.equal((await s.secrets.get(oauthRefs('test').access)) !== undefined, true);
  });
});

describe('fallback and --with-key', QUICK, () => {
  it('falls back to the key prompt with one notice when OAuth is not advertised', async () => {
    as = await startAs({ metadata: null });
    const s = await sandbox(as, { openUrl: async () => assert.fail('no browser') });
    // The stub /v1 does not know this fake key, so verification fails after the notice.
    await s.go(['login'], `${KEY}\n`);
    assert.match(s.stderr.text, /OAuth not available on this environment; paste an API key/);
    assert.equal(s.stderr.text.match(/OAuth not available/g)?.length, 1);
  });

  it('falls back to the key prompt when S256 is advertised but ivora_cli is not', async () => {
    as = await startAs({ patch: { ivora_cli: undefined } });
    const s = await sandbox(as, { openUrl: async () => assert.fail('no browser') });
    await s.go(['login'], `${KEY}\n`);
    assert.match(s.stderr.text, /OAuth not available on this environment; paste an API key/);
    assert.equal(as.seen.find((r) => r.path === '/v1/access')?.auth, `Bearer ${KEY}`);
    assert.equal(
      as.seen.some((r) => r.path.startsWith('/oauth/')),
      false,
    );
  });

  it('--with-key keeps the key path and never reads the metadata', async () => {
    as = await startAs({ metadata: null });
    const s = await sandbox(as);
    await s.go(['login', '--with-key'], `${KEY}\n`);
    assert.equal(
      as.seen.some((r) => r.path.startsWith('/.well-known')),
      false,
    );
    assert.doesNotMatch(s.stderr.text, /OAuth not available/);
    assert.equal(as.seen.find((r) => r.path === '/v1/access')?.auth, `Bearer ${KEY}`);
  });
});

describe('refresh, logout and 403 handling', QUICK, () => {
  async function loggedIn() {
    as = await startAs();
    const b = browser();
    const s = await sandbox(as, { openUrl: b.openUrl });
    assert.equal(await s.go(['login']), ExitCode.Ok);
    s.stdout.text = '';
    s.stderr.text = '';
    return s;
  }

  it('refreshes once on a 401 and replays the request', async () => {
    const s = await loggedIn();
    const before = await s.secrets.get(oauthRefs('test').access);
    as?.invalidateAccess(); // the server no longer accepts the stored access token
    // refresh issues a new valid token
    assert.equal(await s.go(['whoami']), ExitCode.Ok);
    const after = await s.secrets.get(oauthRefs('test').access);
    assert.notEqual(after, before);
    const grants = as?.seen
      .filter((r) => r.path === '/oauth/token')
      .map((r) => r.form?.get('grant_type'));
    assert.deepEqual(grants, ['authorization_code', 'refresh_token']);
    assert.match(
      as?.seen
        .find((r) => r.form?.get('grant_type') === 'refresh_token')
        ?.form?.get('refresh_token') ?? '',
      /^rt\.1\./,
    );
    assert.match((await s.secrets.get(oauthRefs('test').refresh)) ?? '', /^rt\.2\./); // rotated
  });

  it('a failed refresh asks the user to run ivora login again', async () => {
    const s = await loggedIn();
    as?.invalidateAccess();
    as?.breakRefresh();
    assert.equal(await s.go(['whoami']), ExitCode.Auth);
    assert.match(s.stderr.text, /Run `ivora login` again/);
    assert.doesNotMatch(s.stderr.text, /fake-(access|refresh)-token/);
  });

  it('refreshes before expiry without a 401', async () => {
    const s = await loggedIn();
    const file = join(s.dir, 'ivora', 'config.toml');
    const text = await readFile(file, 'utf8');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, text.replace(/token_expires_at = "\d+"/, 'token_expires_at = "1"'));
    assert.equal(await s.go(['whoami']), ExitCode.Ok);
    const grants = as?.seen
      .filter((r) => r.path === '/oauth/token')
      .map((r) => r.form?.get('grant_type'));
    assert.deepEqual(grants, ['authorization_code', 'refresh_token']);
    assert.equal(
      as?.seen.filter((r) => r.path === '/v1/access' && r.auth?.includes('at.1.')).length,
      1, // only the check made at login
    );
  });

  it('logout revokes server-side and clears the keychain', async () => {
    const s = await loggedIn();
    assert.equal(await s.go(['logout']), ExitCode.Ok);
    const revokes = as?.seen.filter((r) => r.path === '/oauth/revoke') ?? [];
    assert.deepEqual(revokes.map((r) => r.form?.get('token_type_hint')).sort(), [
      'access_token',
      'refresh_token',
    ]);
    assert.equal(await s.secrets.get(oauthRefs('test').access), undefined);
    assert.equal(await s.secrets.get(oauthRefs('test').refresh), undefined);
    assert.doesNotMatch(await readFile(join(s.dir, 'ivora', 'config.toml'), 'utf8'), /auth_type/);
    assert.doesNotMatch(s.stdout.text + s.stderr.text, /fake-(access|refresh)-token/);
    assert.equal(await s.go(['whoami']), ExitCode.Auth);
  });

  it('logout says so when revocation fails, and still clears locally', async () => {
    as = await startAs({ revokeStatus: 500 });
    const s = await sandbox(as, { openUrl: browser().openUrl });
    assert.equal(await s.go(['login']), ExitCode.Ok);
    assert.equal(await s.go(['logout']), ExitCode.ApiError);
    assert.match(s.stderr.text, /Could not revoke/);
    assert.equal(await s.secrets.get(oauthRefs('test').access), undefined);
    assert.equal(await s.secrets.get(oauthRefs('test').refresh), undefined);
  });

  it('explains a 403 on imports and migration routes for OAuth tokens', async () => {
    as = await startAs();
    const client = new ApiClient({
      baseUrl: as.url,
      apiKey: 'at.x.fake-access-token',
      apiVersion: '2026-10-15',
      authType: 'oauth',
    });
    as.valid.add('at.x.fake-access-token');
    await assert.rejects(client.request('GET', '/v1/imports/jobs'), /OAuth\) cannot use imports/);
  });
});

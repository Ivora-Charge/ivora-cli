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
import { KeychainSecretStore, MemorySecretStore, type Exec } from '../src/lib/secrets.js';

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

/** Plays the browser: fetches the redirect URI with a code and the given state. */
function browser(mutate?: (state: string) => string) {
  const opened: string[] = [];
  const openUrl = async (url: string): Promise<void> => {
    opened.push(url);
    const u = new URL(url);
    const redirect = new URL(u.searchParams.get('redirect_uri') ?? '');
    redirect.searchParams.set('code', 'fake-auth-code');
    const state = u.searchParams.get('state') ?? '';
    redirect.searchParams.set('state', mutate ? mutate(state) : state);
    await new Promise<void>((resolve) => {
      httpRequest(redirect, (res) => {
        res.resume();
        res.on('end', resolve);
      })
        .on('error', () => resolve())
        .end();
    });
  };
  return { opened, openUrl };
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

describe('loopback listener', () => {
  it('binds 127.0.0.1 only, on a random port', async () => {
    const l = await startLoopbackListener('s');
    try {
      assert.equal(l.redirectUri, `http://127.0.0.1:${l.port}/callback`);
      // Look at the bound address through a probe: IPv4 loopback answers, IPv6 is refused.
      const v4 = await probe('127.0.0.1', l.port);
      assert.equal(v4, true);
      const v6 = await probe('::1', l.port);
      assert.equal(v6, false);
    } finally {
      await l.close();
    }
  });

  it('refuses a callback with the wrong state and does not return the code', async () => {
    const l = await startLoopbackListener('right-state');
    const waiting = l.waitForCode();
    const expectation = assert.rejects(waiting, { exitCode: ExitCode.Auth });
    const status = await get(`${l.redirectUri}?code=abc&state=wrong-state`);
    assert.equal(status, 400);
    await expectation;
    await l.close();
  });

  it('accepts the right state and only the /callback path', async () => {
    const l = await startLoopbackListener('right-state');
    const waiting = l.waitForCode();
    assert.equal(await get(`http://127.0.0.1:${l.port}/other?code=x&state=right-state`), 404);
    assert.equal(await get(`${l.redirectUri}?code=abc&state=right-state`), 200);
    assert.equal(await waiting, 'abc');
    await l.close();
  });
});

function get(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    httpRequest(url, (res) => {
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

describe('authorization-server metadata', () => {
  it('reads the metadata the CLI needs', async () => {
    as = await startAs();
    const meta = await fetchOAuthMetadata(as.url);
    assert.equal(meta?.clientId, 'ivora-cli');
    assert.equal(meta?.tokenEndpoint, `${as.url}/oauth/token`);
  });

  it('is undefined without S256, without the document, or with a client secret method', async () => {
    as = await startAs({ metadata: null });
    assert.equal(await fetchOAuthMetadata(as.url), undefined);
    await as.close();
    as = await startAs({
      metadata: {
        authorization_endpoint: 'http://127.0.0.1/a',
        token_endpoint: 'http://127.0.0.1/t',
        code_challenge_methods_supported: ['plain'],
      },
    });
    assert.equal(await fetchOAuthMetadata(as.url), undefined);
  });
});

describe('ivora login (browser)', () => {
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
    const b = browser((state) => `${state}x`);
    const s = await sandbox(as, { openUrl: b.openUrl });
    assert.equal(await s.go(['login']), ExitCode.Auth);
    assert.match(s.stderr.text, /state did not match/);
    assert.equal(
      as.seen.some((r) => r.path === '/oauth/token'),
      false,
    );
    assert.equal(await s.secrets.get(oauthRefs('test').access), undefined);
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

  it('with an unsafe loopback template, treats OAuth as unavailable', async () => {
    as = await startAs({
      metadata: {
        authorization_endpoint: 'http://127.0.0.1/a',
        token_endpoint: 'http://127.0.0.1/t',
        code_challenge_methods_supported: ['S256'],
        ivora_cli: { redirect_uri_template: 'http://[::1]:{port}/callback' },
      },
    });
    assert.equal(await fetchOAuthMetadata(as.url), undefined);
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

describe('fallback and --with-key', () => {
  it('falls back to the key prompt with one notice when OAuth is not advertised', async () => {
    as = await startAs({ metadata: null });
    const s = await sandbox(as, { openUrl: async () => assert.fail('no browser') });
    // The stub /v1 does not know this fake key, so verification fails after the notice.
    await s.go(['login'], `${KEY}\n`);
    assert.match(s.stderr.text, /OAuth not available on this environment; paste an API key/);
    assert.equal(s.stderr.text.match(/OAuth not available/g)?.length, 1);
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

describe('refresh, logout and 403 handling', () => {
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

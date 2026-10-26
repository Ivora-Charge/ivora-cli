import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import { run, type RunIo } from '../src/cli.js';
import { ExitCode } from '../src/lib/output.js';
import { parseConfig, serializeConfig, type ProfileConfig } from '../src/lib/profiles.js';
import {
  KeychainSecretStore,
  MemorySecretStore,
  UnavailableSecretStore,
  openSecretStore,
  type Exec,
  type SecretStore,
} from '../src/lib/secrets.js';
import { startMockApi, type MockApi } from './mock-server.js';

const TEST_KEY = 'iv_test_fakekey1234567890';
const LIVE_KEY = 'iv_live_fakekey1234567890';

const LIVE_ACCESS = { environment: 'live', tenant_id: 'ten_fixture', scopes: ['stations:read'] };
function queueLiveAccess(): void {
  api.enqueue('GET', '/v1/access', { status: 200, body: LIVE_ACCESS });
}

function capture(): { write(s: string): void; text: string } {
  return {
    text: '',
    write(s: string) {
      this.text += s;
    },
  };
}

let api: MockApi;
let dirs: string[] = [];
before(async () => {
  api = await startMockApi();
});
after(async () => {
  await api.close();
});
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

async function sandbox(extraEnv: NodeJS.ProcessEnv = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ivora-cli-test-'));
  dirs.push(dir);
  const secrets = new MemorySecretStore();
  const stdout = capture();
  const stderr = capture();
  const env = { XDG_CONFIG_HOME: dir, IVORA_API_BASE: api.url, ...extraEnv };
  const go = (argv: string[], stdin = '', io: Partial<RunIo> = {}) =>
    run(argv, {
      stdout,
      stderr,
      env,
      secrets,
      stdin: Readable.from([stdin]),
      prompter: { interactive: false, ask: async () => '' },
      ...io,
    });
  return { dir, secrets, stdout, stderr, go };
}

describe('config file', () => {
  it('round-trips and holds no key material', () => {
    const config: ProfileConfig = {
      current: 'test',
      profiles: {
        test: { name: 'test', environment: 'test', keyRef: 'profile:test', tenantId: 'ten_1' },
        live: { name: 'live', environment: 'live', baseUrl: 'https://api.example.com' },
      },
    };
    const text = serializeConfig(config);
    assert.doesNotMatch(text, /iv_(test|live)_/);
    assert.deepEqual(parseConfig(text), config);
  });

  it('rejects malformed lines', () => {
    assert.throws(() => parseConfig('current = test'), { exitCode: ExitCode.Usage });
    assert.throws(() => parseConfig('[profiles.__proto__]\nenvironment = "test"'), {
      exitCode: ExitCode.Usage,
    });
  });
});

describe('ivora login', () => {
  it('verifies the key, stores it in the secret store and writes a key-free config', async () => {
    const s = await sandbox();
    assert.equal(await s.go(['login'], `${TEST_KEY}\n`), ExitCode.Ok);
    assert.equal(await s.secrets.get('profile:test'), TEST_KEY);
    assert.equal(api.requests.at(-1)?.headers.authorization, `Bearer ${TEST_KEY}`);
    const file = join(s.dir, 'ivora', 'config.toml');
    const text = await readFile(file, 'utf8');
    assert.doesNotMatch(text, /iv_test_fake/);
    assert.match(text, /key_ref = "profile:test"/);
    assert.match(text, /tenant_id = "ten_fixture"/);
    assert.equal((await stat(file)).mode & 0o077, 0);
    assert.doesNotMatch(s.stdout.text + s.stderr.text, /fakekey1234567890/);
  });

  it('refuses a live key for a test profile, and a test key with --live', async () => {
    const s = await sandbox();
    assert.equal(await s.go(['login'], `${LIVE_KEY}\n`), ExitCode.Usage);
    assert.equal(await s.go(['--live', 'login'], `${TEST_KEY}\n`), ExitCode.Usage);
    assert.equal(await s.secrets.get('profile:test'), undefined);
    assert.doesNotMatch(s.stderr.text, /fakekey1234567890/);
  });

  it('saves nothing when the server rejects the key', async () => {
    const s = await sandbox();
    api.enqueue('GET', '/v1/access', { status: 401, body: { error: { code: 'unauthorized' } } });
    assert.equal(await s.go(['login'], `${TEST_KEY}\n`), ExitCode.Auth);
    assert.equal(await s.secrets.get('profile:test'), undefined);
    await assert.rejects(readFile(join(s.dir, 'ivora', 'config.toml')), { code: 'ENOENT' });
  });

  it('has no way to pass the key as an argument', async () => {
    const s = await sandbox();
    assert.equal(await s.go(['login', '--key', TEST_KEY]), ExitCode.Usage);
  });

  it('live is opt-in: login --live makes a live profile that is never the default', async () => {
    const s = await sandbox();
    queueLiveAccess();
    assert.equal(await s.go(['--live', 'login'], `${LIVE_KEY}\n`), ExitCode.Ok);
    assert.equal(await s.secrets.get('profile:live'), LIVE_KEY);
    assert.doesNotMatch(await readFile(join(s.dir, 'ivora', 'config.toml'), 'utf8'), /current/);
    // Without --live the live profile is not used, even with a live key in the environment.
    const before = api.requests.length;
    assert.equal(await s.go(['whoami']), ExitCode.Auth);
    assert.equal(api.requests.length, before);
    queueLiveAccess();
    assert.equal(await s.go(['--live', 'whoami']), ExitCode.Ok);
  });
});

describe('ivora whoami and profiles', () => {
  it('whoami calls /v1/access and /v1/capabilities with the stored key', async () => {
    const s = await sandbox();
    await s.go(['login'], `${TEST_KEY}\n`);
    s.stdout.text = '';
    assert.equal(await s.go(['--json', 'whoami']), ExitCode.Ok);
    const out = JSON.parse(s.stdout.text) as Record<string, unknown>;
    assert.equal(out.tenant_id, 'ten_fixture');
    assert.deepEqual(out.scopes, ['stations:read', 'stations:write']);
    assert.ok(api.requests.some((r) => r.path === '/v1/capabilities'));
  });

  it('whoami works from IVORA_API_KEY alone, and checks it against the profile', async () => {
    const s = await sandbox({ IVORA_API_KEY: TEST_KEY });
    assert.equal(await s.go(['whoami']), ExitCode.Ok);
    const live = await sandbox({ IVORA_API_KEY: LIVE_KEY });
    assert.equal(await live.go(['whoami']), ExitCode.Usage);
    queueLiveAccess();
    assert.equal(await live.go(['--live', 'whoami']), ExitCode.Ok);
  });

  it('whoami without a login explains what to do', async () => {
    const s = await sandbox();
    assert.equal(await s.go(['whoami']), ExitCode.Auth);
    assert.match(s.stderr.text, /ivora login/);
  });

  it('lists, selects and removes profiles', async () => {
    const s = await sandbox();
    await s.go(['login'], `${TEST_KEY}\n`);
    await s.go(['--profile', 'staging', 'login'], `${TEST_KEY}\n`);
    queueLiveAccess();
    await s.go(['--live', 'login'], `${LIVE_KEY}\n`);
    s.stdout.text = '';
    assert.equal(await s.go(['--json', 'profiles', 'list']), ExitCode.Ok);
    const rows = JSON.parse(s.stdout.text) as { name: string; current: string }[];
    assert.deepEqual(rows.map((r) => r.name).sort(), ['live', 'staging', 'test']);
    assert.doesNotMatch(s.stdout.text, /fakekey/);

    assert.equal(await s.go(['profiles', 'use', 'staging']), ExitCode.Ok);
    assert.equal(await s.go(['profiles', 'use', 'live']), ExitCode.Usage);
    assert.equal(await s.go(['profiles', 'use', 'missing']), ExitCode.Usage);

    // Removing a live profile needs --yes when not interactive.
    assert.equal(await s.go(['profiles', 'remove', 'live']), ExitCode.ConfirmRefused);
    assert.equal(await s.go(['--yes', 'profiles', 'remove', 'live']), ExitCode.Ok);
    assert.equal(await s.secrets.get('profile:live'), undefined);
  });
});

describe('keychain store', () => {
  function fakeExec(calls: { cmd: string; args: string[]; input?: string }[]): Exec {
    const data = new Map<string, string>();
    return async (cmd, args, input) => {
      calls.push({ cmd, args, ...(input === undefined ? {} : { input }) });
      if (args[0] === 'store') data.set(args.at(-1) as string, input ?? '');
      if (args[0] === 'lookup') {
        const v = data.get(args.at(-1) as string);
        return { code: v ? 0 : 1, stdout: v ? `${v}\n` : '' };
      }
      if (args[0] === 'clear')
        return { code: data.delete(args.at(-1) as string) ? 0 : 1, stdout: '' };
      return { code: 0, stdout: '' };
    };
  }

  it('passes the secret on stdin, never in argv (Secret Service)', async () => {
    const calls: { cmd: string; args: string[]; input?: string }[] = [];
    const store = new KeychainSecretStore('linux', fakeExec(calls));
    await store.set('profile:test', TEST_KEY);
    assert.equal(await store.get('profile:test'), TEST_KEY);
    assert.equal(await store.delete('profile:test'), true);
    assert.equal(await store.get('profile:test'), undefined);
    assert.ok(calls.every((c) => !c.args.join(' ').includes(TEST_KEY)));
    assert.equal(calls[0]?.input, TEST_KEY);
  });

  it('passes the secret on stdin on macOS too', async () => {
    const calls: { cmd: string; args: string[]; input?: string }[] = [];
    const store = new KeychainSecretStore('darwin', fakeExec(calls));
    await store.set('profile:test', TEST_KEY);
    assert.deepEqual(calls[0]?.args, ['-i']);
    assert.ok(calls.every((c) => !c.args.join(' ').includes(TEST_KEY)));
  });

  it('rejects odd references and secrets', async () => {
    const store = new KeychainSecretStore('darwin', fakeExec([]));
    await assert.rejects(store.set('profile:test; rm', TEST_KEY));
    await assert.rejects(store.set('profile:test', 'abc def\nadd-generic-password'));
  });

  it('refuses to store keys when there is no keychain', async () => {
    const missing: Exec = async () => ({ code: 1, stdout: '', missing: true });
    const store: SecretStore = await openSecretStore('linux', missing);
    assert.ok(store instanceof UnavailableSecretStore);
    await assert.rejects((store as SecretStore).set('profile:test', TEST_KEY), {
      exitCode: ExitCode.Usage,
    });
    assert.ok((await openSecretStore('win32', missing)) instanceof UnavailableSecretStore);
  });
});

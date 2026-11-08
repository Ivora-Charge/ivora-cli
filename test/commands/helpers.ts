import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { run } from '../../src/cli.js';
import { MemorySecretStore } from '../../src/lib/secrets.js';
import type { MockApi } from '../mock-server.js';

export const TEST_KEY = 'iv_test_fakekey1234567890';

/** Runs the CLI against the mock API with a fake test key from the environment. */
export async function sandbox(api: MockApi, stdin = '') {
  const dir = await mkdtemp(join(tmpdir(), 'ivora-cli-test-'));
  const out = {
    text: '',
    write(s: string) {
      this.text += s;
    },
  };
  const err = {
    text: '',
    write(s: string) {
      this.text += s;
    },
  };
  const env = { XDG_CONFIG_HOME: dir, IVORA_API_BASE: api.url, IVORA_API_KEY: TEST_KEY };
  const go = (argv: string[], input = stdin): Promise<number> =>
    run(argv, {
      stdout: out,
      stderr: err,
      env,
      secrets: new MemorySecretStore(),
      stdin: Readable.from([input]),
      prompter: { interactive: false, ask: async () => '' },
    });
  return { dir, out, err, go, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Requests the mock saw, minus the /v1/access lookup used to find the tenant. */
export function calls(api: MockApi) {
  return api.requests.filter((r) => r.path !== '/v1/access');
}

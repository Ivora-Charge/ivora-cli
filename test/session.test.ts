import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { openSession, type CommandContext } from '../src/lib/session.js';
import { saveConfig, type ProfileConfig } from '../src/lib/profiles.js';
import { MemorySecretStore } from '../src/lib/secrets.js';
import type { GlobalOptions } from '../src/cli.js';

let dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

async function ctxFor(config: ProfileConfig, globals: Partial<GlobalOptions>) {
  const dir = await mkdtemp(join(tmpdir(), 'ivora-cli-session-'));
  dirs.push(dir);
  const env = { XDG_CONFIG_HOME: dir };
  await saveConfig(config, env);
  const secrets = new MemorySecretStore();
  return {
    env,
    secrets: async () => secrets,
    globals: () => globals as GlobalOptions,
  } as unknown as CommandContext;
}

async function message(ctx: CommandContext): Promise<string> {
  try {
    await openSession(ctx);
  } catch (err) {
    return (err as Error).message;
  }
  assert.fail('expected openSession to throw');
}

describe('openSession errors', () => {
  it('names `ivora --live login` when a live profile has no stored key', async () => {
    const ctx = await ctxFor(
      { profiles: { live: { name: 'live', environment: 'live', keyRef: 'profile:live' } } },
      { live: true },
    );
    const msg = await message(ctx);
    assert.match(msg, /No stored key for profile "live"/);
    assert.match(msg, /Run `ivora --live login` again/);
  });

  it('keeps `ivora login` when a test profile has no stored key', async () => {
    const ctx = await ctxFor(
      { profiles: { test: { name: 'test', environment: 'test', keyRef: 'profile:test' } } },
      {},
    );
    assert.match(await message(ctx), /Run `ivora login` again/);
  });

  it('names `ivora --live login` when the live profile does not exist', async () => {
    const ctx = await ctxFor({ profiles: {} }, { live: true });
    assert.match(await message(ctx), /No profile "live"\. Run `ivora --live login` first/);
  });

  it('points an empty config to `ivora --live login` for production', async () => {
    const ctx = await ctxFor({ profiles: {} }, {});
    const msg = await message(ctx);
    assert.match(msg, /Run `ivora login` first/);
    assert.match(msg, /`ivora --live login` for production/);
  });
});

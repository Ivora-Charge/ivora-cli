import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ExitCode } from '../src/lib/output.js';
import {
  PRODUCTION_API_BASE,
  assertKeyMatchesProfile,
  configDir,
  environmentForKey,
  resolveBaseUrl,
  selectProfileName,
  validateBaseUrl,
  type Profile,
} from '../src/lib/profiles.js';

const test: Profile = { name: 'test', environment: 'test' };
const live: Profile = { name: 'live', environment: 'live' };

describe('profiles', () => {
  it('reads the environment from the key prefix', () => {
    assert.equal(environmentForKey('iv_test_x'), 'test');
    assert.equal(environmentForKey('iv_live_x'), 'live');
    assert.equal(environmentForKey('ivk_test_x'), undefined);
  });

  it('refuses a key from the other environment', () => {
    assert.doesNotThrow(() => assertKeyMatchesProfile('iv_test_x', test));
    assert.throws(() => assertKeyMatchesProfile('iv_live_x', test), { exitCode: ExitCode.Usage });
    assert.throws(() => assertKeyMatchesProfile('iv_test_x', live), { exitCode: ExitCode.Usage });
    assert.throws(() => assertKeyMatchesProfile('nope', test), { exitCode: ExitCode.Usage });
  });

  it('resolves base URLs', () => {
    assert.equal(resolveBaseUrl(live, {}), PRODUCTION_API_BASE);
    assert.equal(
      resolveBaseUrl({ ...test, baseUrl: 'https://sandbox.example.com/' }, {}),
      'https://sandbox.example.com',
    );
    assert.equal(
      resolveBaseUrl(test, { IVORA_API_BASE: 'http://127.0.0.1:4010' }),
      'http://127.0.0.1:4010',
    );
    assert.throws(() => resolveBaseUrl(test, {}), { exitCode: ExitCode.Usage });
  });

  it('ignores IVORA_API_BASE for live profiles, with one note', () => {
    const notes: string[] = [];
    const env = { IVORA_API_BASE: 'http://127.0.0.1:4010' };
    assert.equal(
      resolveBaseUrl(live, env, (n) => notes.push(n)),
      PRODUCTION_API_BASE,
    );
    assert.equal(
      resolveBaseUrl({ ...live, baseUrl: 'https://api.example.com' }, env),
      'https://api.example.com',
    );
    assert.equal(notes.length, 1);
    assert.match(notes[0] ?? '', /IVORA_API_BASE is ignored/);
    resolveBaseUrl(live, {}, (n) => notes.push(n));
    assert.equal(notes.length, 1);
  });

  it('accepts only https origins (http for loopback)', () => {
    assert.throws(() => validateBaseUrl('http://api.example.com'));
    assert.throws(() => validateBaseUrl('https://user:pw@api.example.com'));
    assert.throws(() => validateBaseUrl('https://api.example.com/v1'));
    assert.throws(() => validateBaseUrl('not a url'));
    assert.equal(validateBaseUrl('http://localhost:3000'), 'http://localhost:3000');
  });

  it('selects the profile name', () => {
    assert.equal(selectProfileName({}, { profiles: {} }), 'test');
    assert.equal(selectProfileName({ live: true }, { profiles: {} }), 'live');
    assert.equal(selectProfileName({ profile: 'ci' }, { current: 'live', profiles: {} }), 'ci');
    assert.equal(selectProfileName({}, { current: 'staging', profiles: {} }), 'staging');
  });

  it('places the config under XDG, APPDATA or ~/.config', () => {
    assert.equal(configDir({ XDG_CONFIG_HOME: '/x' }, 'linux', '/h'), join('/x', 'ivora'));
    assert.equal(
      configDir({ APPDATA: 'C:\\AppData' }, 'win32', '/h'),
      join('C:\\AppData', 'ivora'),
    );
    assert.equal(configDir({}, 'darwin', '/h'), join('/h', '.config', 'ivora'));
  });
});

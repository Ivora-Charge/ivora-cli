import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MemorySecretStore,
  REDACTED,
  displayPrefix,
  redact,
  redactBody,
  redactHeaders,
} from '../src/lib/secrets.js';

describe('secrets', () => {
  it('redacts keys, webhook secrets and auth schemes in text', () => {
    const text =
      'key iv_live_abc123XYZ and whsec_Zm9vYmFy= with Bearer abc.def and basic dXNlcjpwYXNz';
    const out = redact(text);
    assert.equal(
      out,
      `key iv_live_${REDACTED} and whsec_${REDACTED} with Bearer ${REDACTED} and basic ${REDACTED}`,
    );
  });

  it('redacts credential headers', () => {
    assert.deepEqual(
      redactHeaders({
        Authorization: 'Bearer iv_test_x',
        'Ivora-Signature': 't=1,v1=ab',
        Accept: 'application/json',
      }),
      {
        Authorization: REDACTED,
        'Ivora-Signature': REDACTED,
        Accept: 'application/json',
      },
    );
  });

  it('redacts password and secret fields in bodies, deeply', () => {
    assert.deepEqual(
      redactBody({
        name: 'A',
        password: 'p',
        nested: [{ webhook_secret: 's', api_key: 'k', ok: 1 }],
      }),
      {
        name: 'A',
        password: REDACTED,
        nested: [{ webhook_secret: REDACTED, api_key: REDACTED, ok: 1 }],
      },
    );
  });

  it('shows only a display prefix of a key', () => {
    assert.equal(displayPrefix('iv_test_abcdefghijkl'), 'iv_test_abcd...');
    assert.equal(displayPrefix('something-else'), '(unrecognised key)');
  });

  it('memory store round-trips', async () => {
    const store = new MemorySecretStore();
    await store.set('profile:test', 'iv_test_x');
    assert.equal(await store.get('profile:test'), 'iv_test_x');
    assert.equal(await store.delete('profile:test'), true);
    assert.equal(await store.get('profile:test'), undefined);
  });
});

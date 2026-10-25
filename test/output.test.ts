import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Output, envTag, formatTable } from '../src/lib/output.js';

function sink(isTTY = false): { write(s: string): void; isTTY: boolean; text: string } {
  return {
    isTTY,
    text: '',
    write(s: string) {
      this.text += s;
    },
  };
}

describe('output', () => {
  it('formats tables', () => {
    assert.equal(
      formatTable([
        { id: 'st_1', online: true },
        { id: 'st_22', online: false, extra: { a: 1 } },
      ]),
      'ID     ONLINE  EXTRA\nst_1   true\nst_22  false   {"a":1}\n',
    );
  });

  it('writes JSON to stdout and diagnostics to stderr, redacted', () => {
    const stdout = sink();
    const stderr = sink();
    const out = new Output({ json: true, stdout, stderr, env: {} });
    out.result({ id: 'st_1', note: 'iv_test_secretvalue' });
    out.info('progress');
    out.line('human only');
    assert.deepEqual(JSON.parse(stdout.text), { id: 'st_1', note: 'iv_test_[redacted]' });
    assert.equal(stderr.text, 'progress\n');
  });

  it('respects NO_COLOR and non-TTY', () => {
    assert.equal(new Output({ stdout: sink(true), env: {} }).color, true);
    assert.equal(new Output({ stdout: sink(true), env: { NO_COLOR: '1' } }).color, false);
    assert.equal(new Output({ stdout: sink(false), env: {} }).color, false);
  });

  it('tags environments', () => {
    assert.equal(envTag('test'), '[TEST]');
    assert.equal(envTag('live', 'Demo'), '[LIVE] Demo');
  });
});

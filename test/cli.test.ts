import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { run } from '../src/cli.js';
import { ExitCode } from '../src/lib/output.js';
import { CLI_VERSION } from '../src/version.js';

function capture(): { write(s: string): void; text: string } {
  return {
    text: '',
    write(s: string) {
      this.text += s;
    },
  };
}

describe('ivora entry point', () => {
  it('keeps CLI_VERSION equal to package.json', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    assert.equal(CLI_VERSION, pkg.version);
  });

  it('prints versions', async () => {
    const stdout = capture();
    assert.equal(await run(['--version'], { stdout, stderr: capture() }), ExitCode.Ok);
    assert.match(stdout.text, /^ivora \d+\.\d+\.\d+ \(API \d{4}-\d{2}-\d{2}\)\n$/);
  });

  it('returns exit code 2 for usage errors', async () => {
    const stderr = capture();
    assert.equal(await run(['--no-such-flag'], { stdout: capture(), stderr }), ExitCode.Usage);
    assert.match(stderr.text, /unknown option/);
    assert.equal(
      await run(['--api-version', '1999-01-01'], { stdout: capture(), stderr: capture() }),
      ExitCode.Usage,
    );
    assert.equal(
      await run(['--idempotency-key', 'short'], { stdout: capture(), stderr: capture() }),
      ExitCode.Usage,
    );
  });

  it('runs as a process', () => {
    const bin = fileURLToPath(new URL('../src/bin/ivora.js', import.meta.url));
    const out = execFileSync(process.execPath, [bin, '--help'], { encoding: 'utf8' });
    assert.match(out, /Usage: ivora/);
  });
});

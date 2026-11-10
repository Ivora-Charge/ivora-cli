import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { run } from '../../src/cli.js';

function io() {
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
  return { out, err, run: (argv: string[]) => run(argv, { stdout: out, stderr: err, env: {} }) };
}

describe('ivora validate', () => {
  it('checks a file offline: no network, no credentials', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ivora-validate-'));
    try {
      const good = join(dir, 'ivora.yaml');
      await writeFile(
        good,
        'version: 1\nproject: p\nlocations:\n  s1: { name: Site 1 }\n' +
          'stations:\n  cp-01: { location: s1, charger_id: A }\napps: {}\n',
      );
      const a = io();
      assert.equal(await a.run(['validate', '-f', good]), 0);
      assert.match(a.err.text, /skipped apps: .*signed-in/);

      const bad = join(dir, 'bad.yaml');
      await writeFile(
        bad,
        'version: 1\nproject: p\nlocations:\n  s1: { name: Site 1 }\n' +
          'stations:\n  cp-01: { location: s1, charger_id: TODO }\n',
      );
      const b = io();
      assert.equal(await b.run(['validate', '-f', bad]), 2);
      assert.match(b.err.text, /stations\.cp-01\.charger_id: is a placeholder/);

      const secret = join(dir, 'secret.yaml');
      await writeFile(
        secret,
        'version: 1\nproject: p\nlocations:\n  s1: { name: Site 1 }\n' +
          'stations:\n  cp-01: { location: s1, charger_id: A, credentials: { secret: "file:./nope" } }\n',
      );
      const w = io();
      assert.equal(await w.run(['validate', '-f', secret]), 0);
      assert.match(w.err.text, /warning: stations\.cp-01\.credentials\.secret: .*does not exist/);

      const j = io();
      assert.equal(await j.run(['--json', 'validate', '-f', bad]), 2);
      assert.equal(JSON.parse(j.out.text).valid, false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails clearly on a missing file and prints the schema', async () => {
    const a = io();
    assert.equal(await a.run(['validate', '-f', '/nonexistent/ivora.yaml']), 2);
    assert.match(a.err.text, /Cannot read/);
    const s = io();
    assert.equal(await s.run(['validate', '--schema']), 0);
    assert.equal(JSON.parse(s.out.text).title, 'ivora.yaml');
  });
});

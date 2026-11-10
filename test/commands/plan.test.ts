import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { run } from '../../src/cli.js';
import { MemorySecretStore } from '../../src/lib/secrets.js';
import { ExitCode } from '../../src/lib/output.js';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { TEST_KEY } from './helpers.js';

/** A fake /v1 that serves a fixed live site and records every request. */
const LIVE: Record<string, unknown> = {
  '/v1/access': { environment: 'test', tenants: [{ id: 42 }] },
  '/v1/tenants/42/locations': {
    data: [
      { id: 1, name: 'Site 1', city: 'Old City', country: 'USA', external_reference: 'site-1' },
      { id: 2, name: 'Old site', external_reference: 'gone' },
      { id: 3, name: 'Site 9', external_reference: null },
    ],
    next_cursor: null,
  },
  '/v1/tenants/42/locations/1/tax': { configured: false, lines: [] },
  '/v1/tenants/42/locations/2/tax': { configured: false, lines: [] },
  '/v1/tenants/42/locations/3/tax': { configured: false, lines: [] },
  '/v1/tenants/42/tariffs': {
    data: [
      { id: 7, currency: 'USD', authorization_minor: 5000, external_reference: 'standard' },
      { id: 8, currency: 'USD', external_reference: null },
    ],
    next_cursor: null,
  },
  '/v1/tenants/42/stations': {
    data: [
      {
        id: 11,
        name: 'cp',
        charger_id: 'SITE1-CP01',
        location_id: 1,
        external_reference: null,
        connectors: [
          {
            id: 5,
            evse_number: 1,
            evse_connector_number: 1,
            type: 'IEC62196T1COMBO',
            max_power_w: 50000,
            tariff_id: 7,
          },
        ],
      },
      { id: 12, name: 'loose', charger_id: 'LOOSE-1', external_reference: null, connectors: [] },
    ],
    next_cursor: null,
  },
  '/v1/tenants/42/webhooks': {
    data: [
      {
        id: 'wh_1',
        url: 'https://hooks.example.com/ivora',
        events: ['station.connected'],
        secret: 'whsec_LIVE_SECRET_VALUE',
      },
    ],
  },
};

const FILE = `version: 1
project: proj_42
locations:
  site-1: { name: Site 1, city: New City, country: USA }
  site-2: { name: Site 9, country: USA }
  site-3: { name: Brand new, country: USA }
tariffs:
  standard: { currency: USD, authorization_minor: 6000 }
stations:
  cp-01:
    location: site-1
    charger_id: SITE1-CP01
    credentials: { secret: env:IVORA_CP01_PASSWORD }
    evses:
      1:
        connectors:
          1: { type: IEC62196T1COMBO, max_power_w: 150000, tariff: standard }
webhooks:
  hook: { url: https://hooks.example.com/ivora, events: [station.connected, station.disconnected] }
load_groups:
  main:
    location: site-1
    limit: { value: 100, unit: A }
    supply: { voltage_v: 400, phases: 3 }
    stations: [cp-01]
roaming_partners:
  p1: { profile: default, modules: [locations], switches: {} }
`;

let server: Server;
let base: string;
const seen: { method: string; path: string }[] = [];

before(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    seen.push({ method: req.method ?? '', path });
    const body = LIVE[path];
    res.writeHead(body === undefined ? 404 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body ?? { error: 'not found' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((r) => server.close(() => r())));

async function plan(file: string, extra: string[] = []) {
  const dir = await mkdtemp(join(tmpdir(), 'ivora-plan-'));
  const path = join(dir, 'ivora.yaml');
  await writeFile(path, file);
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
  seen.length = 0;
  const code = await run(['plan', '-f', path, ...extra], {
    stdout: out,
    stderr: err,
    env: { XDG_CONFIG_HOME: dir, IVORA_API_BASE: base, IVORA_API_KEY: TEST_KEY },
    secrets: new MemorySecretStore(),
    stdin: Readable.from(['']),
    prompter: { interactive: false, ask: async () => '' },
  });
  await rm(dir, { recursive: true, force: true });
  return { code, out, err };
}

describe('ivora plan', () => {
  it('diffs the file against live, with risks, adopt hints and power impact', async () => {
    const r = await plan(FILE, ['--json']);
    assert.equal(r.code, ExitCode.Ok, r.err.text);
    const p = JSON.parse(r.out.text) as {
      entries: {
        section: string;
        key: string;
        action: string;
        risks: string[];
        changes: { path: string }[];
      }[];
      adopt: { key: string; id: number }[];
      unmanaged: { section: string }[];
      skipped: { section: string }[];
      summary: Record<string, number>;
      power: { available: boolean; groups: { status: string; limit_w: number }[] };
    };
    const get = (s: string, k: string) => p.entries.find((e) => e.section === s && e.key === k);
    assert.equal(get('locations', 'site-1')?.action, 'update');
    assert.equal(get('locations', 'site-2')?.action, 'create');
    assert.equal(get('locations', 'site-3')?.action, 'create');
    assert.equal(get('locations', 'gone')?.action, 'delete');
    assert.equal(get('tariffs', 'standard')?.action, 'update');
    assert.ok(get('tariffs', 'standard')?.risks.some((x) => /price change/.test(x)));
    assert.equal(get('stations', 'cp-01')?.action, 'update');
    assert.ok(
      get('stations', 'cp-01')?.changes.some((c) => c.path === 'evses.1.connectors.1.max_power_w'),
    );
    assert.equal(get('webhooks', 'hook')?.action, 'update');
    assert.deepEqual(
      p.adopt.map((a) => [a.key, a.id]),
      [['site-2', 3]],
    );
    assert.ok(p.unmanaged.some((u) => u.section === 'stations'));
    assert.deepEqual(
      p.skipped.map((s) => s.section),
      ['roaming_partners'],
    );
    assert.equal(p.power.available, true);
    assert.equal(p.power.groups[0]?.status, 'over');
    assert.equal(p.power.groups[0]?.limit_w, 69282);
    assert.doesNotMatch(r.out.text, /LIVE_SECRET_VALUE/);
  });

  it('is read-only: only GET requests, never a charger or write path', async () => {
    await plan(FILE);
    assert.ok(seen.length > 0);
    assert.ok(
      seen.every((q) => q.method === 'GET'),
      JSON.stringify(seen),
    );
    assert.ok(seen.every((q) => !/control|admin|reset|unlock/.test(q.path)));
  });

  it('prints text with the skip reason and says power data is missing when it is', async () => {
    const r = await plan(FILE.replace(/load_groups:[\s\S]*?stations: \[cp-01\]\n/, ''));
    assert.equal(r.code, ExitCode.Ok);
    assert.match(r.out.text, /Read-only: nothing was changed/);
    assert.match(r.out.text, /skipped roaming_partners: needs a signed-in admin/);
    assert.match(r.out.text, /Site power impact:\n {2}not available/);
    assert.match(r.out.text, /Adopt hints \(proposals only/);
  });

  it('marks a matching resource unchanged and linked live resources the file lacks as deletes', async () => {
    const r = await plan(
      'version: 1\nproject: proj_42\nwebhooks:\n  hook: { url: https://hooks.example.com/ivora, events: [station.connected] }\n',
    );
    assert.match(r.out.text, /0 to create, 0 to update, 3 to delete, 1 unchanged/);
  });

  it('refuses a key for another project and an invalid file', async () => {
    const other = await plan(FILE.replace('proj_42', 'proj_99'));
    assert.equal(other.code, ExitCode.Usage);
    assert.match(other.err.text, /project proj_99/);
    const bad = await plan('version: 1\nproject: proj_42\nstations:\n  a: { name: TODO }\n');
    assert.equal(bad.code, ExitCode.Usage);
    assert.equal(seen.length, 0, 'an invalid file reads nothing');
  });
});

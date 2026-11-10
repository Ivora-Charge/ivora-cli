import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, before, beforeEach, describe, it } from 'node:test';
import { run } from '../../src/cli.js';
import { ExitCode } from '../../src/lib/output.js';
import { MAX_PAGES, PAGE_LIMIT } from '../../src/lib/plan/live.js';
import { phaseFactor, toWatts } from '../../src/lib/plan/power.js';
import { MemorySecretStore } from '../../src/lib/secrets.js';
import { TEST_KEY } from './helpers.js';

type Routes = Record<string, unknown>;
/** A route answering with an HTTP error instead of a body. */
const status = (code: number) => ({ __status: code });

/** A live site with a mix of managed (ivora.key), unmanaged and integrator-referenced resources. */
const MIXED: Routes = {
  '/v1/access': { environment: 'test', tenants: [{ id: 42 }] },
  '/v1/tenants/42/locations': {
    data: [
      {
        id: 1,
        name: 'Site 1',
        city: 'Old City',
        country: 'USA',
        external_reference: 'crm-1',
        metadata: { 'ivora.key': 'site-1' },
      },
      { id: 2, name: 'Old site', metadata: { 'ivora.key': 'gone' } },
      { id: 3, name: 'Site 9', metadata: {} },
      // An integrator's resource: external_reference only, no ivora.key. Never a delete.
      { id: 4, name: 'Integrator site', external_reference: 'ext-4' },
    ],
    next_cursor: null,
  },
  '/v1/tenants/42/locations/1/tax': { configured: false, lines: [] },
  '/v1/tenants/42/locations/2/tax': status(403),
  '/v1/tenants/42/locations/3/tax': status(404),
  '/v1/tenants/42/locations/4/tax': { configured: false, lines: [] },
  '/v1/tenants/42/tariffs': {
    data: [
      {
        id: 7,
        currency: 'USD',
        authorization_minor: 5000,
        metadata: { 'ivora.key': 'standard' },
      },
      { id: 8, currency: 'EUR', external_reference: 'legacy' },
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
        online: true,
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
      {
        id: 12,
        name: 'loose',
        charger_id: 'LOOSE-1',
        external_reference: 'ext-12',
        connectors: [],
      },
      {
        id: 13,
        name: 'old',
        charger_id: 'OLD-1',
        location_id: 2,
        metadata: { 'ivora.key': 'old-cp' },
        connectors: [],
      },
    ],
    next_cursor: null,
  },
  '/v1/tenants/42/transactions': {
    data: [{ id: 900, station_id: 11, active: true }],
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

/**
 * A live site where every resource carries its ivora.key except one station (matched by
 * charger_id). The round-trip test exports it with the real \`ivora export\` and plans the result.
 */
const MANAGED: Routes = {
  '/v1/access': { environment: 'test', tenants: [{ id: 42 }] },
  '/v1/tenants/42/locations': {
    data: [
      {
        id: 1,
        name: 'Site 1',
        address: '1 Example Street',
        city: 'Example City',
        state: 'CA',
        country: 'USA',
        postal_code: '00000',
        time_zone: 'America/Los_Angeles',
        external_reference: 'crm-1',
        metadata: { 'ivora.key': 'site-1', region: 'west' },
      },
    ],
    next_cursor: null,
  },
  '/v1/tenants/42/locations/1/tax': {
    configured: true,
    price_mode: 'tax_exclusive',
    lines: [{ name: 'State sales tax', type: 'percent', rate: 7.25 }],
  },
  '/v1/tenants/42/tariffs': {
    data: [
      {
        id: 7,
        currency: 'USD',
        authorization_minor: 5000,
        elements: [{ price_components: [{ type: 'ENERGY', price: 0.45, step_size: 1 }] }],
        rules: { idle_grace_minutes: 10 },
        metadata: { 'ivora.key': 'standard' },
      },
    ],
    next_cursor: null,
  },
  '/v1/tenants/42/stations': {
    data: [
      {
        id: 11,
        name: 'p42-SITE1-CP01',
        charger_id: 'SITE1-CP01',
        location_id: 1,
        online: true,
        metadata: { 'ivora.key': 'cp-01' },
        evses: [{ evse_number: 1, physical_reference: 'A' }],
        connectors: [
          {
            id: 5,
            evse_number: 1,
            evse_connector_number: 1,
            type: 'IEC62196T1COMBO',
            power_type: 'DC',
            max_power_w: 150000,
            max_amperage_a: 300,
            max_voltage_v: 500,
            tariff_id: 7,
          },
        ],
      },
      {
        id: 12,
        name: 'p42-SITE1-CP02',
        charger_id: 'SITE1-CP02',
        location_id: 1,
        online: false,
        connectors: [],
      },
    ],
    next_cursor: null,
  },
  '/v1/tenants/42/transactions': { data: [], next_cursor: null },
  // Reads only \`ivora export\` makes; plan does not compare these sections yet.
  '/v1/tenants/42/locations/1/default-tariff': { scope: 'location', tariff_id: 7 },
  '/v1/tenants/42/default-tariff': { scope: 'project', tariff_id: null },
  '/v1/tenants/42/stations/11/displays': { data: [] },
  '/v1/tenants/42/stations/12/displays': { data: [] },
  '/v1/tenants/42/webhooks': {
    data: [
      {
        id: 'wh_1',
        url: 'https://hooks.example.com/ivora',
        events: ['connector.status_changed'],
        stations: [11],
        status: 'active',
        secret: 'whsec_LIVE_SECRET_VALUE',
      },
    ],
  },
};

let routes: Routes = MIXED;
/** When set, every list answers a full page with a fresh cursor: a collection that never ends. */
let endless = false;
let server: Server;
let base: string;
const seen: { method: string; path: string }[] = [];

before(async () => {
  server = createServer((req, res) => {
    const [path = '', qs = ''] = (req.url ?? '').split('?');
    seen.push({ method: req.method ?? '', path });
    if (endless && path === '/v1/tenants/42/locations') {
      const after = Number(new URLSearchParams(qs).get('after') ?? '0');
      const data = Array.from({ length: PAGE_LIMIT }, (_, i) => ({ id: after + i + 1 }));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data, next_cursor: String(after + PAGE_LIMIT) }));
      return;
    }
    const body = routes[path] as { __status?: number } | undefined;
    const code = body === undefined ? 404 : (body.__status ?? 200);
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(code === 200 ? body : { error: { code: 'nope', message: 'no' } }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  routes = MIXED;
  endless = false;
});

async function plan(file: string, extra: string[] = []) {
  const dir = await mkdtemp(join(tmpdir(), 'ivora-plan-'));
  const path = join(dir, 'ivora.yaml');
  await writeFile(path, file);
  return cli(dir, ['plan', '-f', path, ...extra]);
}

/** Runs \`ivora export -o -\` against the fake API and returns the file it writes. */
async function exportFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ivora-export-'));
  const r = await cli(dir, ['export', '-o', '-']);
  assert.equal(r.code, ExitCode.Ok, r.err.text);
  assert.doesNotMatch(r.out.text, /LIVE_SECRET_VALUE/);
  return r.out.text;
}

async function cli(dir: string, argv: string[]) {
  const sink = () => ({
    text: '',
    write(s: string) {
      this.text += s;
    },
  });
  const out = sink();
  const err = sink();
  seen.length = 0;
  const code = await run(argv, {
    stdout: out,
    stderr: err,
    env: { XDG_CONFIG_HOME: dir, IVORA_API_BASE: base, IVORA_API_KEY: TEST_KEY },
    secrets: new MemorySecretStore(),
    stdin: Readable.from(['']),
    prompter: { interactive: false, ask: async () => '' },
  });
  await rm(dir, { recursive: true, force: true });
  // The API key never reaches any output, in any mode or outcome.
  assert.ok(!out.text.includes(TEST_KEY), 'API key on stdout');
  assert.ok(!err.text.includes(TEST_KEY), 'API key on stderr');
  return { code, out, err };
}

interface PlanJson {
  entries: {
    section: string;
    key: string;
    action: string;
    id?: number | string;
    risks: string[];
    changes: { path: string }[];
  }[];
  adopt: { section: string; key: string; id: number; proposal: string }[];
  unmanaged: { section: string; id: number | string }[];
  skipped: { section: string }[];
  notes: string[];
  summary: Record<string, number>;
  power: {
    available: boolean;
    groups: { status: string; limit_w: number }[];
    not_checked: string[];
  };
}

describe('ivora plan', () => {
  it('matches on ivora.key, deletes only keyed resources, and reports risks and adopt hints', async () => {
    const r = await plan(FILE, ['--json']);
    assert.equal(r.code, ExitCode.Ok, r.err.text);
    const p = JSON.parse(r.out.text) as PlanJson;
    const get = (s: string, k: string) => p.entries.find((e) => e.section === s && e.key === k);
    assert.equal(get('locations', 'site-1')?.action, 'update');
    assert.equal(get('locations', 'site-2')?.action, 'create');
    assert.equal(get('locations', 'site-3')?.action, 'create');
    assert.equal(get('locations', 'gone')?.action, 'delete');
    assert.equal(get('tariffs', 'standard')?.action, 'update');
    assert.ok(get('tariffs', 'standard')?.risks.some((x) => /price change/.test(x)));
    assert.equal(get('stations', 'cp-01')?.action, 'update');
    assert.equal(get('stations', 'cp-01')?.id, 11, 'falls back to charger_id');
    assert.ok(
      get('stations', 'cp-01')?.changes.some((c) => c.path === 'evses.1.connectors.1.max_power_w'),
    );
    assert.equal(get('stations', 'old-cp')?.action, 'delete');
    assert.equal(get('webhooks', 'hook')?.action, 'update');
    assert.deepEqual(
      p.adopt.map((a) => [a.section, a.key, a.id]),
      [
        ['locations', 'site-2', 3],
        ['stations', 'cp-01', 11],
      ],
    );
    assert.ok(p.adopt.every((a) => a.proposal.includes('"ivora.key"')));
    assert.deepEqual(
      p.skipped.map((s) => s.section),
      ['roaming_partners'],
    );
    assert.equal(p.summary.delete, 2);
    assert.doesNotMatch(r.out.text, /LIVE_SECRET_VALUE/);
  });

  it('never marks a resource for deletion by external_reference', async () => {
    const r = await plan(FILE, ['--json']);
    const p = JSON.parse(r.out.text) as PlanJson;
    const deletes = p.entries.filter((e) => e.action === 'delete').map((e) => e.id);
    // Location 4, tariff 8 and station 12 carry an external_reference but no ivora.key.
    for (const id of [4, 8, 12]) assert.ok(!deletes.includes(id), `id ${id} must not be deleted`);
    const unmanaged = p.unmanaged.map((u) => `${u.section}:${String(u.id)}`);
    for (const u of ['locations:4', 'tariffs:8', 'stations:12'])
      assert.ok(unmanaged.includes(u), u);
  });

  it('flags a rating change under an open session and a password on a connected station', async () => {
    const r = await plan(FILE, ['--json']);
    const p = JSON.parse(r.out.text) as PlanJson;
    const risks = p.entries.find((e) => e.key === 'cp-01')?.risks ?? [];
    assert.ok(risks.some((x) => /rating change on a station with a session in progress/.test(x)));
    assert.ok(risks.some((x) => /charger command.*7\.2.*stations:admin/.test(x)));
    // No open session: no rating risk.
    routes = { ...MIXED, '/v1/tenants/42/transactions': { data: [], next_cursor: null } };
    const q = JSON.parse((await plan(FILE, ['--json'])).out.text) as PlanJson;
    const r2 = q.entries.find((e) => e.key === 'cp-01')?.risks ?? [];
    assert.ok(!r2.some((x) => /session in progress/.test(x)));
    // Transactions not readable by this key: said so, not guessed.
    routes = { ...MIXED, '/v1/tenants/42/transactions': status(403) };
    const n = JSON.parse((await plan(FILE, ['--json'])).out.text) as PlanJson;
    assert.ok(n.notes.some((x) => /open sessions not checked.*403/.test(x)));
  });

  it('tolerates a 403/404 tax read for that field only', async () => {
    const file = FILE.replace(
      '  site-1: { name: Site 1, city: New City, country: USA }',
      '  site-1: { name: Site 1, city: New City, country: USA }\n' +
        '  gone: { name: Old site, tax: { price_mode: tax_exclusive, lines: [{ name: VAT, type: percent, rate: "20" }] } }',
    );
    const r = await plan(file, ['--json']);
    assert.equal(r.code, ExitCode.Ok, r.err.text);
    const p = JSON.parse(r.out.text) as PlanJson;
    assert.equal(p.entries.find((e) => e.key === 'gone')?.action, 'no-op');
    assert.ok(
      p.notes.some((x) => /locations\.gone\.tax: not compared; the API answered 403/.test(x)),
    );
    // Any other failure still ends the plan.
    routes = { ...MIXED, '/v1/tenants/42/locations/1/tax': status(500) };
    assert.notEqual((await plan(FILE)).code, ExitCode.Ok);
  });

  it('plans a file written by the real ivora export as no changes', async () => {
    routes = MANAGED;
    const exported = await exportFile();
    // Only GET requests on the way out too.
    assert.deepEqual(
      seen.filter((q) => q.method !== 'GET'),
      [],
    );
    const r = await plan(exported, ['--json']);
    assert.equal(r.code, ExitCode.Ok, r.err.text);
    const p = JSON.parse(r.out.text) as PlanJson;
    assert.deepEqual(p.summary, { create: 0, update: 0, delete: 0, 'no-op': 5 });
    assert.deepEqual(
      p.entries.filter((e) => e.changes.length > 0),
      [],
    );
    assert.deepEqual(p.unmanaged, []);
    const text = await plan(exported);
    assert.match(text.out.text, /0 to create, 0 to update, 0 to delete, 5 unchanged/);
  });

  it('is read-only: only GET requests, never a charger or admin path', async () => {
    await plan(FILE);
    assert.ok(seen.length > 0);
    assert.ok(
      seen.every((q) => q.method === 'GET'),
      JSON.stringify(seen),
    );
    assert.ok(seen.every((q) => !/control|admin|reset|unlock|remote/.test(q.path)));
  });

  it('errors instead of truncating a collection longer than MAX_PAGES', async () => {
    endless = true;
    const r = await plan(FILE);
    assert.equal(r.code, ExitCode.ApiError);
    assert.match(r.err.text, /more than 10000 entries/);
    assert.equal(seen.filter((q) => q.path === '/v1/tenants/42/locations').length, MAX_PAGES);
  });

  it('prints text with the skip reason, power status and the 2.1 checks not done', async () => {
    const r = await plan(FILE.replace(/load_groups:[\s\S]*?stations: \[cp-01\]\n/, ''));
    assert.equal(r.code, ExitCode.Ok);
    assert.match(r.out.text, /Read-only: nothing was changed/);
    assert.match(r.out.text, /skipped roaming_partners: needs a signed-in admin/);
    assert.match(r.out.text, /Site power impact:\n {2}not available/);
    assert.match(r.out.text, /not checked yet \(design 2\.1\):/);
    for (const c of [
      'rating consistency',
      'parent/child sums',
      'fail-safe',
      'transformer',
      'NEC 625.42',
    ])
      assert.ok(r.out.text.includes(c), c);
    assert.match(r.out.text, /Adopt hints \(proposals only/);
    const j = JSON.parse((await plan(FILE, ['--json'])).out.text) as PlanJson;
    assert.equal(j.power.available, true);
    assert.equal(j.power.groups[0]?.status, 'over');
    assert.equal(j.power.groups[0]?.limit_w, 69282); // 100 A x 400 V x sqrt(3)
    assert.equal(j.power.not_checked.length, 5);
  });

  it('converts A to W with the line-to-line factor for 1, 2 and 3 phases', () => {
    assert.equal(phaseFactor(1), 1);
    assert.equal(phaseFactor(2), 1);
    assert.equal(phaseFactor(3), Math.sqrt(3));
    const a = { value: 40, unit: 'A' };
    assert.equal(toWatts(a, { voltage_v: 240, phases: 2 }), 9600); // split-phase 240 V
    assert.equal(toWatts(a, { voltage_v: 230, phases: 1 }), 9200);
    assert.equal(toWatts(a, { voltage_v: 480, phases: 3 }), 33255);
  });

  it('refuses another project, a non-numeric project and an invalid file, reading nothing', async () => {
    const other = await plan(FILE.replace('proj_42', 'proj_99'));
    assert.equal(other.code, ExitCode.Usage);
    assert.match(other.err.text, /project proj_99/);
    assert.ok(seen.every((q) => q.path === '/v1/access'));
    const named = await plan(FILE.replace('proj_42', 'proj_example'));
    assert.equal(named.code, ExitCode.Usage);
    assert.match(named.err.text, /"proj_example" is not a project id/);
    assert.equal(seen.length, 0);
    const bad = await plan('version: 1\nproject: proj_42\nstations:\n  a: { name: TODO }\n');
    assert.equal(bad.code, ExitCode.Usage);
    assert.equal(seen.length, 0, 'an invalid file reads nothing');
  });
});

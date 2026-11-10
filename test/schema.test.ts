import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { REQUEST_BODIES } from '../src/schema/generated.js';
import { buildSchema } from '../src/schema/index.js';
import { checkSchema } from '../src/schema/json-schema.js';
import { validateText } from '../src/schema/document.js';
import {
  extractRequestBodies,
  sourceOperationIds,
  specOperationIds,
} from '../src/schema/sources.js';

const root = new URL('../../', import.meta.url);
const read = (p: string): string => readFileSync(new URL(p, root), 'utf8');
const spec = JSON.parse(read('openapi/v1.json')) as Parameters<typeof specOperationIds>[0];
const pinned = JSON.parse(read('openapi/operation-ids.json')) as Record<string, string>;

describe('schema sources (vendored /v1 OpenAPI)', () => {
  it('records where the vendored spec came from', () => {
    const source = JSON.parse(read('openapi/SOURCE.json')) as Record<string, unknown>;
    assert.equal(source['source'], 'https://api.ivoracharge.co/openapi.json');
    assert.match(String(source['fetched']), /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(source['operations'], Object.keys(specOperationIds(spec)).length);
  });

  it('matches the pinned operation-id snapshot: a renamed operation breaks the build', () => {
    assert.deepEqual(specOperationIds(spec), pinned);
    const renamed = JSON.parse(
      JSON.stringify(spec).replaceAll('"locations_read_one_location"', '"locations_get_location"'),
    ) as typeof spec;
    assert.notDeepEqual(specOperationIds(renamed), pinned);
  });

  it('uses only operationIds in the pinned snapshot, covering every 1.2 section', () => {
    const ids = new Set(Object.values(pinned));
    for (const id of sourceOperationIds()) assert.ok(ids.has(id), `${id} is not in the snapshot`);
    assert.ok(sourceOperationIds().length >= 40);
  });

  it('fails generation when a source operation is renamed', () => {
    const renamed = JSON.parse(
      JSON.stringify(spec).replaceAll('stations_register_a', 'stations_add_a'),
    ) as typeof spec;
    assert.throws(() => extractRequestBodies(renamed), /has no JSON request body/);
  });

  it('keeps the committed generated schemas current', () => {
    const fresh = extractRequestBodies(spec);
    if (process.env['UPDATE_SCHEMA'] === '1') {
      const file = new URL('src/schema/generated.ts', root);
      const head = readFileSync(file, 'utf8').split('export const')[0] ?? '';
      writeFileSync(
        file,
        `${head}export const REQUEST_BODIES: RequestBodySchemas = ${JSON.stringify(fresh, null, 2)};\n`,
      );
      return;
    }
    assert.deepEqual(REQUEST_BODIES, fresh, 'run the tests with UPDATE_SCHEMA=1, then format');
  });

  it('builds the 1.1 shape: maps keyed by local key, generated and hand-written parts', () => {
    const schema = buildSchema();
    const p = schema.properties ?? {};
    for (const k of [
      'version',
      'project',
      'locations',
      'stations',
      'tariffs',
      'default_tariff',
      'load_groups',
      'grid',
      'ocpi_publishing',
      'webhooks',
      'displays',
      'migration',
      'roaming_partners',
      'apps',
    ]) {
      assert.ok(p[k], k);
    }
    const station = p['stations']?.additionalProperties as typeof schema;
    assert.equal(p['stations']?.type, 'object', 'a map, not an array');
    assert.ok(station.properties?.['charger_id'], 'from StationInput');
    assert.ok(station.properties?.['credentials'], 'hand-written secret reference');
    assert.ok(!station.properties?.['location_id'], 'replaced by the local key `location`');
    const tariff = p['tariffs']?.additionalProperties as typeof schema;
    assert.ok(tariff.properties?.['authorization_minor'], 'from TariffInput');
    assert.ok(p['locations']?.additionalProperties, 'from LocationInput');
  });

  it('documents roaming_partners and apps with a skip marker (decision D4)', () => {
    const p = buildSchema().properties ?? {};
    for (const k of ['roaming_partners', 'apps']) {
      assert.match(String(p[k]?.description), /signed-in/i);
      const skip = p[k]?.['x-ivora-skip'] as { decision?: string } | undefined;
      assert.equal(skip?.decision, 'D4');
    }
  });
});

describe('json schema subset', () => {
  it('checks types, required, unknown fields, anyOf alongside other keywords', () => {
    const s = {
      type: 'object',
      required: ['a'],
      additionalProperties: false,
      anyOf: [{ required: ['b'] }, { required: ['c'] }],
      properties: { a: { type: 'integer', exclusiveMinimum: 0 }, b: {}, c: {} },
    };
    assert.deepEqual(checkSchema({ a: 1, b: 1 }, s), []);
    assert.equal(checkSchema({ a: 1.5, b: 1 }, s).length, 1);
    assert.equal(checkSchema({ a: 0, b: 1 }, s).length, 1);
    assert.equal(checkSchema({ a: 1 }, s)[0]?.message, 'is required');
    assert.equal(checkSchema({ a: 1, b: 1, d: 2 }, s)[0]?.path, 'd');
    const map = { type: 'object', propertyNames: { pattern: '^[a-z]+$' } };
    assert.match(checkSchema({ 'Bad Key': 1 }, map)[0]?.message ?? '', /^key /);
  });
});

const fixture = (name: string): string => read(`test/fixtures/site-as-code/${name}`);
const DESIGN = fixture('design-1.1.yaml');

describe('the design examples pass', () => {
  it('1.1: the full project file, admin sections skipped', () => {
    const r = validateText(DESIGN);
    assert.deepEqual(r.issues, []);
    assert.deepEqual(
      r.skipped.map((s) => s.section),
      ['roaming_partners', 'apps'],
    );
    assert.match(r.skipped[0]?.reason ?? '', /signed-in admin.*D4/);
  });

  it('5.8: the migration worked example', () => {
    assert.deepEqual(validateText(fixture('design-5.8.yaml')).issues, []);
  });

  it('5.2: the migration section', () => {
    assert.deepEqual(validateText(fixture('migration-5.2.yaml')).issues, []);
  });
});

const paths = (text: string): string[] => validateText(text).issues.map((i) => i.path);

describe('validateText', () => {
  it('rejects placeholders and empty values', () => {
    const r = validateText(
      DESIGN.replace('name: Site 1', 'name: TODO')
        .replace('address: 1 Example Street', 'address: "<street>"')
        .replace('city: Example City', 'city: ""'),
    );
    const got = new Set(r.issues.map((i) => i.path));
    for (const p of ['locations.site-1.name', 'locations.site-1.address', 'locations.site-1.city'])
      assert.ok(got.has(p), p);
    const m = fixture('design-5.8.yaml').replace('/example/ocpp', '"<incumbent path>"');
    assert.ok(paths(m).includes('migration.source.path'));
    const empty = fixture('design-5.8.yaml').replace('/example/ocpp', '""');
    assert.ok(paths(empty).includes('migration.source.path'));
  });

  it('rejects null values', () => {
    assert.ok(validateText('version: 1\nproject: p\nstations:\n').issues.length > 0);
  });

  it('rejects a literal station password and never echoes it', () => {
    const text = DESIGN.replace(
      '{ secret: env:IVORA_CP01_PASSWORD }',
      '{ secret: hunter2-hunter2 }',
    );
    const r = validateText(text);
    assert.ok(r.issues.some((i) => i.path === 'stations.cp-01.credentials.secret'));
    assert.ok(!JSON.stringify(r).includes('hunter2'), 'values are not echoed');
    const inline = DESIGN.replace(
      '    credentials:',
      '    password: s3cret-value\n    credentials:',
    );
    const r2 = validateText(inline);
    assert.ok(r2.issues.some((i) => i.path === 'stations.cp-01.password'));
    assert.ok(!JSON.stringify(r2).includes('s3cret'), 'values are not echoed');
  });

  it('accepts env: and file: references only', () => {
    const ok = DESIGN.replace('env:IVORA_CP01_PASSWORD', '"file:./secrets/cp-01"');
    assert.deepEqual(validateText(ok).issues, []);
    for (const bad of ['"env:1BAD"', '"vault:cp-01"', '"file:"']) {
      const t = DESIGN.replace('env:IVORA_CP01_PASSWORD', bad);
      assert.ok(paths(t).includes('stations.cp-01.credentials.secret'), bad);
    }
  });

  it('applies the money rules: quoted decimal prices, integer minor units', () => {
    assert.ok(
      paths(DESIGN.replace("price: '0.45'", 'price: 0.45')).length > 0,
      'YAML number price',
    );
    assert.ok(paths(DESIGN.replace("price: '0.45'", 'price: "0.45001"')).length > 0, '5 places');
    assert.ok(paths(DESIGN.replace("price: '0.45'", 'price: "10001"')).length > 0, 'over 10000');
    assert.ok(
      paths(DESIGN.replace('authorization_minor: 5000 #', 'authorization_minor: "5000" #')).length >
        0,
    );
    assert.ok(
      paths(DESIGN.replace('authorization_minor: 5000 #', 'authorization_minor: 50.5 #')).length >
        0,
    );
    const perKwh = (rate: string): string =>
      DESIGN.replace('type: percent, rate: 7.25', `type: per_kwh, rate: ${rate}`);
    assert.deepEqual(validateText(perKwh('"2.6"')).issues, []);
    assert.ok(paths(perKwh('2.6')).includes('locations.site-1.tax.lines[0].rate'));
  });

  it('checks local-key references between sections', () => {
    const cases: [string, string, string][] = [
      [
        'location: site-1\n    charger_id',
        'location: site-9\n    charger_id',
        'stations.cp-01.location',
      ],
      ['default_tariff: standard', 'default_tariff: premium', 'locations.site-1.default_tariff'],
      ['tariff: fast', 'tariff: slow', 'stations.cp-01.evses.1.connectors.1.tariff'],
      ['parent: site-1-main', 'parent: site-2-main', 'load_groups.site-1-bay-a.parent'],
      ['stations: [cp-01]', 'stations: [cp-02]', 'load_groups.site-1-bay-a.stations[0]'],
      [
        'grid: # declared here, enforced by the platform\n  site-1:',
        'grid:\n  site-2:',
        'grid.site-2',
      ],
      ['  cp-01: { running_cost: true }', '  cp-09: { running_cost: true }', 'displays.cp-09'],
    ];
    for (const [from, to, path] of cases) {
      const t = DESIGN.replace(from, to);
      assert.notEqual(t, DESIGN, from);
      assert.ok(paths(t).includes(path), path);
    }
    const m = fixture('design-5.8.yaml').replace('chargers: [lab-fk-03]', 'chargers: [lab-fk-99]');
    assert.ok(paths(m).includes('migration.batches.canary.chargers[0]'));
  });

  it('keeps stations on leaf load groups and needs a location or parent', () => {
    const notLeaf = DESIGN.replace(
      '    mode: dynamic\n',
      '    mode: dynamic\n    stations: [cp-01]\n',
    );
    assert.ok(validateText(notLeaf).issues.some((i) => /leaf groups/.test(i.message)));
    const orphan = DESIGN.replace('    parent: site-1-main\n', '');
    assert.ok(paths(orphan).some((p) => p.startsWith('load_groups.site-1-bay-a')));
    assert.ok(
      paths(DESIGN.replace('unit: kVA', 'unit: MW')).includes('grid.site-1.transformer_limit.unit'),
    );
  });

  it('rejects arrays where the file takes maps, unknown sections and a wrong version', () => {
    assert.ok(paths('version: 1\nproject: p\nstations:\n  - charger_id: A\n').includes('stations'));
    assert.ok(paths(DESIGN + 'widgets: []\n').includes('widgets'));
    assert.ok(paths(DESIGN.replace('version: 1', 'version: 2')).includes('version'));
    assert.ok(paths(DESIGN.replace(/^project: .*$/m, '')).includes('project'));
  });

  it('skips admin sections with a reason and does not check them', () => {
    const r = validateText(DESIGN.replace('switches: {}', 'switches: TODO'));
    assert.deepEqual(r.issues, []);
  });

  it('reports YAML errors, duplicate keys and non-mappings', () => {
    assert.ok(validateText('a: [').issues[0]?.message.startsWith('YAML'));
    assert.ok(validateText('version: 1\nversion: 1\n').issues.length > 0);
    assert.ok(validateText('- 1\n').issues.length > 0);
  });
});

describe('file: secret references on disk (design 1.3, 5.8)', () => {
  let dir: string;
  const git = (cwd: string, ...args: string[]): void => {
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], {
      cwd,
      stdio: 'ignore',
    });
  };
  const fileRef = (ref: string): string =>
    DESIGN.replace('env:IVORA_CP01_PASSWORD', JSON.stringify(`file:${ref}`));

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'ivora-secrets-'));
    mkdirSync(join(dir, 'repo'));
    git(join(dir, 'repo'), 'init', '-q');
    writeFileSync(join(dir, 'repo', '.gitignore'), 'secrets/\n');
    mkdirSync(join(dir, 'repo', 'secrets'));
    mkdirSync(join(dir, 'home', 'secrets'), { recursive: true });
    for (const f of ['repo/secrets/cp-01', 'repo/cp-01', 'home/secrets/cp-01', 'home/open']) {
      writeFileSync(join(dir, f), 'not-read');
      chmodSync(join(dir, f), 0o600);
    }
    chmodSync(join(dir, 'home/open'), 0o644);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  const check = (ref: string) =>
    validateText(fileRef(ref), { baseDir: join(dir, 'repo'), homeDir: join(dir, 'home') });

  it('accepts a mode-600 file outside a work tree or ignored by git', () => {
    assert.deepEqual(check('~/secrets/cp-01').issues, []);
    assert.deepEqual(check('secrets/cp-01').issues, []);
  });

  it('refuses a file in a git work tree that git does not ignore', () => {
    const r = check('./cp-01');
    assert.match(r.issues[0]?.message ?? '', /git work tree/);
    assert.equal(r.issues[0]?.path, 'stations.cp-01.credentials.secret');
  });

  it('refuses a file that is not mode 600', { skip: process.platform === 'win32' }, () => {
    assert.match(check('~/open').issues[0]?.message ?? '', /mode 600 \(it is 644\)/);
  });

  it('warns, without failing, when the file does not exist yet', () => {
    const r = check('~/secrets/missing');
    assert.deepEqual(r.issues, []);
    assert.match(r.warnings[0]?.message ?? '', /does not exist/);
  });
});

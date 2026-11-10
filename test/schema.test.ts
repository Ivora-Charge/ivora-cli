import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { REQUEST_BODIES } from '../src/schema/generated.js';
import { buildSchema } from '../src/schema/index.js';
import { checkSchema } from '../src/schema/json-schema.js';
import { validateText } from '../src/schema/document.js';
import { SCHEMA_SOURCES, extractRequestBodies, specOperationIds } from '../src/schema/sources.js';
import { loadSpec } from './mock-server.js';

const root = new URL('../../', import.meta.url);
const spec = loadSpec();

describe('schema sources', () => {
  it('pins the OpenAPI operation ids: a renamed operation breaks the build', () => {
    const pinned = JSON.parse(
      readFileSync(new URL('test/fixtures/operation-ids.json', root), 'utf8'),
    ) as string[];
    assert.deepEqual(specOperationIds(spec), pinned);
  });

  it('records only operationIds that exist in the pinned snapshot', () => {
    const pinned = JSON.parse(
      readFileSync(new URL('test/fixtures/operation-ids.json', root), 'utf8'),
    ) as string[];
    for (const id of Object.values(SCHEMA_SOURCES)) assert.ok(pinned.includes(id), id);
  });

  it('detects a renamed source operation', () => {
    const renamed = JSON.parse(
      JSON.stringify(spec).replaceAll('stations_register_a', 'stations_add_a'),
    );
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
    assert.deepEqual(REQUEST_BODIES, fresh, 'run the tests with UPDATE_SCHEMA=1 and format');
  });

  it('builds the schema with generated and hand-written parts', () => {
    const schema = buildSchema();
    const keys = Object.keys(schema.properties ?? {});
    for (const k of ['stations', 'load_groups', 'grid_limits', 'migration', 'version']) {
      assert.ok(keys.includes(k), k);
    }
    const station = schema.properties?.['stations']?.items;
    assert.ok(station?.properties?.['charger_id'], 'from the request body');
    assert.ok(station?.properties?.['password'], 'hand-written secret ref');
  });
});

describe('json schema subset', () => {
  it('checks types, required and unknown fields', () => {
    const s = {
      type: 'object',
      required: ['a'],
      additionalProperties: false,
      properties: { a: { type: 'integer' } },
    };
    assert.deepEqual(checkSchema({ a: 1 }, s), []);
    assert.equal(checkSchema({ a: 1.5 }, s).length, 1);
    assert.equal(checkSchema({}, s)[0]?.message, 'is required');
    assert.equal(checkSchema({ a: 1, b: 2 }, s)[0]?.path, 'b');
  });
});

const GOOD = `
version: 1
stations:
  - charger_id: CP-001
    name: Bay 1
    password:
      secret_ref: env:CP_001_PW
load_groups:
  - name: depot
    stations: [CP-001]
    max_power_kw: 50
grid_limits:
  - location: main
    max_power_kw: 100
migration:
  source: { kind: csv, path: ./old.csv }
`;

describe('validateText', () => {
  it('accepts a valid file', () => {
    assert.deepEqual(validateText(GOOD), { issues: [], skipped: [] });
  });

  it('rejects placeholders and empty values', () => {
    const r = validateText(
      GOOD.replace('Bay 1', 'TODO').replace('./old.csv', '""').replace('main', '<location>'),
    );
    const paths = r.issues.map((i) => i.path).sort();
    assert.deepEqual(
      paths,
      [
        'grid_limits[0].location',
        'migration.source.path',
        'migration.source.path',
        'stations[0].name',
      ].sort(),
    );
  });

  it('rejects null values', () => {
    assert.ok(validateText('version: 1\nstations:\n').issues.length > 0);
  });

  it('rejects a plain-text station password', () => {
    const r = validateText('version: 1\nstations:\n  - charger_id: A\n    password: hunter2\n');
    assert.ok(r.issues.some((i) => i.path === 'stations[0].password'));
    assert.ok(!JSON.stringify(r).includes('hunter2'), 'values are not echoed');
  });

  it('rejects bad secret refs, unknown sections and wrong version', () => {
    assert.ok(validateText(GOOD.replace('env:CP_001_PW', 'literal')).issues.length > 0);
    assert.ok(validateText(GOOD + 'widgets: []\n').issues.some((i) => i.path === 'widgets'));
    assert.ok(validateText(GOOD.replace('version: 1', 'version: 2')).issues.length > 0);
  });

  it('skips admin sections with a reason and does not check them', () => {
    const r = validateText(GOOD + 'roaming_partners:\n  - TODO\napps: []\n');
    assert.deepEqual(r.issues, []);
    assert.deepEqual(
      r.skipped.map((s) => s.section),
      ['roaming_partners', 'apps'],
    );
    assert.match(r.skipped[0]?.reason ?? '', /admin/);
  });

  it('reports YAML errors, duplicate keys and non-mappings', () => {
    assert.ok(validateText('a: [').issues[0]?.message.startsWith('YAML'));
    assert.ok(validateText('version: 1\nversion: 1\n').issues.length > 0);
    assert.ok(validateText('- 1\n').issues.length > 0);
  });
});

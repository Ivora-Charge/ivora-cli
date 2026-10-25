import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { COMMANDS, checkCatalog, specOperations } from '../src/catalog.js';
import { loadSpec } from './mock-server.js';

describe('command catalog', () => {
  const spec = loadSpec();

  it('maps or excludes every operation in the spec', () => {
    const result = checkCatalog(spec);
    assert.deepEqual(
      result.unlisted,
      [],
      'add these operations to COMMANDS or EXCLUDED in src/catalog.ts',
    );
    assert.deepEqual(result.unknown, [], 'these catalog entries are not in the spec');
    assert.deepEqual(result.staff, []);
  });

  it('fails on a new, unlisted operation', () => {
    const grown = structuredClone(spec);
    grown.paths['/v1/tenants/{tenant_id}/widgets'] = { get: {} };
    assert.deepEqual(checkCatalog(grown).unlisted, ['GET /v1/tenants/{tenant_id}/widgets']);
  });

  it('never maps a staff path to a command', () => {
    assert.deepEqual(
      checkCatalog(spec, [...COMMANDS, { method: 'GET', path: '/v1/admin/example', command: 'x' }])
        .staff,
      ['GET /v1/admin/example'],
    );
    assert.ok(
      specOperations(spec).some((op) => op.path.startsWith('/v1/admin')),
      'fixture keeps a staff path',
    );
  });
});

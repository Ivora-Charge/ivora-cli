// Vendors the published /v1 OpenAPI document into openapi/v1.json and records where it came
// from in openapi/SOURCE.json. The ivora.yaml schema is generated from this copy
// (src/schema/generated.ts, regenerated with `UPDATE_SCHEMA=1 npm test`). Tests never fetch it.
//
// Usage: node scripts/sync-openapi.mjs [url-or-file]
//   default: https://api.ivoracharge.co/openapi.json (the published document)
//
// Kept: the /v1 paths, without the staff-only /v1/admin paths (the CLI never calls them), and
// the components they reference. The operation-id snapshot (openapi/operation-ids.json) is NOT
// rewritten here: it is pinned on purpose, so a renamed operation fails the tests until the
// snapshot is updated in a reviewed change.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const DEFAULT_SOURCE = 'https://api.ivoracharge.co/openapi.json';
const source = process.argv[2] ?? DEFAULT_SOURCE;

const raw = /^https:\/\//.test(source)
  ? await (async () => {
      const res = await fetch(source, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`GET ${source}: HTTP ${res.status}`);
      return res.text();
    })()
  : readFileSync(source, 'utf8');
const spec = JSON.parse(raw);

const keep = (path) => path.startsWith('/v1/') && !path.startsWith('/v1/admin');
const paths = Object.fromEntries(Object.entries(spec.paths ?? {}).filter(([p]) => keep(p)));

// Keep only the components reachable (through $ref) from the kept paths.
const all = spec.components ?? {};
const used = new Set();
const visit = (node) => {
  if (Array.isArray(node)) return node.forEach(visit);
  if (node === null || typeof node !== 'object') return;
  const ref = node.$ref;
  const m = typeof ref === 'string' ? /^#\/components\/([^/]+)\/([^/]+)$/.exec(ref) : null;
  if (m && !used.has(ref)) {
    used.add(ref);
    if (all[m[1]]?.[m[2]] === undefined) throw new Error(`unresolved ${ref}`);
    visit(all[m[1]][m[2]]);
  }
  Object.values(node).forEach(visit);
};
visit(paths);
const components = {};
for (const [kind, entries] of Object.entries(all)) {
  const kept = Object.entries(entries).filter(([n]) => used.has(`#/components/${kind}/${n}`));
  if (kept.length > 0) components[kind] = Object.fromEntries(kept);
}
const vendored = { openapi: spec.openapi, info: spec.info, paths, components };

writeFileSync('openapi/v1.json', JSON.stringify(vendored, null, 2) + '\n');
const operations = Object.values(paths).flatMap((item) =>
  Object.values(item).filter((op) => op && typeof op.operationId === 'string'),
).length;
writeFileSync(
  'openapi/SOURCE.json',
  JSON.stringify(
    {
      source: /^https:\/\//.test(source) ? source : DEFAULT_SOURCE,
      fetched: new Date().toISOString().slice(0, 10),
      info_version: spec.info?.version ?? null,
      source_sha256: createHash('sha256').update(raw).digest('hex'),
      filter: '/v1 paths without /v1/admin; the components they reference',
      operations,
    },
    null,
    2,
  ) + '\n',
);
console.log(`openapi/v1.json: ${operations} operations, ${used.size} components`);

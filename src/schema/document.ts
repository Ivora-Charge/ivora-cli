import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { buildSchema } from './index.js';
import { checkSchema, type SchemaIssue } from './json-schema.js';
import { ADMIN_SECTIONS, SECRET_REF_PATTERN } from './handwritten.js';

export interface ValidationResult {
  issues: SchemaIssue[];
  /** Things worth knowing that do not make the file invalid. */
  warnings: SchemaIssue[];
  /** Sections present in the file but not checked, with the reason. */
  skipped: { section: string; reason: string }[];
}

export interface ValidateOptions {
  /**
   * The directory of the ivora.yaml file. When set, `file:` secret references are checked on
   * disk (design 1.3): mode 600, and not inside a git work tree unless git ignores them. The
   * secret file is never read.
   */
  baseDir?: string;
  /** The directory `~/` expands to in a `file:` reference. */
  homeDir?: string;
}

const PLACEHOLDER = /\bTODO\b|<[^<>]*>/i;
const SECRET_KEY = /(^|_)(password|passphrase|secret|token|api_?key|private_?key)$/i;
const SECRET_REF = new RegExp(SECRET_REF_PATTERN, 'u');

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const entries = (v: unknown): [string, unknown][] => (isObj(v) ? Object.entries(v) : []);

function child(path: string, key: string | number): string {
  return typeof key === 'number' ? `${path}[${key}]` : path ? `${path}.${key}` : key;
}

/** Placeholder values (TODO, <...>, empty values) and inline secrets are errors. */
function scan(node: unknown, path: string, issues: SchemaIssue[]): void {
  if (node === null || node === undefined) {
    issues.push({ path, message: 'is empty (placeholder)' });
  } else if (typeof node === 'string') {
    if (node.trim() === '') issues.push({ path, message: 'is empty (placeholder)' });
    else if (PLACEHOLDER.test(node))
      issues.push({ path, message: 'is a placeholder (TODO or <...>); fill it in' });
  } else if (Array.isArray(node)) {
    node.forEach((n, i) => scan(n, child(path, i), issues));
  } else if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string' && SECRET_KEY.test(k) && v.trim() !== '' && !SECRET_REF.test(v)) {
        issues.push({
          path: child(path, k),
          message:
            'secrets are references only, never values; use { secret: "env:NAME" } or "file:path"',
        });
      }
      scan(v, child(path, k), issues);
    }
  }
}

/** Local-key references between sections, money rules and load-group structure. */
function crossCheck(doc: Obj, issues: SchemaIssue[]): void {
  const keys = (section: unknown): Set<string> => new Set(entries(section).map(([k]) => k));
  const locations = keys(doc['locations']);
  const stations = keys(doc['stations']);
  const tariffs = keys(doc['tariffs']);
  const groups = keys(doc['load_groups']);
  const migration = isObj(doc['migration']) ? doc['migration'] : {};
  const batches = keys(migration['batches']);

  const ref = (value: unknown, known: Set<string>, kind: string, path: string): void => {
    if (typeof value === 'string' && !known.has(value)) {
      issues.push({
        path,
        message: `refers to ${kind} "${value}", which the file does not declare`,
      });
    }
  };
  const refs = (value: unknown, known: Set<string>, kind: string, path: string): void => {
    if (Array.isArray(value)) value.forEach((v, i) => ref(v, known, kind, child(path, i)));
  };
  const tariffRef = (value: unknown, path: string): void => {
    if (isObj(value)) ref(value['tariff'], tariffs, 'tariff', child(path, 'tariff'));
    else ref(value, tariffs, 'tariff', path);
  };

  tariffRef(doc['default_tariff'], 'default_tariff');
  for (const [k, loc] of entries(doc['locations'])) {
    const p = child('locations', k);
    if (!isObj(loc)) continue;
    tariffRef(loc['default_tariff'], child(p, 'default_tariff'));
    const tax = loc['tax'];
    if (isObj(tax) && Array.isArray(tax['lines'])) {
      tax['lines'].forEach((line, i) => {
        if (!isObj(line)) return;
        const rp = child(child(child(p, 'tax'), 'lines'), i);
        const rate = line['rate'];
        if (line['type'] === 'per_kwh' && typeof rate === 'number') {
          issues.push({
            path: child(rp, 'rate'),
            message:
              'a per_kwh rate is money (minor units per kWh): write it as a quoted decimal string',
          });
        } else if (typeof rate === 'string') {
          const max = line['type'] === 'per_kwh' ? 1000 : 100;
          if (Number(rate) > max)
            issues.push({ path: child(rp, 'rate'), message: `must be <= ${max}` });
        }
      });
    }
  }

  for (const [k, st] of entries(doc['stations'])) {
    const p = child('stations', k);
    if (!isObj(st)) continue;
    ref(st['location'], locations, 'location', child(p, 'location'));
    for (const [e, evse] of entries(st['evses'])) {
      const ep = child(child(p, 'evses'), e);
      for (const [c, conn] of entries(isObj(evse) ? evse['connectors'] : undefined)) {
        if (isObj(conn)) {
          ref(
            conn['tariff'],
            tariffs,
            'tariff',
            child(child(child(ep, 'connectors'), c), 'tariff'),
          );
        }
      }
    }
  }

  for (const [k, t] of entries(doc['tariffs'])) {
    const p = child('tariffs', k);
    const elements = isObj(t) ? t['elements'] : undefined;
    if (!Array.isArray(elements)) continue;
    elements.forEach((el, i) => {
      const pcs = isObj(el) ? el['price_components'] : undefined;
      if (!Array.isArray(pcs)) return;
      pcs.forEach((pc, j) => {
        if (isObj(pc) && typeof pc['price'] === 'string' && Number(pc['price']) > 10000) {
          const pp = child(child(child(child(p, 'elements'), i), 'price_components'), j);
          issues.push({ path: child(pp, 'price'), message: 'must be <= 10000' });
        }
      });
    });
  }

  // Load groups: references, one parent chain without cycles, stations on leaf groups only.
  const parentOf = new Map<string, string>();
  const groupOfStation = new Map<string, string>();
  for (const [k, g] of entries(doc['load_groups'])) {
    const p = child('load_groups', k);
    if (!isObj(g)) continue;
    ref(g['location'], locations, 'location', child(p, 'location'));
    ref(g['parent'], groups, 'load group', child(p, 'parent'));
    if (typeof g['parent'] === 'string') parentOf.set(k, g['parent']);
    refs(g['stations'], stations, 'station', child(p, 'stations'));
    if (Array.isArray(g['stations'])) {
      for (const s of g['stations']) {
        if (typeof s !== 'string') continue;
        const other = groupOfStation.get(s);
        if (other !== undefined && other !== k) {
          issues.push({
            path: child(p, 'stations'),
            message: `station "${s}" is also in load group "${other}"`,
          });
        }
        groupOfStation.set(s, k);
      }
    }
  }
  for (const k of parentOf.keys()) {
    const seen = new Set([k]);
    for (let at = parentOf.get(k); at !== undefined; at = parentOf.get(at)) {
      if (seen.has(at)) {
        issues.push({
          path: child(child('load_groups', k), 'parent'),
          message: 'load groups form a cycle',
        });
        break;
      }
      seen.add(at);
    }
  }
  const parents = new Set(parentOf.values());
  for (const [k, g] of entries(doc['load_groups'])) {
    if (isObj(g) && Array.isArray(g['stations']) && parents.has(k)) {
      issues.push({
        path: child(child('load_groups', k), 'stations'),
        message: 'stations sit on leaf groups only; this group has child groups',
      });
    }
  }

  for (const [k, site] of entries(doc['grid'])) {
    const p = child('grid', k);
    if (!locations.has(k)) {
      issues.push({
        path: p,
        message: `refers to location "${k}", which the file does not declare`,
      });
    }
    const signals = isObj(site) ? site['signals'] : undefined;
    if (Array.isArray(signals)) {
      signals.forEach((s, i) => {
        if (isObj(s))
          ref(
            s['load_group'],
            groups,
            'load group',
            child(child(child(p, 'signals'), i), 'load_group'),
          );
      });
    }
  }

  const ocpi = doc['ocpi_publishing'];
  if (isObj(ocpi)) {
    refs(ocpi['excluded_locations'], locations, 'location', 'ocpi_publishing.excluded_locations');
  }
  for (const [k, w] of entries(doc['webhooks'])) {
    if (isObj(w)) refs(w['stations'], stations, 'station', child(child('webhooks', k), 'stations'));
  }
  for (const [k, d] of entries(doc['displays'])) {
    const p = child('displays', k);
    if (!stations.has(k)) {
      issues.push({
        path: p,
        message: `refers to station "${k}", which the file does not declare`,
      });
    }
    for (const [e, qr] of entries(isObj(d) ? d['qr'] : undefined)) {
      if (isObj(qr))
        ref(qr['tariff'], tariffs, 'tariff', child(child(child(p, 'qr'), e), 'tariff'));
    }
  }

  for (const [k, b] of entries(migration['batches'])) {
    if (isObj(b))
      refs(b['chargers'], stations, 'station', child(child('migration.batches', k), 'chargers'));
  }
  const rollback = migration['rollback_point'];
  if (isObj(rollback)) ref(rollback['batch'], batches, 'batch', 'migration.rollback_point.batch');
}

/** Every `{secret: ...}` reference in the document, with its path. */
function secretRefs(node: unknown, path: string, out: { path: string; ref: string }[]): void {
  if (Array.isArray(node)) node.forEach((n, i) => secretRefs(n, child(path, i), out));
  else if (isObj(node)) {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'secret' && typeof v === 'string' && SECRET_REF.test(v))
        out.push({ path: child(path, k), ref: v });
      else secretRefs(v, child(path, k), out);
    }
  }
}

/** The git work tree that contains `dir`, or undefined; throws when git cannot run. */
function workTreeOf(dir: string): string | undefined {
  let at = dir;
  while (!existsSync(at) && dirname(at) !== at) at = dirname(at);
  const r = spawnSync(
    'git',
    ['-c', 'core.fsmonitor=false', '-C', at, 'rev-parse', '--show-toplevel'],
    { encoding: 'utf8' },
  );
  if (r.error) throw r.error;
  return r.status === 0 ? r.stdout.trim() : undefined;
}

/**
 * Design 1.3 and 5.8: a `file:` secret must be mode 600, and must not sit inside a git work tree
 * unless git ignores it. Only file metadata is read, never the secret.
 */
function checkSecretFiles(
  doc: Obj,
  opts: Required<ValidateOptions>,
  result: ValidationResult,
): void {
  const found: { path: string; ref: string }[] = [];
  secretRefs(doc, '', found);
  for (const { path, ref } of found) {
    if (!ref.startsWith('file:')) continue;
    const raw = ref.slice('file:'.length);
    const file =
      raw === '~' || raw.startsWith('~/')
        ? join(opts.homeDir, raw.slice(1))
        : isAbsolute(raw)
          ? raw
          : resolve(opts.baseDir, raw);
    let tree: string | undefined;
    try {
      tree = workTreeOf(dirname(file));
    } catch {
      result.warnings.push({
        path,
        message: 'git is not available; the work-tree rule was not checked',
      });
    }
    if (tree !== undefined) {
      const r = spawnSync('git', [
        '-c',
        'core.fsmonitor=false',
        '-C',
        tree,
        'check-ignore',
        '-q',
        '--',
        file,
      ]);
      if (r.status !== 0) {
        result.issues.push({
          path,
          message:
            'the secret file is inside a git work tree and git does not ignore it; move it out ' +
            'of the repository or add it to .gitignore',
        });
      }
    }
    if (!existsSync(file)) {
      result.warnings.push({
        path,
        message: 'the secret file does not exist yet; its mode was not checked',
      });
      continue;
    }
    const st = statSync(file);
    if (!st.isFile()) {
      result.issues.push({ path, message: 'the secret reference must name a regular file' });
    } else if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
      result.issues.push({
        path,
        message: `the secret file must be mode 600 (it is ${(st.mode & 0o777).toString(8)})`,
      });
    }
  }
}

/**
 * Parses and checks ivora.yaml text offline: no network, no credentials, no writes. With
 * `baseDir`, `file:` secret references are also checked on disk (metadata only).
 */
export function validateText(text: string, opts: ValidateOptions = {}): ValidationResult {
  const result: ValidationResult = { issues: [], warnings: [], skipped: [] };
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length > 0) {
    result.issues = doc.errors.map((e) => ({
      path: '',
      message: `YAML: ${e.message.split('\n')[0]}`,
    }));
    return result;
  }
  const value: unknown = doc.toJS({ maxAliasCount: 50 });
  if (!isObj(value)) {
    result.issues.push({ path: '', message: 'must be a mapping with a "version" key' });
    return result;
  }
  const checked: Obj = {};
  for (const [key, v] of Object.entries(value)) {
    const admin = ADMIN_SECTIONS[key];
    if (admin !== undefined) result.skipped.push({ section: key, reason: admin.reason });
    else checked[key] = v;
  }
  result.issues.push(...checkSchema(checked, buildSchema()));
  scan(checked, '', result.issues);
  crossCheck(checked, result.issues);
  if (opts.baseDir !== undefined) {
    checkSecretFiles(
      checked,
      { baseDir: opts.baseDir, homeDir: opts.homeDir ?? homedir() },
      result,
    );
  }
  return result;
}

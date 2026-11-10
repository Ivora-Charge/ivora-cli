/**
 * Pure transforms from /v1 read responses to the ivora.yaml document (site-as-code design 1.1).
 * Nothing here talks to the network.
 *
 * - Every resource is an entry of a keyed map. The key is `metadata["ivora.key"]` when the
 *   resource carries a usable one (design 1.4), otherwise one is generated from its name or id.
 * - References between resources use those local keys, never platform ids.
 * - Secrets are references only (1.3): a station gets `credentials: { secret: "env:NAME" }`, and
 *   no secret value the API returns is ever copied.
 * - Money is a quoted decimal string (tariff prices, tax rates), never a YAML number.
 * - Read-only fields (ids, status, counts, timestamps) are not exported.
 */
import { LOCAL_KEY_PATTERN, SECRET_REF_PATTERN } from '../../schema/handwritten.js';
import { DECIMAL_PATTERN, SCHEMA_VERSION } from '../../schema/index.js';

export type Obj = Record<string, unknown>;
type Id = string | number;

/** Something left out of the file, with the reason; printed to stderr by the command. */
export interface Skip {
  section: string;
  reason: string;
}

/** The metadata key that holds a resource's local key on the platform (design 1.4). */
export const KEY_METADATA = 'ivora.key';

const LOCAL_KEY = new RegExp(LOCAL_KEY_PATTERN, 'u');
const SECRET_REF = new RegExp(SECRET_REF_PATTERN, 'u');
const DECIMAL = new RegExp(DECIMAL_PATTERN, 'u');
const SECRET_KEY = /(^|_)(password|passphrase|secret|token|api_?key|private_?key)$/i;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is Id => typeof v === 'number' || (typeof v === 'string' && v !== '');
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);

/** Drops null, undefined, empty strings and empty arrays or maps: a site file has no blanks. */
export function compact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(compact).filter((v) => v !== undefined);
  }
  if (isObj(value)) {
    const out: Obj = {};
    for (const [k, v] of Object.entries(value)) {
      const c = compact(v);
      if (c === undefined) continue;
      out[k] = c;
    }
    return out;
  }
  return value === null || value === '' ? undefined : value;
}

function nonEmpty(value: unknown): unknown {
  const c = compact(value);
  if (Array.isArray(c) && c.length === 0) return undefined;
  if (isObj(c)) {
    const out: Obj = {};
    for (const [k, v] of Object.entries(c)) {
      const n = nonEmpty(v);
      if (n !== undefined) out[k] = n;
    }
    return Object.keys(out).length === 0 ? undefined : out;
  }
  return c;
}

/** Picks the listed keys, dropping empty values. */
function pick(src: Obj, keys: readonly string[]): Obj {
  const out: Obj = {};
  for (const k of keys) {
    const v = nonEmpty(src[k]);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** A money value as a decimal string ("0.45"): YAML never rounds a string. */
export function decimal(v: unknown): unknown {
  if (typeof v === 'string') return v;
  if (typeof v !== 'number' || !Number.isFinite(v)) return v;
  const plain = String(v);
  if (DECIMAL.test(plain)) return plain;
  // Exponent notation (1e-7) or more than 4 places: the API keeps at most 4.
  return v
    .toFixed(4)
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '');
}

/** An environment-variable name for a secret reference: IVORA_<PARTS>. */
export function envName(...parts: string[]): string {
  const safe = parts
    .join('_')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  return `IVORA_${safe || 'SECRET'}`;
}

function slug(s: unknown): string {
  if (typeof s !== 'string' && typeof s !== 'number') return '';
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56)
    .replace(/-+$/, '');
}

/**
 * Local keys of one section. A resource's `metadata["ivora.key"]` wins when it is a valid,
 * unique key; the rest get a key from `base` (deduplicated with -2, -3, ...).
 */
function assignKeys<T extends Obj>(
  items: T[],
  base: (item: T) => string,
  section: string,
  skip: (s: Skip) => void,
): Map<T, string> {
  const keys = new Map<T, string>();
  const used = new Set<string>();
  for (const item of items) {
    const k = isObj(item.metadata) ? item.metadata[KEY_METADATA] : undefined;
    if (k === undefined) continue;
    if (typeof k === 'string' && LOCAL_KEY.test(k) && !used.has(k)) {
      keys.set(item, k);
      used.add(k);
    } else {
      skip({
        section,
        reason: `${KEY_METADATA} of ${String(item.id)} is not a usable local key (invalid or duplicate); a key was generated`,
      });
    }
  }
  for (const item of items) {
    if (keys.has(item)) continue;
    const b = base(item);
    let k = b;
    for (let n = 2; used.has(k); n++) k = `${b}-${n}`;
    keys.set(item, k);
    used.add(k);
  }
  return keys;
}

/**
 * Metadata as the file declares it: without the local key (the map key carries it) and without
 * any secret-looking entry (a value is never written).
 */
function exportMetadata(meta: unknown, where: string, skip: (s: Skip) => void): unknown {
  if (!isObj(meta)) return undefined;
  const out: Obj = {};
  for (const [k, v] of Object.entries(meta)) {
    if (k === KEY_METADATA) continue;
    if (SECRET_KEY.test(k)) {
      skip({ section: where, reason: `metadata "${k}" looks like a secret and was left out` });
      continue;
    }
    out[k] = v;
  }
  return nonEmpty(out);
}

export interface ExportInput {
  /** The tenant id: the file's `project`. */
  tenant: string;
  scope: 'project' | 'location';
  locations: Obj[];
  /** Active (not archived) tariffs. */
  tariffs: Obj[];
  stations: Obj[];
  /** Location id -> its default tariff id (null when none is set). Absent: not read. */
  locationDefaultTariffs: Map<string, Id | null>;
  /** Location id -> its tax read. Absent: not read. */
  locationTax: Map<string, Obj>;
  /** The project default tariff id, or null when none is set; undefined: not read. */
  projectDefaultTariff?: Id | null;
  /** Station id -> its charger displays. */
  displays: Map<string, Obj[]>;
  /** Station id -> its running-cost setting. */
  runningCost: Map<string, Obj>;
  /** Station id -> its California Pricing price-text setting. */
  pricingText: Map<string, Obj>;
  webhooks?: Obj[];
  ocpi?: Obj;
}

/** Builds the ivora.yaml document. Anything left out is reported through `skip`. */
export function buildDocument(input: ExportInput, skip: (s: Skip) => void): Obj {
  const sid = (v: unknown): string => String(v);

  // Tariffs: in a location export, only the ones that location's resources use.
  const stations = input.stations.filter((st) => {
    if (isId(st.location_id)) return true;
    skip({ section: 'stations', reason: `station ${sid(st.id)} has no location; not exported` });
    return false;
  });
  const usedTariffIds = new Set<string>();
  if (input.scope === 'location') {
    for (const v of input.locationDefaultTariffs.values()) if (isId(v)) usedTariffIds.add(sid(v));
    for (const st of stations)
      for (const c of list(st.connectors))
        if (isId(c.tariff_id)) usedTariffIds.add(sid(c.tariff_id));
    for (const ds of input.displays.values())
      for (const d of ds) if (isId(d.tariff_id)) usedTariffIds.add(sid(d.tariff_id));
  }
  const tariffs =
    input.scope === 'location'
      ? input.tariffs.filter((t) => usedTariffIds.has(sid(t.id)))
      : input.tariffs;

  const tariffKeys = assignKeys(tariffs, (t) => `tariff-${slug(t.id) || 'x'}`, 'tariffs', skip);
  const locationKeys = assignKeys(
    input.locations,
    (l) => slug(l.name) || `location-${slug(l.id)}`,
    'locations',
    skip,
  );
  const stationKeys = assignKeys(
    stations,
    (s) => slug(s.charger_id) || slug(s.name) || `station-${slug(s.id)}`,
    'stations',
    skip,
  );
  const byId = <T extends Obj>(keys: Map<T, string>): Map<string, string> =>
    new Map([...keys].map(([item, key]) => [sid(item.id), key]));
  const tariffKey = byId(tariffKeys);
  const locationKey = byId(locationKeys);
  const stationKey = byId(stationKeys);

  /** A tariff reference by local key, or undefined (reported) when the tariff is not active. */
  const tariffRef = (id: unknown, where: string): string | undefined => {
    if (!isId(id)) return undefined;
    const k = tariffKey.get(sid(id));
    if (k === undefined) {
      skip({
        section: where,
        reason: `tariff ${sid(id)} is not an active tariff of the project; the reference was left out`,
      });
    }
    return k;
  };

  const doc: Obj = { version: SCHEMA_VERSION, project: input.tenant };

  // Locations.
  const locations: Obj = {};
  for (const [l, key] of locationKeys) {
    const where = `locations.${key}`;
    const out = pick(l, [
      'name',
      'address',
      'city',
      'state',
      'country',
      'postal_code',
      'latitude',
      'longitude',
      'time_zone',
      'opening_hours',
      'external_reference',
    ]);
    const meta = exportMetadata(l.metadata, where, skip);
    if (meta !== undefined) out.metadata = meta;
    const def = tariffRef(input.locationDefaultTariffs.get(sid(l.id)), `${where}.default_tariff`);
    if (def !== undefined) out.default_tariff = def;
    const tax = exportTax(input.locationTax.get(sid(l.id)));
    if (tax !== undefined) out.tax = tax;
    locations[key] = out;
  }
  if (Object.keys(locations).length > 0) doc.locations = locations;

  // Stations, with EVSEs and connectors keyed by number.
  const stationsOut: Obj = {};
  for (const [st, key] of stationKeys) {
    const where = `stations.${key}`;
    // With a charger_id the platform derives the connection name (p<tenant>-<charger_id>), so
    // only the charger_id is declared; `name` is declared for global-URL stations only.
    const hasChargerId = typeof st.charger_id === 'string' && st.charger_id !== '';
    const out: Obj = hasChargerId ? { charger_id: st.charger_id } : pick(st, ['name']);
    out.location = locationKey.get(sid(st.location_id));
    if (out.location === undefined) {
      skip({
        section: where,
        reason: `its location ${sid(st.location_id)} is not in the file; not exported`,
      });
      stationKeys.delete(st);
      stationKey.delete(sid(st.id));
      continue;
    }
    Object.assign(out, pick(st, ['external_reference']));
    const meta = exportMetadata(st.metadata, where, skip);
    if (meta !== undefined) out.metadata = meta;
    // The OCPP password is write-only on the API: the file names where it will come from.
    out.credentials = { secret: `env:${envName(key, 'password')}` };
    const evses = exportEvses(st, where, tariffRef, skip);
    if (evses !== undefined) out.evses = evses;
    stationsOut[key] = out;
  }
  if (Object.keys(stationsOut).length > 0) doc.stations = stationsOut;

  // Tariffs (no name on the API: the key is the only handle).
  const tariffsOut: Obj = {};
  for (const [t, key] of tariffKeys) {
    const out = pick(t, [
      'currency',
      'rate_minor_per_kwh',
      'authorization_minor',
      'rate_minor_per_minute',
      'session_fee_minor',
      'external_reference',
      'tariff_alt_text',
      'rules',
      'time_zone',
    ]);
    const elements = exportElements(t.elements);
    if (elements !== undefined) out.elements = elements;
    const meta = exportMetadata(t.metadata, `tariffs.${key}`, skip);
    if (meta !== undefined) out.metadata = meta;
    tariffsOut[key] = out;
  }
  if (Object.keys(tariffsOut).length > 0) doc.tariffs = tariffsOut;

  if (input.scope === 'project') {
    const def = tariffRef(input.projectDefaultTariff, 'default_tariff');
    if (def !== undefined) doc.default_tariff = def;
  }

  if (input.ocpi !== undefined) {
    const ocpi = exportOcpi(input.ocpi, locationKey, skip);
    doc.ocpi_publishing = ocpi;
  }

  if (input.webhooks !== undefined) {
    const webhooks = exportWebhooks(input.webhooks, stationKey, skip);
    if (Object.keys(webhooks).length > 0) doc.webhooks = webhooks;
  }

  // Displays, keyed by station local key.
  const displays: Obj = {};
  for (const [st, key] of stationKeys) {
    const d = exportDisplay(
      input.displays.get(sid(st.id)) ?? [],
      input.runningCost.get(sid(st.id)),
      input.pricingText.get(sid(st.id)),
      `displays.${key}`,
      tariffRef,
    );
    if (d !== undefined) displays[key] = d;
  }
  if (Object.keys(displays).length > 0) doc.displays = displays;

  // Last line of defence: no literal value under a secret-looking key leaves this function.
  return scrubSecrets(doc, '', skip) as Obj;
}

/** Tax lines as the file declares them (rates as decimal strings), or undefined when not set. */
function exportTax(tax: Obj | undefined): Obj | undefined {
  if (tax === undefined || tax.configured === false) return undefined;
  const lines = list(tax.lines).map((line) => {
    const out = pick(line, ['name', 'type']);
    out.rate = decimal(line.rate);
    Object.assign(
      out,
      pick(line, ['order', 'compound', 'excluded_components', 'registration_number']),
    );
    return out;
  });
  const out = pick(tax, ['price_mode']);
  if (lines.length > 0) out.lines = lines;
  else if (typeof tax.preset === 'string' && tax.preset !== '') out.preset = tax.preset;
  else return undefined;
  return out;
}

/** Tariff elements with every price component's price as a decimal string. */
function exportElements(elements: unknown): unknown {
  if (!Array.isArray(elements)) return undefined;
  return nonEmpty(
    elements.map((el) => {
      if (!isObj(el)) return el;
      return {
        ...el,
        price_components: list(el.price_components).map((pc) => ({
          ...pc,
          price: decimal(pc.price),
        })),
      };
    }),
  );
}

function exportEvses(
  st: Obj,
  where: string,
  tariffRef: (id: unknown, where: string) => string | undefined,
  skip: (s: Skip) => void,
): Obj | undefined {
  const evses = new Map<string, Obj>();
  for (const e of list(st.evses)) {
    if (!isId(e.evse_number)) continue;
    evses.set(String(e.evse_number), pick(e, ['physical_reference']));
  }
  for (const c of list(st.connectors)) {
    const n = c.evse_connector_number;
    if (!isId(c.evse_number) || !isId(n)) {
      skip({
        section: where,
        reason: `connector ${String(c.id)} has no EVSE or connector number; not exported`,
      });
      continue;
    }
    const e = String(c.evse_number);
    const evse = evses.get(e) ?? {};
    evses.set(e, evse);
    const connectors = (isObj(evse.connectors) ? evse.connectors : {}) as Obj;
    const out = pick(c, [
      'type',
      'format',
      'power_type',
      'max_power_w',
      'max_amperage_a',
      'max_voltage_v',
    ]);
    const t = tariffRef(c.tariff_id, `${where}.evses.${e}.connectors.${String(n)}.tariff`);
    if (t !== undefined) out.tariff = t;
    connectors[String(n)] = out;
    evse.connectors = connectors;
  }
  if (evses.size === 0) return undefined;
  const sorted = [...evses].sort(([a], [b]) => Number(a) - Number(b));
  return Object.fromEntries(sorted);
}

function exportDisplay(
  list_: Obj[],
  runningCost: Obj | undefined,
  pricingText: Obj | undefined,
  where: string,
  tariffRef: (id: unknown, where: string) => string | undefined,
): Obj | undefined {
  const out: Obj = {};
  const qr: Obj = {};
  for (const d of list_) {
    if (d.deleted === true || d.clear === true || !isId(d.evse_number)) continue;
    const e = String(d.evse_number);
    const entry = pick(d, ['qr', 'show_price', 'visibility']);
    const t = tariffRef(d.tariff_id, `${where}.qr.${e}.tariff`);
    if (t !== undefined) entry.tariff = t;
    qr[e] = entry;
  }
  if (Object.keys(qr).length > 0) out.qr = qr;
  // Only settings someone chose are declared; a platform default stays undeclared.
  if (runningCost?.source === 'manual' && typeof runningCost.enabled === 'boolean') {
    out.running_cost =
      runningCost.enabled && typeof runningCost.interval_seconds === 'number'
        ? { enabled: true, interval_seconds: runningCost.interval_seconds }
        : runningCost.enabled;
  }
  if (pricingText?.source === 'manual' && typeof pricingText.enabled === 'boolean') {
    out.pricing_text = pricingText.enabled;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function exportOcpi(o: Obj, locationKey: Map<string, string>, skip: (s: Skip) => void): Obj {
  const out = pick(o, [
    'publish',
    'display_name',
    'website',
    'time_zone',
    'connector_defaults',
    'audience',
  ]);
  const excluded: string[] = [];
  for (const id of Array.isArray(o.excluded_location_ids) ? o.excluded_location_ids : []) {
    const k = locationKey.get(String(id));
    if (k !== undefined) excluded.push(k);
    else
      skip({
        section: 'ocpi_publishing.excluded_locations',
        reason: `location ${String(id)} is not in the file; left out`,
      });
  }
  if (excluded.length > 0) out.excluded_locations = excluded;
  // The read lists own parties with their review status; the setting takes one.
  const parties = (
    Array.isArray(o.own_party) ? list(o.own_party) : isObj(o.own_party) ? [o.own_party] : []
  )
    .filter((p) => p.status !== 'rejected')
    .map((p) => pick(p, ['country_code', 'party_id']));
  if (parties.length === 1) out.own_party = parties[0];
  else if (parties.length > 1)
    skip({
      section: 'ocpi_publishing.own_party',
      reason: 'the project has more than one own party; declare the one to keep by hand',
    });
  return out;
}

function exportWebhooks(
  webhooks: Obj[],
  stationKey: Map<string, string>,
  skip: (s: Skip) => void,
): Obj {
  const active = webhooks.filter((w) => {
    if (w.status === undefined || w.status === 'active') return true;
    skip({
      section: 'webhooks',
      reason: `endpoint ${String(w.id)} is ${String(w.status)}; not exported`,
    });
    return false;
  });
  const keys = assignKeys(active, (w) => `webhook-${slug(w.id) || 'x'}`, 'webhooks', skip);
  const out: Obj = {};
  for (const [w, key] of keys) {
    // The signing secret is never read into the file; the endpoint keeps its own.
    const entry = pick(w, ['url', 'events', 'meter', 'ocpp_messages']);
    if (Array.isArray(w.stations) && w.stations.length > 0) {
      const refs = w.stations.map((id) => stationKey.get(String(id)));
      if (refs.some((r) => r === undefined)) {
        // Dropping a station would widen the filter to every station: leave the endpoint out.
        skip({
          section: `webhooks.${key}`,
          reason: 'it filters on a station that is not in the file; not exported',
        });
        continue;
      }
      entry.stations = refs;
    }
    out[key] = entry;
  }
  return out;
}

/** Removes any literal value under a secret-looking key; only `env:`/`file:` references stay. */
function scrubSecrets(node: unknown, path: string, skip: (s: Skip) => void): unknown {
  if (Array.isArray(node)) return node.map((n, i) => scrubSecrets(n, `${path}[${i}]`, skip));
  if (!isObj(node)) return node;
  const out: Obj = {};
  for (const [k, v] of Object.entries(node)) {
    const p = path ? `${path}.${k}` : k;
    if (typeof v === 'string' && SECRET_KEY.test(k) && !SECRET_REF.test(v)) {
      skip({ section: p, reason: 'looks like a secret value and was left out' });
      continue;
    }
    out[k] = scrubSecrets(v, p, skip);
  }
  return out;
}

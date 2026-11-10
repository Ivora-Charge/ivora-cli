/**
 * Pure transforms from /v1 read responses to the ivora.yaml document (design 1.2). Nothing here
 * talks to the network. Secrets are references only (1.3): a value the API returns for a secret
 * field is never copied, it becomes `{ secret_ref: "env:NAME" }`.
 */

export const EXPORT_VERSION = 1;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Obj = Record<string, unknown>;

/** Sections that need a signed-in admin: skipped with a key and the reason (1.2). */
export const ADMIN_SECTIONS: Record<string, string> = {
  roaming_partners: 'needs a signed-in admin; not available with an API key',
  apps: 'needs a signed-in admin; not available with an API key',
};

const SECRET_KEY = /(^|_)(password|secret|token|api_?key|private_?key)$/i;

export function secretRef(name: string): { secret_ref: string } {
  const safe = name
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  return { secret_ref: `env:IVORA_${safe || 'SECRET'}` };
}

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Drops null, undefined and empty-string values (a site file has no placeholders). */
export function compact<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => compact(v)) as T;
  if (isObj(value)) {
    const out: Obj = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null || v === undefined || v === '') continue;
      out[k] = compact(v);
    }
    return out as T;
  }
  return value;
}

/** Picks the listed keys that are present. */
function pick(src: Obj, keys: readonly string[]): Obj {
  const out: Obj = {};
  for (const k of keys) if (src[k] !== undefined) out[k] = src[k];
  return out;
}

/**
 * Replaces any string under a secret-looking key (for example inside free-form metadata) with
 * a reference, so a value can never reach the file.
 */
export function scrubSecrets(node: unknown, path: string): unknown {
  if (Array.isArray(node)) return node.map((n, i) => scrubSecrets(n, `${path}_${i}`));
  if (isObj(node)) {
    const out: Obj = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] =
        typeof v === 'string' && v !== '' && SECRET_KEY.test(k)
          ? secretRef(`${path}_${k}`)
          : scrubSecrets(v, `${path}_${k}`);
    }
    return out;
  }
  return node;
}

export function exportLocation(l: Obj): Obj {
  return compact(
    pick(l, [
      'id',
      'name',
      'address',
      'city',
      'state',
      'country',
      'postal_code',
      'latitude',
      'longitude',
      'time_zone',
      'external_reference',
      'metadata',
    ]),
  );
}

export function exportTariff(t: Obj): Obj {
  return compact(
    pick(t, [
      'id',
      'currency',
      'rate_minor_per_kwh',
      'authorization_minor',
      'rate_minor_per_minute',
      'session_fee_minor',
      'elements',
      'tariff_alt_text',
      'rules',
      'time_zone',
      'external_reference',
      'metadata',
    ]),
  );
}

export function exportStation(s: Obj): Obj {
  const connectors = Array.isArray(s.connectors) ? (s.connectors as Obj[]) : [];
  const evses = Array.isArray(s.evses) ? (s.evses as Obj[]) : [];
  const out: Obj = {
    ...pick(s, ['name', 'charger_id', 'location_id']),
    ...(connectors.length > 0 ? { connectors: connectors.length } : {}),
    ...pick(s, ['external_reference', 'metadata']),
    // The password is write-only in the API: only a reference is ever written.
    ...(typeof s.charger_id === 'string' && s.username
      ? { password: secretRef(`station_${s.charger_id}_password`) }
      : {}),
    evses: evses.map((e) => ({
      ...pick(e, ['evse_number', 'physical_reference']),
      connectors: connectors
        .filter((c) => c.evse_number === e.evse_number)
        .map((c) => ({
          ...pick(c, [
            'id',
            'evse_connector_number',
            'type',
            'format',
            'power_type',
            'max_power_w',
            'max_amperage_a',
            'max_voltage_v',
          ]),
          ...(c.tariff_id !== undefined && c.tariff_id !== null ? { tariff: c.tariff_id } : {}),
        })),
    })),
  };
  return scrubSecrets(compact(out), `station_${String(s.charger_id ?? s.id)}`) as Obj;
}

export function exportDisplay(d: Obj): Obj {
  return compact(
    pick(d, ['station_id', 'evse_number', 'qr', 'show_price', 'visibility', 'tariff_id', 'clear']),
  );
}

export function exportWebhook(w: Obj): Obj {
  return compact({
    ...pick(w, [
      'id',
      'url',
      'events',
      'description',
      'status',
      'stations',
      'meter',
      'ocpp_messages',
    ]),
    // The signing secret is never written, only a reference to where it will live.
    secret: secretRef(`webhook_${String(w.id)}_secret`),
  });
}

export function exportOcpi(o: Obj): Obj {
  return compact(
    pick(o, [
      'publish',
      'private',
      'display_name',
      'website',
      'time_zone',
      'connector_defaults',
      'excluded_location_ids',
      'audience',
    ]),
  );
}

/** A default-tariff read: `{ tariff_id }` or nothing when none is set. */
export function defaultTariffId(r: Obj | undefined): number | string | undefined {
  const id = r?.tariff_id;
  return typeof id === 'number' || typeof id === 'string' ? id : undefined;
}

export interface Skip {
  section: string;
  reason: string;
}

export interface ExportInput {
  scope: 'project' | { location: string };
  locations: Obj[];
  tariffs: Obj[];
  stations: Obj[];
  /** Station id -> displays of that station. */
  displays: Map<string, Obj[]>;
  projectDefaultTariff?: number | string | undefined;
  locationDefaultTariffs: Map<string, number | string>;
  webhooks?: Obj[] | undefined;
  ocpi?: Obj | undefined;
  skipped: Skip[];
}

/** Builds the document. Skipped sections appear as `{ skipped: <reason> }` under their key. */
export function buildDocument(input: ExportInput): Obj {
  const doc: Obj = { version: EXPORT_VERSION };
  const skipSet = new Map(input.skipped.map((s) => [s.section, s.reason]));
  const section = (key: string, value: unknown): void => {
    const reason = skipSet.get(key);
    if (reason !== undefined) doc[key] = { skipped: reason };
    else if (value !== undefined) doc[key] = value;
  };

  const locationDefaults = input.locationDefaultTariffs;
  section(
    'locations',
    input.locations.map((l) => {
      const ex = exportLocation(l);
      const def = locationDefaults.get(String(l.id));
      return def !== undefined ? { ...ex, default_tariff: def } : ex;
    }),
  );
  section('tariffs', input.tariffs.map(exportTariff));
  if (input.scope === 'project') {
    section(
      'project',
      input.projectDefaultTariff !== undefined
        ? { default_tariff: input.projectDefaultTariff }
        : {},
    );
  }
  section('stations', input.stations.map(exportStation));
  const displays: Obj[] = [];
  for (const list of input.displays.values()) displays.push(...list.map(exportDisplay));
  section('displays', displays);
  if (input.scope === 'project') {
    section('webhooks', input.webhooks?.map(exportWebhook));
    section('ocpi_publishing', input.ocpi ? exportOcpi(input.ocpi) : undefined);
    for (const [key, reason] of Object.entries(ADMIN_SECTIONS)) doc[key] = { skipped: reason };
  }
  // Last line of defence: no string under a secret-looking key leaves this function.
  return scrubSecrets(doc, 'doc') as Obj;
}

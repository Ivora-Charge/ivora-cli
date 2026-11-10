import type { AdoptHint, Change, Live, Plan, PlanAction, PlanEntry, Rec } from './types.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const entriesOf = (v: unknown): [string, Obj][] =>
  isObj(v) ? Object.entries(v).filter((e): e is [string, Obj] => isObj(e[1])) : [];
const ref = (v: unknown): string | undefined =>
  typeof v === 'string' && v !== '' ? v : v == null ? undefined : String(v);

/** True when everything the file sets equals the live value; fields the file leaves out do not count. */
function covers(file: unknown, live: unknown): boolean {
  if (isObj(file)) {
    return isObj(live) && Object.entries(file).every(([k, v]) => covers(v, live[k]));
  }
  if (Array.isArray(file)) {
    return (
      Array.isArray(live) && live.length === file.length && file.every((v, i) => covers(v, live[i]))
    );
  }
  if (file === null || live === null || file === undefined || live === undefined) {
    return (file ?? null) === (live ?? null);
  }
  // 0.45 and "0.45" are the same price.
  return String(file) === String(live);
}

function fieldChanges(file: Obj, live: Rec, fields: readonly string[], prefix = ''): Change[] {
  const out: Change[] = [];
  for (const f of fields) {
    if (file[f] === undefined) continue;
    if (!covers(file[f], live[f])) out.push({ path: prefix + f, from: live[f], to: file[f] });
  }
  return out;
}

const finish = (changes: Change[], exists: boolean): PlanAction =>
  !exists ? 'create' : changes.length === 0 ? 'no-op' : 'update';

const LOCATION_FIELDS = [
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
  'metadata',
] as const;
const TARIFF_FIELDS = [
  'currency',
  'rate_minor_per_kwh',
  'authorization_minor',
  'rate_minor_per_minute',
  'session_fee_minor',
  'external_reference',
  'elements',
  'tariff_alt_text',
  'rules',
  'time_zone',
  'metadata',
] as const;
const PRICE_FIELDS = new Set([
  'rate_minor_per_kwh',
  'authorization_minor',
  'rate_minor_per_minute',
  'session_fee_minor',
  'elements',
]);
const CONNECTOR_FIELDS = [
  'type',
  'format',
  'power_type',
  'max_power_w',
  'max_amperage_a',
  'max_voltage_v',
] as const;

export function diffSite(doc: Obj, live: Live, file: string, tenant: string): Plan {
  const entries: PlanEntry[] = [];
  const adopt: AdoptHint[] = [];
  const unmanaged: Plan['unmanaged'] = [];
  const notes: string[] = [];
  const claimed = {
    locations: new Set<unknown>(),
    tariffs: new Set<unknown>(),
    stations: new Set<unknown>(),
  };

  // Tariffs: matched by external_reference (the file's, else the local key).
  const tariffId = new Map<string, string | number>();
  for (const [key, t] of entriesOf(doc['tariffs'])) {
    const marker = ref(t['external_reference']) ?? key;
    const match = live.tariffs.find((l) => ref(l['external_reference']) === marker);
    const changes = match ? fieldChanges(t, match, TARIFF_FIELDS) : [];
    const risks: string[] = [];
    if (match) {
      claimed.tariffs.add(match['id']);
      tariffId.set(key, match['id'] as number);
      const inUse = live.stations.some(
        (s) =>
          Array.isArray(s['connectors']) &&
          s['connectors'].some((c) => isObj(c) && c['tariff_id'] === match['id']),
      );
      if (changes.some((c) => c.path === 'currency'))
        risks.push('currency change on an existing tariff');
      if (changes.some((c) => PRICE_FIELDS.has(c.path))) {
        risks.push(
          inUse
            ? 'price change on a tariff that live connectors use: new sessions are billed at the new price'
            : 'price change',
        );
      }
    }
    entries.push({
      section: 'tariffs',
      key,
      action: finish(changes, !!match),
      ...(match ? { id: match['id'] as number } : {}),
      changes,
      risks,
    });
  }
  for (const l of live.tariffs) {
    if (claimed.tariffs.has(l['id'])) continue;
    const m = ref(l['external_reference']);
    if (m === undefined)
      unmanaged.push({
        section: 'tariffs',
        id: l['id'] as number,
        identity: `${String(l['currency'])} tariff`,
      });
    else
      entries.push({
        section: 'tariffs',
        key: m,
        action: 'delete',
        id: l['id'] as number,
        changes: [],
        risks: ['removes a tariff that is not in the file; connectors that use it lose it'],
      });
  }

  // Locations.
  const locationId = new Map<string, string | number>();
  for (const [key, loc] of entriesOf(doc['locations'])) {
    const marker = ref(loc['external_reference']) ?? key;
    const match = live.locations.find((l) => ref(l['external_reference']) === marker);
    const changes = match ? fieldChanges(loc, match, LOCATION_FIELDS) : [];
    const risks: string[] = [];
    if (match) {
      claimed.locations.add(match['id']);
      locationId.set(key, match['id'] as number);
      if (isObj(loc['tax'])) {
        const liveTax = live.tax.get(match['id'] as number);
        const f = loc['tax'];
        const taxChanges: Change[] = [];
        if (f['price_mode'] !== undefined && !covers(f['price_mode'], liveTax?.['price_mode'])) {
          taxChanges.push({
            path: 'tax.price_mode',
            from: liveTax?.['price_mode'],
            to: f['price_mode'],
          });
        }
        if (Array.isArray(f['lines']) && !covers(f['lines'], liveTax?.['lines'])) {
          taxChanges.push({ path: 'tax.lines', from: liveTax?.['lines'], to: f['lines'] });
        }
        if (f['preset'] !== undefined && !covers(f['preset'], liveTax?.['preset'])) {
          taxChanges.push({ path: 'tax.preset', from: liveTax?.['preset'], to: f['preset'] });
        }
        if (taxChanges.length) risks.push('tax change: applies to bills created after the change');
        changes.push(...taxChanges);
      }
    } else {
      const same = live.locations.find(
        (l) => ref(l['external_reference']) === undefined && l['name'] === loc['name'],
      );
      if (same) {
        adopt.push({
          section: 'locations',
          key,
          id: same['id'] as number,
          reason: `a live location named "${String(loc['name'])}" has no external_reference`,
          proposal: `set external_reference "${marker}" on location ${String(same['id'])} to adopt it instead of creating a duplicate`,
        });
        risks.push(
          `a live location with the same name exists (id ${String(same['id'])}): creating would duplicate it`,
        );
      }
    }
    entries.push({
      section: 'locations',
      key,
      action: finish(changes, !!match),
      ...(match ? { id: match['id'] as number } : {}),
      changes,
      risks,
    });
  }
  for (const l of live.locations) {
    if (claimed.locations.has(l['id'])) continue;
    const m = ref(l['external_reference']);
    if (m === undefined)
      unmanaged.push({ section: 'locations', id: l['id'] as number, identity: String(l['name']) });
    else
      entries.push({
        section: 'locations',
        key: m,
        action: 'delete',
        id: l['id'] as number,
        changes: [],
        risks: [
          'removes a location that is not in the file (the API refuses while stations are at it)',
        ],
      });
  }

  // Stations: matched by the OCPP identity.
  for (const [key, st] of entriesOf(doc['stations'])) {
    const cid = ref(st['charger_id']);
    const match =
      cid === undefined ? undefined : live.stations.find((l) => ref(l['charger_id']) === cid);
    const changes: Change[] = [];
    const risks: string[] = [];
    if (match) {
      claimed.stations.add(match['id']);
      changes.push(...fieldChanges(st, match, ['name', 'external_reference', 'metadata']));
      const wantLoc = ref(st['location']);
      if (wantLoc !== undefined) {
        const id = locationId.get(wantLoc);
        if (id === undefined || String(id) !== String(match['location_id'] ?? '')) {
          changes.push({
            path: 'location',
            from: match['location_id'],
            to: id === undefined ? `${wantLoc} (new)` : id,
          });
          risks.push(
            'moves the station to another location: its sessions and tax follow the new location',
          );
        }
      }
      const liveConns = Array.isArray(match['connectors']) ? match['connectors'].filter(isObj) : [];
      const seen = new Set<unknown>();
      for (const [en, evse] of entriesOf(st['evses'])) {
        for (const [cn, conn] of entriesOf(evse['connectors'])) {
          const p = `evses.${en}.connectors.${cn}`;
          const lc = liveConns.find(
            (c) =>
              String(c['evse_number']) === en &&
              String(c['evse_connector_number'] ?? c['number']) === cn,
          );
          if (!lc) {
            changes.push({ path: p, to: 'add connector' });
            continue;
          }
          seen.add(lc);
          changes.push(...fieldChanges(conn, lc, CONNECTOR_FIELDS, p + '.'));
          const tk = ref(conn['tariff']);
          if (tk !== undefined) {
            const tid = tariffId.get(tk);
            if (tid === undefined || String(tid) !== String(lc['tariff_id'] ?? '')) {
              changes.push({
                path: `${p}.tariff`,
                from: lc['tariff_id'],
                to: tid ?? `${tk} (new)`,
              });
            }
          }
        }
      }
      for (const lc of liveConns) {
        if (seen.has(lc)) continue;
        const inFileEvse = entriesOf(st['evses']).some(([en]) => en === String(lc['evse_number']));
        if (inFileEvse || isObj(st['evses'])) {
          changes.push({
            path: `evses.${String(lc['evse_number'])}.connectors.${String(lc['evse_connector_number'] ?? lc['number'])}`,
            from: 'connector',
            to: 'remove connector',
          });
          risks.push('removes a connector that is not in the file');
        }
      }
    } else {
      const wantLoc = ref(st['location']);
      if (wantLoc === undefined) risks.push('no location: the station would be created unassigned');
    }
    if (isObj(st['credentials'])) {
      notes.push(
        `stations.${key}.credentials: the OCPP password is write-only on /v1, so plan cannot compare it`,
      );
    }
    entries.push({
      section: 'stations',
      key,
      action: finish(changes, !!match),
      ...(match ? { id: match['id'] as number } : {}),
      changes,
      risks,
    });
  }
  for (const l of live.stations) {
    if (claimed.stations.has(l['id']) || l['decommissioned'] === true) continue;
    const m = ref(l['external_reference']);
    const identity = ref(l['charger_id']) ?? String(l['name']);
    if (m === undefined) unmanaged.push({ section: 'stations', id: l['id'] as number, identity });
    else
      entries.push({
        section: 'stations',
        key: identity,
        action: 'delete',
        id: l['id'] as number,
        changes: [],
        risks: [
          'removes a station that is not in the file (the API refuses one that ever charged)',
        ],
      });
  }

  // Webhooks: matched by URL. There is no marker, so a live webhook the file lacks is unmanaged.
  const wh = new Set<unknown>();
  for (const [key, w] of entriesOf(doc['webhooks'])) {
    const match = live.webhooks.find((l) => l['url'] === w['url']);
    const changes: Change[] = [];
    const risks: string[] = [];
    if (match) {
      wh.add(match['id']);
      changes.push(
        ...fieldChanges(w, match, ['description', 'meter', 'ocpp_messages', 'stations']),
      );
      if (Array.isArray(w['events'])) {
        const want = new Set(w['events'].map(String));
        const have = new Set(Array.isArray(match['events']) ? match['events'].map(String) : []);
        if (want.size !== have.size || [...want].some((e) => !have.has(e))) {
          changes.push({ path: 'events', from: [...have].sort(), to: [...want].sort() });
          if ([...have].some((e) => !want.has(e)))
            risks.push('stops delivering some events to this endpoint');
        }
      }
    }
    entries.push({
      section: 'webhooks',
      key,
      action: finish(changes, !!match),
      ...(match ? { id: match['id'] as string } : {}),
      changes,
      risks,
    });
  }
  for (const l of live.webhooks) {
    if (!wh.has(l['id']))
      unmanaged.push({ section: 'webhooks', id: l['id'] as string, identity: String(l['url']) });
  }

  notes.push(
    'not compared yet: default_tariff (location and project), displays, load_groups, grid, migration, ocpi_publishing',
  );
  const summary: Plan['summary'] = { create: 0, update: 0, delete: 0, 'no-op': 0 };
  for (const e of entries) summary[e.action]++;
  return {
    file,
    tenant,
    entries,
    adopt,
    unmanaged,
    skipped: [],
    notes,
    power: { available: false, note: '', groups: [] },
    summary,
  };
}

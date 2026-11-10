/**
 * The plan diff (site-as-code design 1.4 and 2): pure, no network.
 *
 * - Identity: a live resource belongs to the file entry whose local key equals its
 *   `metadata["ivora.key"]`. A station without one also matches on `charger_id`.
 *   `external_reference` is an integrator field: it is compared like any other field and never
 *   decides identity or deletion.
 * - Delete: only a live resource that carries an `ivora.key` the file no longer declares.
 *   A live resource without one is unmanaged: reported, never deleted.
 * - Adopt hints propose writing `ivora.key` on an existing resource; plan never writes.
 */
import type { AdoptHint, Change, Live, Plan, PlanAction, PlanEntry, Rec } from './types.js';

type Obj = Record<string, unknown>;
type Id = string | number;
type Section = PlanEntry['section'];

/** The metadata key that holds a resource's local key on the platform (design 1.4). */
export const KEY_METADATA = 'ivora.key';

const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const entriesOf = (v: unknown): [string, Obj][] =>
  isObj(v) ? Object.entries(v).filter((e): e is [string, Obj] => isObj(e[1])) : [];
const ref = (v: unknown): string | undefined =>
  typeof v === 'string' && v !== '' ? v : v == null ? undefined : String(v);
const idOf = (r: Rec): Id => r['id'] as Id;
const sid = (v: unknown): string => String(v);

/** The live resource's local key, when it carries one. */
export function liveKey(r: Rec): string | undefined {
  const m = r['metadata'];
  const k = isObj(m) ? m[KEY_METADATA] : undefined;
  return typeof k === 'string' && k !== '' ? k : undefined;
}

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

/** Metadata as the file compares it: the local key lives in the map key, not in metadata. */
function fileMetadata(v: unknown): unknown {
  if (!isObj(v)) return v;
  return Object.fromEntries(Object.entries(v).filter(([k]) => k !== KEY_METADATA));
}

function fieldChanges(file: Obj, live: Rec, fields: readonly string[], prefix = ''): Change[] {
  const out: Change[] = [];
  for (const f of fields) {
    const want = f === 'metadata' ? fileMetadata(file[f]) : file[f];
    if (want === undefined) continue;
    if (!covers(want, live[f])) out.push({ path: prefix + f, from: live[f], to: want });
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
const RATING_FIELDS = new Set(['max_power_w', 'max_amperage_a', 'max_voltage_v']);

/** Live resources of one section by their ivora.key; a duplicated key is reported, first wins. */
function indexByKey(section: Section, rows: Rec[], notes: string[]): Map<string, Rec> {
  const out = new Map<string, Rec>();
  for (const r of rows) {
    const k = liveKey(r);
    if (k === undefined) continue;
    if (out.has(k)) {
      notes.push(
        `${section}: ${KEY_METADATA} "${k}" is on more than one live resource (ids ${sid(idOf(out.get(k) as Rec))} and ${sid(idOf(r))}); only the first is matched`,
      );
      continue;
    }
    out.set(k, r);
  }
  return out;
}

export function diffSite(doc: Obj, live: Live, file: string, tenant: string): Plan {
  const entries: PlanEntry[] = [];
  const adopt: AdoptHint[] = [];
  const unmanaged: Plan['unmanaged'] = [];
  const notes: string[] = [];
  const adoptProposal = (section: Section, key: string, r: Rec, reason: string): void => {
    adopt.push({
      section,
      key,
      id: idOf(r),
      reason,
      proposal: `write metadata "${KEY_METADATA}": "${key}" on ${section.replace(/s$/, '')} ${sid(idOf(r))} to adopt it`,
    });
  };

  /** Live resources the file did not claim: a delete with an ivora.key, else unmanaged. */
  const leftovers = (
    section: Section,
    rows: Rec[],
    claimed: Set<Rec>,
    identity: (r: Rec) => string,
    risk: string,
  ): void => {
    for (const r of rows) {
      if (claimed.has(r)) continue;
      const k = liveKey(r);
      if (k === undefined) {
        unmanaged.push({ section, id: idOf(r), identity: identity(r) });
      } else {
        entries.push({
          section,
          key: k,
          action: 'delete',
          id: idOf(r),
          changes: [],
          risks: [risk],
        });
      }
    }
  };

  // Tariffs.
  const tariffsByKey = indexByKey('tariffs', live.tariffs, notes);
  const claimedTariffs = new Set<Rec>();
  const tariffId = new Map<string, Id>();
  const fileTariffs = entriesOf(doc['tariffs']);
  for (const [key] of fileTariffs) {
    const m = tariffsByKey.get(key);
    if (m) claimedTariffs.add(m);
  }
  for (const [key, t] of fileTariffs) {
    const match = tariffsByKey.get(key);
    const changes = match ? fieldChanges(t, match, TARIFF_FIELDS) : [];
    const risks: string[] = [];
    if (match) {
      tariffId.set(key, idOf(match));
      const inUse = live.stations.some(
        (s) =>
          Array.isArray(s['connectors']) &&
          s['connectors'].some((c) => isObj(c) && sid(c['tariff_id']) === sid(idOf(match))),
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
    } else {
      // No name on tariffs: an unmanaged live tariff with the same prices is the adopt candidate.
      const same = live.tariffs.find(
        (l) =>
          liveKey(l) === undefined &&
          !claimedTariffs.has(l) &&
          fieldChanges(t, l, TARIFF_FIELDS).length === 0,
      );
      if (same) {
        claimedTariffs.add(same);
        adoptProposal('tariffs', key, same, `live tariff ${sid(idOf(same))} has the same prices`);
        risks.push(
          `a live tariff with the same prices exists (id ${sid(idOf(same))}): creating would duplicate it`,
        );
      }
    }
    entries.push({
      section: 'tariffs',
      key,
      action: finish(changes, !!match),
      ...(match ? { id: idOf(match) } : {}),
      changes,
      risks,
    });
  }
  // An adopt candidate is claimed: it is listed under adopt hints, not as unmanaged.
  leftovers(
    'tariffs',
    live.tariffs,
    claimedTariffs,
    (l) => `${String(l['currency'])} tariff`,
    'removes a tariff that is not in the file; connectors that use it lose it',
  );

  // Locations.
  const locationsByKey = indexByKey('locations', live.locations, notes);
  const claimedLocations = new Set<Rec>();
  const locationId = new Map<string, Id>();
  const fileLocations = entriesOf(doc['locations']);
  for (const [key] of fileLocations) {
    const m = locationsByKey.get(key);
    if (m) claimedLocations.add(m);
  }
  for (const [key, loc] of fileLocations) {
    const match = locationsByKey.get(key);
    const changes = match ? fieldChanges(loc, match, LOCATION_FIELDS) : [];
    const risks: string[] = [];
    if (match) {
      locationId.set(key, idOf(match));
      if (isObj(loc['tax'])) {
        const skipped = live.taxSkipped.get(sid(idOf(match)));
        if (skipped !== undefined) {
          notes.push(`locations.${key}.tax: not compared; ${skipped} for the tax read`);
        } else {
          const taxChanges = taxDiff(loc['tax'], live.tax.get(sid(idOf(match))));
          if (taxChanges.length)
            risks.push('tax change: applies to bills created after the change');
          changes.push(...taxChanges);
        }
      }
    } else {
      const same = live.locations.find(
        (l) => liveKey(l) === undefined && !claimedLocations.has(l) && l['name'] === loc['name'],
      );
      if (same) {
        claimedLocations.add(same);
        adoptProposal(
          'locations',
          key,
          same,
          `a live location named "${String(loc['name'])}" has no ${KEY_METADATA}`,
        );
        risks.push(
          `a live location with the same name exists (id ${sid(idOf(same))}): creating would duplicate it`,
        );
      }
    }
    entries.push({
      section: 'locations',
      key,
      action: finish(changes, !!match),
      ...(match ? { id: idOf(match) } : {}),
      changes,
      risks,
    });
  }
  leftovers(
    'locations',
    live.locations,
    claimedLocations,
    (l) => String(l['name']),
    'removes a location that is not in the file (the API refuses while stations are at it)',
  );

  // Stations: by ivora.key, then by charger_id (the OCPP identity).
  const activeStations = live.stations.filter((l) => l['decommissioned'] !== true);
  const stationsByKey = indexByKey('stations', activeStations, notes);
  const claimedStations = new Set<Rec>();
  const fileStations = entriesOf(doc['stations']);
  const stationMatch = new Map<string, { rec: Rec; byKey: boolean }>();
  for (const [key] of fileStations) {
    const m = stationsByKey.get(key);
    if (m) {
      stationMatch.set(key, { rec: m, byKey: true });
      claimedStations.add(m);
    }
  }
  for (const [key, st] of fileStations) {
    if (stationMatch.has(key)) continue;
    const cid = ref(st['charger_id']);
    if (cid === undefined) continue;
    const m = activeStations.find((l) => !claimedStations.has(l) && ref(l['charger_id']) === cid);
    if (m) {
      stationMatch.set(key, { rec: m, byKey: false });
      claimedStations.add(m);
    }
  }
  const stationId = new Map<string, Id>();
  for (const [key, m] of stationMatch) stationId.set(key, idOf(m.rec));

  for (const [key, st] of fileStations) {
    const m = stationMatch.get(key);
    const match = m?.rec;
    const changes: Change[] = [];
    const risks: string[] = [];
    if (m && match) {
      const k = liveKey(match);
      if (!m.byKey) {
        if (k === undefined) {
          adoptProposal(
            'stations',
            key,
            match,
            `matched by charger_id ${String(match['charger_id'])}, which has no ${KEY_METADATA}`,
          );
        } else {
          changes.push({ path: `metadata.${KEY_METADATA}`, from: k, to: key });
          risks.push(
            `relinks a station that is managed live under the local key "${k}" (matched by charger_id)`,
          );
        }
      }
      changes.push(
        ...fieldChanges(st, match, ['name', 'charger_id', 'external_reference', 'metadata']),
      );
      const wantLoc = ref(st['location']);
      if (wantLoc !== undefined) {
        const id = locationId.get(wantLoc);
        if (id === undefined || sid(id) !== sid(match['location_id'] ?? '')) {
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
              sid(c['evse_number']) === en && sid(c['evse_connector_number'] ?? c['number']) === cn,
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
            if (tid === undefined || sid(tid) !== sid(lc['tariff_id'] ?? '')) {
              changes.push({
                path: `${p}.tariff`,
                from: lc['tariff_id'],
                to: tid ?? `${tk} (new)`,
              });
            }
          }
        }
      }
      if (isObj(st['evses'])) {
        for (const lc of liveConns) {
          if (seen.has(lc)) continue;
          changes.push({
            path: `evses.${sid(lc['evse_number'])}.connectors.${sid(lc['evse_connector_number'] ?? lc['number'])}`,
            from: 'connector',
            to: 'remove connector',
          });
          risks.push('removes a connector that is not in the file');
        }
      }
      // Design 2.2: a rating change while a session is in progress.
      const ratingChanged = changes.some((c) =>
        RATING_FIELDS.has(c.path.slice(c.path.lastIndexOf('.') + 1)),
      );
      if (ratingChanged) {
        if (!live.openSessions.known) {
          notes.push(
            `stations.${key}: open sessions not checked for the rating change; ${live.openSessions.reason} for the transactions read`,
          );
        } else if (live.openSessions.stations.has(sid(idOf(match)))) {
          risks.push(
            'connector rating change on a station with a session in progress: the session runs under the old rating until it ends',
          );
        }
      }
    } else {
      const wantLoc = ref(st['location']);
      if (wantLoc === undefined) risks.push('no location: the station would be created unassigned');
    }
    if (isObj(st['credentials'])) {
      if (match && match['online'] === true) {
        // Design 2.2 and 7.2: the password is write-only, so a change cannot be ruled out.
        risks.push(
          'credentials: if this password differs from the charger’s, applying it sends a charger command to a connected station (design 7.2 gates; needs stations:admin)',
        );
      }
      notes.push(
        `stations.${key}.credentials: the OCPP password is write-only on /v1, so plan cannot compare it`,
      );
    }
    entries.push({
      section: 'stations',
      key,
      action: finish(changes, !!match),
      ...(match ? { id: idOf(match) } : {}),
      changes,
      risks,
    });
  }
  leftovers(
    'stations',
    activeStations,
    claimedStations,
    (l) => ref(l['charger_id']) ?? String(l['name']),
    'removes a station that is not in the file (the API refuses one that ever charged)',
  );

  // Webhooks: /v1 endpoints carry no metadata, so they match on URL and are never deleted.
  const claimedWebhooks = new Set<Rec>();
  for (const [key, w] of entriesOf(doc['webhooks'])) {
    const match = live.webhooks.find((l) => !claimedWebhooks.has(l) && l['url'] === w['url']);
    const changes: Change[] = [];
    const risks: string[] = [];
    if (match) {
      claimedWebhooks.add(match);
      changes.push(...fieldChanges(w, match, ['description', 'meter', 'ocpp_messages']));
      if (Array.isArray(w['stations'])) {
        const want = w['stations'].map((k) => {
          const id = stationId.get(sid(k));
          return id === undefined ? `${sid(k)} (new)` : sid(id);
        });
        const have = Array.isArray(match['stations']) ? match['stations'].map(sid) : [];
        if (!sameSet(want, have)) changes.push({ path: 'stations', from: have, to: want });
      }
      if (Array.isArray(w['events'])) {
        const want = w['events'].map(sid);
        const have = Array.isArray(match['events']) ? match['events'].map(sid) : [];
        if (!sameSet(want, have)) {
          changes.push({ path: 'events', from: [...have].sort(), to: [...want].sort() });
          if (have.some((e) => !want.includes(e)))
            risks.push('stops delivering some events to this endpoint');
        }
      }
    }
    entries.push({
      section: 'webhooks',
      key,
      action: finish(changes, !!match),
      ...(match ? { id: idOf(match) } : {}),
      changes,
      risks,
    });
  }
  for (const l of live.webhooks) {
    if (!claimedWebhooks.has(l))
      unmanaged.push({ section: 'webhooks', id: idOf(l), identity: String(l['url']) });
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
    power: { available: false, note: '', groups: [], not_checked: [] },
    summary,
  };
}

function sameSet(a: string[], b: string[]): boolean {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((v) => y.has(v));
}

function taxDiff(f: Obj, liveTax: Rec | undefined): Change[] {
  const out: Change[] = [];
  for (const field of ['price_mode', 'lines', 'preset'] as const) {
    if (f[field] === undefined) continue;
    if (!covers(f[field], liveTax?.[field]))
      out.push({ path: `tax.${field}`, from: liveTax?.[field], to: f[field] });
  }
  return out;
}

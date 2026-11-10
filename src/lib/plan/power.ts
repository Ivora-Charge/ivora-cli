import type { PowerGroup, PowerImpact } from './types.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

export interface Supply {
  voltage_v: number;
  phases: number;
}

/**
 * The A-to-W factor for a supply. `voltage_v` is the line-to-line voltage (the design's example
 * is 480 V, 3 phases), and the limit is the current per line:
 * - 1 phase: P = V x I;
 * - 2 phases (split-phase, or two lines of a three-phase supply): the load sits across the two
 *   lines, so P = V(L-L) x I, factor 1 (not 2: that would double-count the same current);
 * - 3 phases: P = sqrt(3) x V(L-L) x I.
 */
export function phaseFactor(phases: number): number {
  return phases === 3 ? Math.sqrt(3) : 1;
}

/** Watts for a limit of `unit`, or undefined when an A limit has no supply to convert with. */
export function toWatts(limit: unknown, supply: Supply | undefined): number | undefined {
  if (!isObj(limit) || typeof limit['value'] !== 'number') return undefined;
  if (limit['unit'] === 'W') return limit['value'];
  if (limit['unit'] === 'A' && supply) {
    return Math.round(limit['value'] * supply.voltage_v * phaseFactor(supply.phases));
  }
  return undefined;
}

/** Design 2.1 checks plan does not run yet; printed so their absence is never silent. */
export const POWER_NOT_CHECKED = [
  'connector rating consistency (max_power_w against max_amperage_a x max_voltage_v)',
  'parent/child sums (children against their parent group limit)',
  'fail-safe limits (fail_safe_limit against the stations it would hold)',
  'transformer capacity (grid.transformer_limit)',
  'NEC 625.42 (continuous-load sizing of the branch circuit)',
] as const;

/**
 * Site power impact (design 2.1), from the file only: load groups are not readable on /v1, so
 * there is no live group state to compare with. For each leaf group, compares the rated power of
 * its stations' connectors (max_power_w in the file) with the group limit. Not available when
 * the file declares no load groups or no connector ratings.
 */
export function powerImpact(doc: Obj): PowerImpact {
  const groups = isObj(doc['load_groups']) ? doc['load_groups'] : {};
  const stations = isObj(doc['stations']) ? doc['stations'] : {};
  if (Object.keys(groups).length === 0) {
    return {
      available: false,
      note: 'no load_groups in the file; nothing to compare.',
      groups: [],
      not_checked: [...POWER_NOT_CHECKED],
    };
  }
  const supplyOf = (key: string, seen = new Set<string>()): Supply | undefined => {
    const g = groups[key];
    if (!isObj(g) || seen.has(key)) return undefined;
    seen.add(key);
    const sup = g['supply'];
    if (isObj(sup) && typeof sup['voltage_v'] === 'number' && typeof sup['phases'] === 'number') {
      return { voltage_v: sup['voltage_v'], phases: sup['phases'] };
    }
    return typeof g['parent'] === 'string' ? supplyOf(g['parent'], seen) : undefined;
  };
  const ratedW = (stationKey: string): number | undefined => {
    const st = stations[stationKey];
    if (!isObj(st) || !isObj(st['evses'])) return undefined;
    let sum = 0;
    let any = false;
    for (const evse of Object.values(st['evses'])) {
      if (!isObj(evse) || !isObj(evse['connectors'])) continue;
      // One connector of an EVSE charges at a time: the EVSE counts its strongest connector.
      let best = 0;
      for (const c of Object.values(evse['connectors'])) {
        if (isObj(c) && typeof c['max_power_w'] === 'number') {
          best = Math.max(best, c['max_power_w']);
          any = true;
        }
      }
      sum += best;
    }
    return any ? sum : undefined;
  };
  const out: PowerGroup[] = [];
  for (const [key, g] of Object.entries(groups)) {
    if (!isObj(g) || !Array.isArray(g['stations'])) continue;
    let connected = 0;
    const missing: string[] = [];
    for (const sk of g['stations']) {
      const w = typeof sk === 'string' ? ratedW(sk) : undefined;
      if (w === undefined) missing.push(String(sk));
      else connected += w;
    }
    const limit = toWatts(g['limit'], supplyOf(key));
    const entry: PowerGroup = { group: key, connected_w: connected, status: 'unknown' };
    if (limit !== undefined) entry.limit_w = limit;
    if (limit === undefined) {
      entry.note = 'limit is in A and no supply (voltage_v, phases) is declared';
    } else if (missing.length > 0) {
      entry.note = `no max_power_w in the file for: ${missing.join(', ')}`;
    } else {
      entry.status = connected > limit ? 'over' : 'ok';
      if (entry.status === 'over') {
        entry.note =
          'rated power of the stations exceeds the group limit (the platform will share it)';
      }
    }
    out.push(entry);
  }
  return {
    available: out.length > 0,
    note:
      'computed from the file only (ratings and limits as declared); no live load-group data is ' +
      'readable on /v1.',
    groups: out,
    not_checked: [...POWER_NOT_CHECKED],
  };
}

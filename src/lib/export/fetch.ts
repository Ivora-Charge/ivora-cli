import { ApiError } from '../http.js';
import { callOperation, type Query } from '../resource.js';
import type { Session } from '../session.js';
import type { Obj } from './build.js';

/** The only operations `ivora export` calls: all GET reads of the public /v1 API. */
export const EXPORT_OPERATIONS = {
  locations: 'locations_list_tenant_locations',
  location: 'locations_read_one_location',
  locationDefaultTariff: 'locations_read_a_location_s_default_tariff',
  projectDefaultTariff: 'tariffs_and_bills_read_the_project_s_default_tariff',
  tariffs: 'tariffs_and_bills_read_tenant_billing_tariffs',
  stations: 'stations_list_tenant_charging_stations',
  displays: 'charger_displays_list_a_station_s_charger_displays',
  webhooks: 'webhooks_and_events_list_webhook_endpoints',
  ocpi: 'ocpi_publishing_read_the_tenant_s_ocpi_publishing_settings',
} as const;

const PAGE_LIMIT = 100;
const MAX_PAGES = 100;

interface Page {
  data?: unknown;
  next_cursor?: unknown;
}

/** Follows `after` cursors to the end of a collection. */
export async function listAll(
  s: Session,
  operationId: string,
  params: Record<string, string>,
  query: Query = {},
): Promise<Obj[]> {
  const rows: Obj[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await callOperation<Page>(s, operationId, params, {
      query: { ...query, limit: PAGE_LIMIT, after: cursor },
    });
    const body = res.data ?? {};
    const items = Array.isArray(body.data) ? (body.data as Obj[]) : [];
    rows.push(...items);
    const next = body.next_cursor;
    const nextStr =
      typeof next === 'number' || (typeof next === 'string' && next !== '')
        ? String(next)
        : undefined;
    // Some collections echo the sent cursor on the last page; an empty or short page ends it.
    if (
      nextStr === undefined ||
      items.length === 0 ||
      nextStr === cursor ||
      items.length < PAGE_LIMIT
    )
      break;
    cursor = nextStr;
  }
  return rows;
}

/**
 * Runs an optional read: a 403 or 404 means the section is not available to this key or not
 * set up, and is reported as a skip with its reason. Any other error ends the export.
 */
export async function optional<T>(fn: () => Promise<T>): Promise<{ value: T } | { skip: string }> {
  try {
    return { value: await fn() };
  } catch (err) {
    if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
      return { skip: `the API answered ${err.status}${err.code ? ` (${err.code})` : ''}` };
    }
    throw err;
  }
}

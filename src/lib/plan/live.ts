import { callOperation } from '../resource.js';
import type { Session } from '../session.js';
import type { Live, Rec } from './types.js';

const MAX_PAGES = 100;
const isRec = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);

async function listAll(
  s: Session,
  operationId: string,
  tenant: string,
  query: Record<string, string | number | boolean | undefined> = {},
  paged = true,
): Promise<Rec[]> {
  const rows: Rec[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await callOperation<{ data?: unknown; next_cursor?: unknown }>(
      s,
      operationId,
      { tenant_id: tenant },
      { query: { ...query, ...(paged ? { limit: 100, after: cursor } : {}) } },
    );
    const body = res.data ?? {};
    const data = Array.isArray(body.data) ? body.data.filter(isRec) : [];
    rows.push(...data);
    const next = body.next_cursor;
    if (!paged || (typeof next !== 'string' && typeof next !== 'number') || next === '') break;
    if (data.length === 0 || String(next) === cursor) break;
    cursor = String(next);
  }
  return rows;
}

/** Reads the live state with GET requests only. Webhook signing secrets are dropped on read. */
export async function readLive(s: Session, tenant: string): Promise<Live> {
  const [locations, tariffs, stations, webhooks] = await Promise.all([
    listAll(s, 'locations_list_tenant_locations', tenant),
    listAll(s, 'tariffs_and_bills_read_tenant_billing_tariffs', tenant),
    listAll(s, 'stations_list_tenant_charging_stations', tenant),
    listAll(s, 'webhooks_and_events_list_webhook_endpoints', tenant, {}, false),
  ]);
  for (const w of webhooks) delete w['secret'];
  const tax = new Map<number, Rec | undefined>();
  for (const loc of locations) {
    if (typeof loc['id'] !== 'number') continue;
    const res = await callOperation<Rec>(s, 'locations_read_a_location_s_tax_lines', {
      tenant_id: tenant,
      location_id: String(loc['id']),
    });
    tax.set(loc['id'], isRec(res.data) && res.data['configured'] === true ? res.data : undefined);
  }
  return { locations, tariffs, stations, webhooks, tax };
}

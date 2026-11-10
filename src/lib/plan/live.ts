import { listAll as listPages, optional } from '../export/fetch.js';
import { callOperation, type Query } from '../resource.js';
import type { Session } from '../session.js';
import type { Live, Rec } from './types.js';

/**
 * The only operations `ivora plan` calls: GET reads of the public /v1 API. No /v1/admin path and
 * no charger-control operation is ever called.
 */
export const PLAN_OPERATIONS = {
  locations: 'locations_list_tenant_locations',
  locationTax: 'locations_read_a_location_s_tax_lines',
  tariffs: 'tariffs_and_bills_read_tenant_billing_tariffs',
  stations: 'stations_list_tenant_charging_stations',
  webhooks: 'webhooks_and_events_list_webhook_endpoints',
  transactions: 'charging_and_operations_read_charging_usage_and_realized_billing',
} as const;

export { MAX_PAGES, PAGE_LIMIT } from '../export/fetch.js';

const isRec = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Pages a tenant collection with export's reader: past MAX_PAGES it is an error, never a
 * truncated read (a truncated read would turn the missing rest into creates and unmanaged entries).
 */
async function listAll(
  s: Session,
  operationId: string,
  tenant: string,
  query: Query = {},
): Promise<Rec[]> {
  const rows = await listPages(s, operationId, { tenant_id: tenant }, query);
  return rows.filter(isRec);
}

/**
 * Reads the live state with GET requests only. Webhook signing secrets are dropped on read.
 * Tax and open-session reads tolerate 403/404 for that field only; any other error ends the plan.
 */
export async function readLive(s: Session, tenant: string): Promise<Live> {
  const [locations, tariffs, stations, webhooksRes] = await Promise.all([
    listAll(s, PLAN_OPERATIONS.locations, tenant),
    listAll(s, PLAN_OPERATIONS.tariffs, tenant),
    listAll(s, PLAN_OPERATIONS.stations, tenant),
    // Webhook endpoints are one unpaged list.
    callOperation<{ data?: unknown }>(s, PLAN_OPERATIONS.webhooks, { tenant_id: tenant }),
  ]);
  const webhooks = Array.isArray(webhooksRes.data?.data) ? webhooksRes.data.data.filter(isRec) : [];
  for (const w of webhooks) delete w['secret'];

  const tax = new Map<string, Rec | undefined>();
  const taxSkipped = new Map<string, string>();
  for (const loc of locations) {
    const id = loc['id'];
    if (typeof id !== 'number' && typeof id !== 'string') continue;
    const r = await optional(() =>
      callOperation<Rec>(s, PLAN_OPERATIONS.locationTax, {
        tenant_id: tenant,
        location_id: String(id),
      }),
    );
    if ('skip' in r) taxSkipped.set(String(id), r.skip);
    else
      tax.set(
        String(id),
        isRec(r.value.data) && r.value.data['configured'] !== false ? r.value.data : undefined,
      );
  }

  const open = await optional(() =>
    listAll(s, PLAN_OPERATIONS.transactions, tenant, { active: true }),
  );
  const openSessions =
    'skip' in open
      ? { known: false as const, reason: open.skip }
      : {
          known: true as const,
          stations: new Set(
            open.value
              .filter((t) => t['active'] !== false && t['station_id'] != null)
              .map((t) => String(t['station_id'])),
          ),
        };

  return { locations, tariffs, stations, webhooks, tax, taxSkipped, openSessions };
}

import { Command } from 'commander';
import type { CommandContext } from '../lib/session.js';
import { addListOptions, addTenantOption, runGet, runList } from '../lib/resource.js';

export function stationsCommand(ctx: CommandContext): Command {
  const cmd = new Command('stations').description('read charging stations');
  addListOptions(cmd.command('list'), 'after')
    .description('list stations')
    .option('--name <name>', 'filter by name')
    .option('--charger-id <id>', 'filter by OCPP charger id')
    .option('--external-reference <ref>', 'filter by your external reference')
    .action((opts: Record<string, string | undefined>) =>
      runList(
        ctx,
        {
          operationId: 'stations_list_tenant_charging_stations',
          cursorParam: 'after',
          columns: ['id', 'name', 'charger_id', 'online', 'last_seen'],
        },
        opts,
        {
          name: opts.name,
          charger_id: opts.chargerId,
          external_reference: opts.externalReference,
        },
      ),
    );
  addTenantOption(cmd.command('get').argument('<station-id>'))
    .description('show one station')
    .action((id: string, opts: { tenant?: string }) =>
      runGet(ctx, 'stations_read_station_and_connector_state', 'station_id', id, opts.tenant),
    );
  return cmd;
}

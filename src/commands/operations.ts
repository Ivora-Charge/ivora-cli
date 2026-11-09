import { Command } from 'commander';
import type { CommandContext } from '../lib/session.js';
import { addListOptions, addTenantOption, runGet, runList } from '../lib/resource.js';

export function operationsCommand(ctx: CommandContext): Command {
  const cmd = new Command('operations').description(
    'read charger operations (never re-dispatches)',
  );
  addListOptions(cmd.command('list'), 'before')
    .description('list operations, newest first')
    .option('--status <status>', 'filter by status')
    .option('--kind <kind>', 'filter by kind')
    .option('--actor <actor>', 'filter by actor')
    .option('--station-id <id>', 'filter by station')
    .action((opts: Record<string, string | undefined>) =>
      runList(
        ctx,
        {
          operationId: 'charging_and_operations_list_the_project_s_operations',
          cursorParam: 'before',
          columns: ['id', 'kind', 'status', 'actor', 'station_id', 'created_at'],
        },
        opts,
        {
          status: opts.status,
          kind: opts.kind,
          actor: opts.actor,
          station_id: opts.stationId,
        },
      ),
    );
  addTenantOption(cmd.command('get').argument('<operation-id>'))
    .description('show one operation')
    .action((id: string, opts: { tenant?: string }) =>
      runGet(
        ctx,
        'charging_and_operations_inspect_an_operation_without_redispatching_it',
        'operation_id',
        id,
        opts.tenant,
      ),
    );
  return cmd;
}

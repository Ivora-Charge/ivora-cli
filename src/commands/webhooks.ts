import { Command } from 'commander';
import type { CommandContext } from '../lib/session.js';
import { addTenantOption, callOperation, resolveTenant, runGet } from '../lib/resource.js';
import { openSession } from '../lib/session.js';

export function webhooksCommand(ctx: CommandContext): Command {
  const cmd = new Command('webhooks').description('read webhook endpoints');
  addTenantOption(cmd.command('list'))
    .description('list webhook endpoints')
    .action(async (opts: { tenant?: string }) => {
      const s = await openSession(ctx);
      const tenant = await resolveTenant(ctx, s, opts.tenant);
      const res = await callOperation<{ data?: unknown[] }>(
        s,
        'webhooks_and_events_list_webhook_endpoints',
        { tenant_id: tenant },
      );
      const out = ctx.out();
      const rows = (res.data?.data ?? []) as Record<string, unknown>[];
      if (out.json) out.result({ data: rows });
      else out.result(rows, ['id', 'url', 'status', 'events']);
    });
  addTenantOption(cmd.command('get').argument('<webhook-id>'))
    .description('show one webhook endpoint')
    .action((id: string, opts: { tenant?: string }) =>
      runGet(ctx, 'webhooks_and_events_read_one_webhook_endpoint', 'webhook_id', id, opts.tenant),
    );
  return cmd;
}

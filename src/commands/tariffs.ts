import { readFile } from 'node:fs/promises';
import { Command } from 'commander';
import { CliError, ExitCode } from '../lib/output.js';
import { openSession, type CommandContext } from '../lib/session.js';
import {
  addListOptions,
  addTenantOption,
  callOperation,
  parseIntOption,
  resolveTenant,
  runGet,
  runList,
} from '../lib/resource.js';

/** Reads JSON from a file path, or from stdin for `-`. */
async function readJsonInput(ctx: CommandContext, what: string, source: string): Promise<unknown> {
  let text: string;
  try {
    if (source === '-') {
      const chunks: Buffer[] = [];
      for await (const c of ctx.stdin) chunks.push(Buffer.from(c as Uint8Array));
      text = Buffer.concat(chunks).toString('utf8');
    } else {
      text = await readFile(source, 'utf8');
    }
    return JSON.parse(text);
  } catch (err) {
    throw new CliError(
      `Cannot read ${what} JSON from ${source}: ${(err as Error).message}`,
      ExitCode.Usage,
    );
  }
}

interface ComputeOptions {
  tenant?: string;
  session?: string;
  tariff?: string;
  locationId?: string;
}

export function tariffsCommand(ctx: CommandContext): Command {
  const cmd = new Command('tariffs').description('read tariffs; quote and simulate prices');
  addListOptions(cmd.command('list'), 'after')
    .description('list tariffs')
    .option('--external-reference <ref>', 'filter by your external reference')
    .option('--include-archived', 'include archived tariffs')
    .action((opts: Record<string, string | boolean | undefined>) =>
      runList(
        ctx,
        {
          operationId: 'tariffs_and_bills_read_tenant_billing_tariffs',
          cursorParam: 'after',
          columns: ['id', 'name', 'currency', 'external_reference'],
        },
        opts,
        {
          external_reference: opts.externalReference as string | undefined,
          include_archived: opts.includeArchived ? true : undefined,
        },
      ),
    );
  addTenantOption(cmd.command('get').argument('<tariff-id>'))
    .description('show one tariff')
    .action((id: string, opts: { tenant?: string }) =>
      runGet(ctx, 'tariffs_and_bills_read_one_tariff', 'tariff_id', id, opts.tenant),
    );

  addTenantOption(cmd.command('quote').argument('<tariff-id>'))
    .description('price a session under a stored tariff (read-only)')
    .requiredOption('--session <file>', 'session profile JSON file, or - for stdin')
    .option('--location-id <id>', 'apply this location’s tax lines')
    .action(async (id: string, opts: ComputeOptions) => {
      const session = await readJsonInput(ctx, 'session', opts.session as string);
      const locationId = parseIntOption('--location-id', opts.locationId);
      const s = await openSession(ctx);
      const tenant = await resolveTenant(ctx, s, opts.tenant);
      const res = await callOperation(
        s,
        'tariffs_and_bills_quote_a_session_s_cost_under_a_stored_tariff',
        { tenant_id: tenant, tariff_id: id },
        {
          body: { session, ...(locationId !== undefined ? { location_id: locationId } : {}) },
          readOnly: true,
        },
      );
      ctx.out().result(res.data ?? {});
    });

  addTenantOption(cmd.command('simulate'))
    .description('price a session under a draft tariff that is not stored (read-only)')
    .requiredOption('--tariff <file>', 'tariff definition JSON file, or - for stdin')
    .requiredOption('--session <file>', 'session profile JSON file')
    .option('--location-id <id>', 'apply this location’s tax lines')
    .action(async (opts: ComputeOptions) => {
      if (opts.tariff === '-' && opts.session === '-') {
        throw new CliError('Only one of --tariff and --session can read stdin.', ExitCode.Usage);
      }
      const tariff = await readJsonInput(ctx, 'tariff', opts.tariff as string);
      const session = await readJsonInput(ctx, 'session', opts.session as string);
      const locationId = parseIntOption('--location-id', opts.locationId);
      const s = await openSession(ctx);
      const tenant = await resolveTenant(ctx, s, opts.tenant);
      const res = await callOperation(
        s,
        'tariffs_and_bills_simulate_a_tariff_draft_against_a_session',
        { tenant_id: tenant },
        {
          body: {
            tariff,
            session,
            ...(locationId !== undefined ? { location_id: locationId } : {}),
          },
          readOnly: true,
        },
      );
      ctx.out().result(res.data ?? {});
    });
  return cmd;
}

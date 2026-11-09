import { Command } from 'commander';
import { findOperation, getOperationIds, pathParams } from '../catalog.js';
import { CliError, ExitCode } from '../lib/output.js';
import { openSession, type CommandContext } from '../lib/session.js';
import { callOperation, resolveTenant, type Query } from '../lib/resource.js';

function keyValues(flag: string, values: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const v of values) {
    const i = v.indexOf('=');
    if (i < 1) throw new CliError(`${flag} expects name=value, got "${v}".`, ExitCode.Usage);
    result[v.slice(0, i)] = v.slice(i + 1);
  }
  return result;
}

const collect = (value: string, previous: string[]): string[] => [...previous, value];

export function apiCommand(ctx: CommandContext): Command {
  return new Command('api')
    .description('call a read-only (GET) API operation by operationId')
    .argument('[operation-id]', 'an operationId from the catalog (omit to list them)')
    .option('--path <name=value>', 'path parameter (repeatable)', collect, [])
    .option('--query <name=value>', 'query parameter (repeatable)', collect, [])
    .option('--tenant <id>', 'value for {tenant_id} (default: the key’s only tenant)')
    .action(
      async (
        operationId: string | undefined,
        opts: { path: string[]; query: string[]; tenant?: string },
      ) => {
        if (operationId === undefined) {
          ctx.out().result(getOperationIds().map((id) => ({ operation_id: id })));
          return;
        }
        const op = findOperation(operationId);
        if (!op) {
          throw new CliError(
            `Unknown operation "${operationId}". Run \`ivora api\` to list them.`,
            ExitCode.Usage,
          );
        }
        if (op.method !== 'GET') {
          throw new CliError(
            `${operationId} is a ${op.method} operation. \`ivora api\` only calls GET operations for now.`,
            ExitCode.Usage,
          );
        }
        const params = keyValues('--path', opts.path);
        const query: Query = keyValues('--query', opts.query);
        const s = await openSession(ctx);
        if (pathParams(op.path).includes('tenant_id') && params.tenant_id === undefined) {
          params.tenant_id = await resolveTenant(ctx, s, opts.tenant);
        }
        const res = await callOperation(s, operationId, params, { query });
        // Responses are arbitrary shapes: print JSON in both modes.
        ctx.out().rawJson(res.data);
      },
    );
}

import { Command } from 'commander';
import { accessEnvironment, accessKeyInfo, accessTenantIds, type Access } from '../lib/access.js';
import { envTag } from '../lib/output.js';
import { openSession, type CommandContext } from '../lib/session.js';

export function whoamiCommand(ctx: CommandContext): Command {
  return new Command('whoami')
    .description('show the profile, environment, tenant and scopes of the current key')
    .action(async () => {
      const s = await openSession(ctx);
      const access = (await s.client.request<Access>('GET', '/v1/access')).data ?? {};
      const caps = (await s.client.request<Record<string, unknown>>('GET', '/v1/capabilities'))
        .data;
      const tenants = accessTenantIds(access);
      const key = accessKeyInfo(access);
      const result = {
        profile: s.profile.name,
        environment: accessEnvironment(access) ?? s.profile.environment,
        api_base: s.baseUrl,
        tenant_id: tenants.length === 1 ? tenants[0] : undefined,
        tenants,
        scopes: access.scopes ?? [],
        ...(key ? { key } : {}),
        capabilities: caps ?? {},
      };
      const out = ctx.out();
      if (!out.json) out.line(envTag(s.profile.environment));
      out.result(result);
    });
}

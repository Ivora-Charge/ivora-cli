import { Command } from 'commander';
import { envTag } from '../lib/output.js';
import { openSession, type CommandContext } from '../lib/session.js';

interface Access {
  environment?: string;
  tenant_id?: string;
  scopes?: string[];
}

export function whoamiCommand(ctx: CommandContext): Command {
  return new Command('whoami')
    .description('show the profile, environment, tenant and scopes of the current key')
    .action(async () => {
      const s = await openSession(ctx);
      const access = (await s.client.request<Access>('GET', '/v1/access')).data ?? {};
      const caps = (await s.client.request<Record<string, unknown>>('GET', '/v1/capabilities'))
        .data;
      const result = {
        profile: s.profile.name,
        environment: access.environment ?? s.profile.environment,
        api_base: s.baseUrl,
        tenant_id: access.tenant_id,
        scopes: access.scopes ?? [],
        capabilities: caps ?? {},
      };
      const out = ctx.out();
      if (!out.json) out.line(envTag(s.profile.environment));
      out.result(result);
    });
}

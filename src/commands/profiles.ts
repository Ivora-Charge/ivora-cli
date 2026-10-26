import { Command } from 'commander';
import { CliError, ExitCode } from '../lib/output.js';
import { confirmAction } from '../lib/confirm.js';
import { loadConfig, saveConfig, validateProfileName } from '../lib/profiles.js';
import type { CommandContext } from '../lib/session.js';

export function profilesCommand(ctx: CommandContext): Command {
  const cmd = new Command('profiles').description('list, select and remove profiles');

  cmd
    .command('list', { isDefault: true })
    .description('list profiles (no keys are shown)')
    .action(async () => {
      const config = await loadConfig(ctx.env);
      const rows = Object.values(config.profiles).map((p) => ({
        name: p.name,
        environment: p.environment,
        current: config.current === p.name ? '*' : '',
        tenant_id: p.tenantId ?? '',
        base_url: p.baseUrl ?? '',
      }));
      const out = ctx.out();
      if (out.json) out.result(rows);
      else if (rows.length === 0) out.info('No profiles. Run `ivora login`.');
      else out.result(rows, ['name', 'environment', 'current', 'tenant_id', 'base_url']);
    });

  cmd
    .command('use <name>')
    .description('set the default profile (test profiles only; live always needs --live)')
    .action(async (rawName: string) => {
      const name = validateProfileName(rawName);
      const config = await loadConfig(ctx.env);
      const profile = config.profiles[name];
      if (!profile) throw new CliError(`No profile "${name}".`, ExitCode.Usage);
      if (profile.environment === 'live') {
        throw new CliError(
          'A live profile cannot be the default. Pass --live on each command that should use it.',
          ExitCode.Usage,
        );
      }
      config.current = name;
      await saveConfig(config, ctx.env);
      ctx.out().line(`Default profile: ${name}`);
    });

  cmd
    .command('remove <name>')
    .description('remove a profile and its stored key')
    .action(async (rawName: string) => {
      const name = validateProfileName(rawName);
      const config = await loadConfig(ctx.env);
      const profile = config.profiles[name];
      if (!profile) throw new CliError(`No profile "${name}".`, ExitCode.Usage);
      await confirmAction(ctx.prompter, {
        environment: profile.environment,
        summary: `Remove profile ${name} and its stored key`,
        write: true,
        yes: ctx.globals().yes,
      });
      if (profile.keyRef) await (await ctx.secrets()).delete(profile.keyRef);
      config.profiles = Object.fromEntries(
        Object.entries(config.profiles).filter(([key]) => key !== name),
      );
      if (config.current === name) delete config.current;
      await saveConfig(config, ctx.env);
      ctx.out().line(`Removed profile ${name}`);
    });

  return cmd;
}

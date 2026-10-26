import { Command, Option } from 'commander';
import { CliError, ExitCode } from '../lib/output.js';
import { ApiClient } from '../lib/http.js';
import {
  DEFAULT_PROFILE,
  assertKeyMatchesProfile,
  keyRefFor,
  loadConfig,
  resolveBaseUrl,
  saveConfig,
  validateBaseUrl,
  validateProfileName,
  type Profile,
} from '../lib/profiles.js';
import { displayPrefix } from '../lib/secrets.js';
import type { CommandContext } from '../lib/session.js';

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  let text = '';
  stream.setEncoding?.('utf8');
  for await (const chunk of stream) text += String(chunk);
  return text;
}

/** The key comes from IVORA_API_KEY, stdin (piped) or a hidden prompt. Never from argv. */
async function obtainKey(ctx: CommandContext): Promise<string> {
  const fromEnv = ctx.env.IVORA_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const raw = ctx.stdin.isTTY
    ? await ctx.readSecret('API key: ')
    : ((await readAll(ctx.stdin)).split(/\r?\n/, 1)[0] ?? '');
  const key = raw.trim();
  if (!key) throw new CliError('No API key given (pipe it on stdin or type it).', ExitCode.Usage);
  return key;
}

interface LoginOptions {
  baseUrl?: string;
}

export function loginCommand(ctx: CommandContext): Command {
  return new Command('login')
    .description(
      'verify an API key and save it to a profile (key from stdin, prompt or IVORA_API_KEY)',
    )
    .addOption(new Option('--base-url <url>', 'API origin to store with the profile'))
    .action(async (opts: LoginOptions) => {
      const g = ctx.globals();
      const config = await loadConfig(ctx.env);
      const name = validateProfileName(g.profile ?? (g.live ? 'live' : DEFAULT_PROFILE));
      const existing = config.profiles[name];
      const environment = g.live ? 'live' : (existing?.environment ?? 'test');
      if (existing && existing.environment !== environment) {
        throw new CliError(
          `Profile "${name}" is a ${existing.environment} profile; pick another name.`,
          ExitCode.Usage,
        );
      }
      if (environment === 'live' && !g.live) {
        throw new CliError('Logging in to a live profile needs --live.', ExitCode.Usage);
      }
      const profile: Profile = {
        ...(existing ?? { name, environment }),
        name,
        environment,
        ...(opts.baseUrl ? { baseUrl: validateBaseUrl(opts.baseUrl) } : {}),
        keyRef: keyRefFor(name),
      };

      const apiKey = await obtainKey(ctx);
      assertKeyMatchesProfile(apiKey, profile);
      const baseUrl = resolveBaseUrl(profile, ctx.env, (text) => ctx.out().info(`note: ${text}`));

      // Verify before saving anything.
      const client = new ApiClient({
        baseUrl,
        apiKey,
        apiVersion: g.apiVersion,
        ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
      });
      const { data } = await client.request<{ environment?: string; tenant_id?: string }>(
        'GET',
        '/v1/access',
      );
      if (data?.environment && data.environment !== environment) {
        throw new CliError(
          `The server says this key belongs to the ${data.environment} environment. Nothing was saved.`,
          ExitCode.Usage,
        );
      }
      if (data?.tenant_id) profile.tenantId = data.tenant_id;

      await (await ctx.secrets()).set(profile.keyRef as string, apiKey);
      config.profiles[name] = profile;
      // Only a test profile may become the default; live always needs --live.
      if (environment === 'test') config.current ??= name;
      await saveConfig(config, ctx.env);

      const out = ctx.out();
      out.result({
        profile: name,
        environment,
        key: displayPrefix(apiKey),
        tenant_id: profile.tenantId,
        api_base: baseUrl,
      });
    });
}

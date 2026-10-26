import { ApiClient } from './http.js';
import { CliError, ExitCode, Output, type Writable } from './output.js';
import {
  assertKeyMatchesProfile,
  environmentForKey,
  loadConfig,
  resolveBaseUrl,
  selectProfileName,
  type Profile,
  type ProfileConfig,
} from './profiles.js';
import type { SecretStore } from './secrets.js';
import type { GlobalOptions } from '../cli.js';
import type { Prompter } from './confirm.js';

/** Everything a command needs from its surroundings; tests replace the parts. */
export interface CommandContext {
  stdout: Writable;
  stderr: Writable;
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  env: NodeJS.ProcessEnv;
  prompter: Prompter;
  /** Reads a line without echoing it (for API keys). */
  readSecret(prompt: string): Promise<string>;
  secrets(): Promise<SecretStore>;
  fetch?: typeof fetch;
  globals(): GlobalOptions;
  out(): Output;
}

export interface Session {
  profile: Profile;
  apiKey: string;
  baseUrl: string;
  client: ApiClient;
}

/**
 * Resolves the profile, key and API client for a command. The key comes from `IVORA_API_KEY`
 * or the secret store. Live is an opt-in: a live profile or live key is used only with
 * `--live` or `--profile <live profile>`.
 */
export async function openSession(ctx: CommandContext): Promise<Session> {
  const g = ctx.globals();
  const config = await loadConfig(ctx.env);
  const name = selectProfileName(g, config);
  const stored = config.profiles[name];
  const envKey = ctx.env.IVORA_API_KEY || undefined;

  let profile: Profile;
  let apiKey: string;
  if (envKey !== undefined) {
    const environment = environmentForKey(envKey);
    if (environment === undefined) {
      throw new CliError('IVORA_API_KEY does not look like an Ivora API key.', ExitCode.Usage);
    }
    profile = stored ?? { name, environment };
    apiKey = envKey;
  } else {
    if (!stored) {
      throw new CliError(
        `No profile "${name}". Run \`ivora login${name === 'live' ? ' --live' : ''}\` first.`,
        ExitCode.Auth,
      );
    }
    profile = stored;
    const key = stored.keyRef ? await (await ctx.secrets()).get(stored.keyRef) : undefined;
    if (key === undefined) {
      throw new CliError(
        `No stored key for profile "${name}". Run \`ivora login\` again, or set IVORA_API_KEY.`,
        ExitCode.Auth,
      );
    }
    apiKey = key;
  }

  assertKeyMatchesProfile(apiKey, profile);
  if (g.live && profile.environment !== 'live') {
    throw new CliError(
      `--live was given but profile "${profile.name}" is a test profile.`,
      ExitCode.Usage,
    );
  }
  if (profile.environment === 'live' && !g.live && g.profile !== profile.name) {
    throw new CliError(
      'Live access is opt-in: pass --live (or --profile <name> for a live profile).',
      ExitCode.Usage,
    );
  }

  const baseUrl = resolveBaseUrl(profile, ctx.env);
  const debug = g.debug ? (line: string): void => ctx.out().info(line) : undefined;
  const client = new ApiClient({
    baseUrl,
    apiKey,
    apiVersion: g.apiVersion,
    ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
    ...(debug ? { debug } : {}),
  });
  return { profile, apiKey, baseUrl, client };
}

export type { ProfileConfig };

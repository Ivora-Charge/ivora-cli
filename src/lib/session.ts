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
import {
  REAUTH_MESSAGE,
  REFRESH_SKEW_SECONDS,
  fetchOAuthMetadata,
  oauthRefs,
  refreshTokens,
  type OpenUrl,
  type TokenSet,
} from './oauth.js';
import { saveConfig } from './profiles.js';

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
  /** Opens the browser for `ivora login` (tests replace it). */
  openUrl: OpenUrl;
  /** How long `ivora login` waits for the browser callback (tests shorten it). */
  loginTimeoutMs?: number;
  globals(): GlobalOptions;
  out(): Output;
}

export interface Session {
  profile: Profile;
  /** The API key, or the OAuth access token for a browser-login profile. */
  apiKey: string;
  authType: 'key' | 'oauth';
  baseUrl: string;
  client: ApiClient;
}

/** Stores a token set in the keychain and records the (non-secret) expiry in the config. */
export async function saveTokens(
  ctx: CommandContext,
  profile: Profile,
  tokens: TokenSet,
): Promise<void> {
  const refs = oauthRefs(profile.name);
  const store = await ctx.secrets();
  await store.set(refs.access, tokens.accessToken);
  if (tokens.refreshToken) await store.set(refs.refresh, tokens.refreshToken);
  if (tokens.expiresAt !== undefined) profile.tokenExpiresAt = tokens.expiresAt;
  else delete profile.tokenExpiresAt;
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
  let authType: 'key' | 'oauth' = 'key';
  if (envKey !== undefined) {
    const environment = environmentForKey(envKey);
    if (environment === undefined) {
      throw new CliError('IVORA_API_KEY does not look like an Ivora API key.', ExitCode.Usage);
    }
    // Naming a profile opts in to live only when that profile is stored as live. With no
    // stored profile, a live key from the environment always needs --live.
    if (!stored && environment === 'live' && !g.live) {
      throw new CliError('IVORA_API_KEY holds a live key: pass --live to use it.', ExitCode.Usage);
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
    if (stored.authType === 'oauth') authType = 'oauth';
    const key =
      authType === 'oauth'
        ? await (await ctx.secrets()).get(oauthRefs(name).access)
        : stored.keyRef
          ? await (await ctx.secrets()).get(stored.keyRef)
          : undefined;
    if (key === undefined) {
      throw new CliError(
        `No stored key for profile "${name}". Run \`ivora login\` again, or set IVORA_API_KEY.`,
        ExitCode.Auth,
      );
    }
    apiKey = key;
  }

  if (authType === 'key') assertKeyMatchesProfile(apiKey, profile);
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

  const baseUrl = resolveBaseUrl(profile, ctx.env, (text) => ctx.out().info(`note: ${text}`));
  const debug = g.debug ? (line: string): void => ctx.out().info(line) : undefined;
  if (authType === 'oauth') {
    // Refresh silently before expiry, or on a 401 (the client calls this once and replays).
    const refresh = async (): Promise<string> => {
      const store = await ctx.secrets();
      const refreshToken = await store.get(oauthRefs(profile.name).refresh);
      const meta = refreshToken ? await fetchOAuthMetadata(baseUrl, ctx.fetch) : undefined;
      if (!refreshToken || !meta) throw new CliError(REAUTH_MESSAGE, ExitCode.Auth);
      const tokens = await refreshTokens(meta, refreshToken, ctx.fetch);
      await saveTokens(ctx, profile, tokens);
      const config = await loadConfig(ctx.env);
      if (config.profiles[profile.name]) {
        config.profiles[profile.name] = { ...profile };
        await saveConfig(config, ctx.env);
      }
      return tokens.accessToken;
    };
    const expiresAt = profile.tokenExpiresAt;
    if (expiresAt !== undefined && expiresAt - REFRESH_SKEW_SECONDS <= Date.now() / 1000) {
      apiKey = await refresh();
    }
    const client = new ApiClient({
      baseUrl,
      apiKey,
      apiVersion: g.apiVersion,
      authType: 'oauth',
      refreshToken: refresh,
      ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
      ...(debug ? { debug } : {}),
    });
    return { profile, apiKey, authType, baseUrl, client };
  }
  const client = new ApiClient({
    baseUrl,
    apiKey,
    apiVersion: g.apiVersion,
    ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
    ...(debug ? { debug } : {}),
  });
  return { profile, apiKey, authType, baseUrl, client };
}

export type { ProfileConfig };

import { homedir } from 'node:os';
import { join } from 'node:path';
import { CliError, ExitCode } from './output.js';

/**
 * Profiles pick an environment, a base URL and a key together. "test" keys (`iv_test_`) work
 * only against the test environment and "live" keys (`iv_live_`) only against production, so
 * the CLI refuses a mismatch locally. The config file holds no secrets; keys live in the
 * secret store and the profile keeps a reference. Reading and writing the config file is
 * added with `ivora login` and `ivora profiles`.
 */

export type Environment = 'test' | 'live';

export const DEFAULT_PROFILE = 'test';

/** Production API base, the default for live profiles. */
export const PRODUCTION_API_BASE = 'https://api.ivoracharge.com';

export interface Profile {
  name: string;
  environment: Environment;
  /** Overrides the environment's default base URL. */
  baseUrl?: string;
  /** Secret-store reference for the API key. Never the key itself. */
  keyRef?: string;
  tenantId?: string;
}

export interface ProfileConfig {
  current?: string;
  profiles: Record<string, Profile>;
}

/** The environment a key belongs to, from its prefix, or undefined for an unknown format. */
export function environmentForKey(apiKey: string): Environment | undefined {
  if (apiKey.startsWith('iv_test_')) return 'test';
  if (apiKey.startsWith('iv_live_')) return 'live';
  return undefined;
}

/** Refuses a key that does not belong to the profile's environment. */
export function assertKeyMatchesProfile(apiKey: string, profile: Profile): void {
  const env = environmentForKey(apiKey);
  if (env === undefined) {
    throw new CliError(
      'This does not look like an Ivora API key (iv_test_... or iv_live_...).',
      ExitCode.Usage,
    );
  }
  if (env !== profile.environment) {
    throw new CliError(
      `A ${env} key cannot be used with the ${profile.environment} profile "${profile.name}".` +
        (env === 'live' ? ' Use `ivora login --live` for live keys.' : ''),
      ExitCode.Usage,
    );
  }
}

/** Directory of the CLI config: $XDG_CONFIG_HOME/ivora, ~/.config/ivora, or %APPDATA%\ivora. */
export function configDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'ivora');
  if (platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'ivora');
  return join(home, '.config', 'ivora');
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), 'config.toml');
}

/** Selects the profile: --profile, then --live, then the config's current profile, then "test". */
export function selectProfileName(
  options: { profile?: string; live?: boolean },
  config: ProfileConfig,
): string {
  if (options.profile) return options.profile;
  if (options.live) return 'live';
  return config.current ?? DEFAULT_PROFILE;
}

/**
 * The API base URL for a profile: `IVORA_API_BASE`, then the profile's own URL, then the
 * production default for live profiles. A test profile without a URL is a usage error.
 */
export function resolveBaseUrl(profile: Profile, env: NodeJS.ProcessEnv = process.env): string {
  const candidate =
    env.IVORA_API_BASE ??
    profile.baseUrl ??
    (profile.environment === 'live' ? PRODUCTION_API_BASE : undefined);
  if (candidate === undefined) {
    throw new CliError(
      `No API base URL for the ${profile.environment} profile "${profile.name}". Set IVORA_API_BASE.`,
      ExitCode.Usage,
    );
  }
  return validateBaseUrl(candidate);
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Requires https (plain http only for loopback), no credentials, path or query. */
export function validateBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError(`Invalid API base URL: ${value}`, ExitCode.Usage);
  }
  const loopback = LOOPBACK.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new CliError('The API base URL must use https.', ExitCode.Usage);
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new CliError(
      'The API base URL must be an origin only, e.g. https://api.example.com.',
      ExitCode.Usage,
    );
  }
  return url.origin;
}

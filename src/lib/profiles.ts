import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CliError, ExitCode } from './output.js';

/**
 * Profiles pick an environment, a base URL and a key together. "test" keys (`iv_test_`) work
 * only against the test environment and "live" keys (`iv_live_`) only against production, so
 * the CLI refuses a mismatch locally. The config file holds no secrets; keys live in the
 * secret store and the profile keeps a reference.
 *
 * A live profile is an explicit opt-in: it is never the "current" profile, so a command only
 * reaches production when the user passes `--live` (or names a live profile with `--profile`).
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

const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function validateProfileName(name: string): string {
  if (!PROFILE_NAME.test(name)) {
    throw new CliError(
      `Invalid profile name "${name}": use 1-32 lower-case letters, digits, "-" or "_".`,
      ExitCode.Usage,
    );
  }
  return name;
}

/** The secret-store reference for a profile's key. */
export function keyRefFor(name: string): string {
  return `profile:${name}`;
}

/** Serialises the config as a small TOML subset (string values only). No secrets. */
export function serializeConfig(config: ProfileConfig): string {
  const q = (v: string): string => JSON.stringify(v);
  const lines: string[] = [];
  if (config.current) lines.push(`current = ${q(config.current)}`, '');
  for (const name of Object.keys(config.profiles).sort()) {
    const p = config.profiles[name];
    if (!p) continue;
    lines.push(`[profiles.${name}]`, `environment = ${q(p.environment)}`);
    if (p.baseUrl) lines.push(`base_url = ${q(p.baseUrl)}`);
    if (p.keyRef) lines.push(`key_ref = ${q(p.keyRef)}`);
    if (p.tenantId) lines.push(`tenant_id = ${q(p.tenantId)}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** Parses the subset written by serializeConfig. Unknown keys are ignored. */
export function parseConfig(text: string): ProfileConfig {
  const config: ProfileConfig = { profiles: {} };
  let section: Record<string, string> | undefined;
  const sections = new Map<string, Record<string, string>>();
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const bad = (): never => {
      throw new CliError(`Invalid config file at line ${i + 1}.`, ExitCode.Usage);
    };
    const header = /^\[profiles\.([a-z0-9_-]+)\]$/.exec(line);
    if (header) {
      const name = validateProfileName(header[1] ?? '');
      section = {};
      sections.set(name, section);
      continue;
    }
    const kv = /^([a-z_]+)\s*=\s*("(?:[^"\\]|\\.)*")$/.exec(line);
    if (!kv) return bad();
    let value: string;
    try {
      value = JSON.parse(kv[2] ?? '') as string;
    } catch {
      return bad();
    }
    if (section) section[kv[1] ?? ''] = value;
    else if (kv[1] === 'current') config.current = value;
  }
  for (const [name, f] of sections) {
    if (f.environment !== 'test' && f.environment !== 'live') {
      throw new CliError(`Profile "${name}" has no valid environment.`, ExitCode.Usage);
    }
    config.profiles[name] = {
      name,
      environment: f.environment,
      ...(f.base_url ? { baseUrl: f.base_url } : {}),
      ...(f.key_ref ? { keyRef: f.key_ref } : {}),
      ...(f.tenant_id ? { tenantId: f.tenant_id } : {}),
    };
  }
  return config;
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<ProfileConfig> {
  let text: string;
  try {
    text = await readFile(configPath(env), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { profiles: {} };
    throw err;
  }
  return parseConfig(text);
}

/** Writes the config atomically with owner-only permissions. */
export async function saveConfig(
  config: ProfileConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const dir = configDir(env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `config.toml.${process.pid}.tmp`);
  await writeFile(tmp, serializeConfig(config), { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, configPath(env));
}

/** Selects the profile: --profile, then --live, then the config's current profile, then "test". */
export function selectProfileName(
  options: { profile?: string; live?: boolean },
  config: ProfileConfig,
): string {
  if (options.profile) return options.profile;
  if (options.live) return 'live';
  const current = config.current;
  // A live profile is never picked implicitly, even from a hand-edited config.
  if (current && config.profiles[current]?.environment !== 'live') return current;
  return DEFAULT_PROFILE;
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

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
import { accessEnvironment, defaultTenant, type Access } from '../lib/access.js';
import { UnavailableSecretStore, displayPrefix } from '../lib/secrets.js';
import { saveTokens, type CommandContext } from '../lib/session.js';
import {
  buildAuthorizeUrl,
  createPkce,
  exchangeCode,
  fetchOAuthMetadata,
  oauthRefs,
  randomState,
  revokeToken,
  startLoopbackListener,
  type OAuthMetadata,
} from '../lib/oauth.js';

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
  withKey?: boolean;
}

export const NO_OAUTH_NOTICE = 'OAuth not available on this environment; paste an API key';

/** Browser sign-in: PKCE, a 127.0.0.1 callback, and a state check. Returns the verified token. */
async function browserLogin(
  ctx: CommandContext,
  meta: OAuthMetadata,
  baseUrl: string,
  environment: 'test' | 'live',
  profile: Profile,
): Promise<void> {
  const out = ctx.out();
  const store = await ctx.secrets();
  // Find out before the browser opens: tokens are never kept anywhere but the keychain.
  if (store instanceof UnavailableSecretStore) await store.set();
  const pkce = createPkce();
  const state = randomState();
  const listener = await startLoopbackListener(state, {
    ...(ctx.loginTimeoutMs !== undefined ? { timeoutMs: ctx.loginTimeoutMs } : {}),
    ...(meta.requireIss ? { issuer: meta.issuer } : {}),
  });
  let tokens;
  try {
    const url = buildAuthorizeUrl(meta, {
      redirectUri: listener.redirectUri,
      state,
      challenge: pkce.challenge,
    });
    out.info('Opening your browser to sign in. If it does not open, visit this URL:');
    out.info(url);
    await ctx.openUrl(url);
    const code = await listener.waitForCode();
    tokens = await exchangeCode(
      meta,
      { code, verifier: pkce.verifier, redirectUri: listener.redirectUri },
      ctx.fetch,
    );
  } finally {
    await listener.close();
  }

  // Verify before saving anything; on a mismatch, give the tokens back to the server.
  const client = new ApiClient({
    baseUrl,
    apiKey: tokens.accessToken,
    apiVersion: ctx.globals().apiVersion,
    authType: 'oauth',
    ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
  });
  const discard = async (): Promise<void> => {
    await revokeToken(meta, tokens.accessToken, 'access_token', ctx.fetch);
    if (tokens.refreshToken)
      await revokeToken(meta, tokens.refreshToken, 'refresh_token', ctx.fetch);
  };
  let access: Access;
  try {
    access = (await client.request<Access>('GET', '/v1/access')).data ?? {};
    const serverEnvironment = accessEnvironment(access);
    if (serverEnvironment && serverEnvironment !== environment) {
      throw new CliError(
        `The server says this is a ${serverEnvironment} sign-in, not a ${environment} one. Nothing was saved.`,
        ExitCode.Usage,
      );
    }
  } catch (err) {
    await discard();
    throw err;
  }
  const tenantId = defaultTenant(access, (text) => out.info(`note: ${text}`));
  if (tenantId) profile.tenantId = tenantId;
  else delete profile.tenantId;
  try {
    await saveTokens(ctx, profile, tokens);
  } catch (err) {
    // Tokens that cannot be stored are given back, so none stay valid with nowhere to live.
    const refs = oauthRefs(profile.name);
    await store.delete(refs.access).catch(() => false);
    await store.delete(refs.refresh).catch(() => false);
    await discard();
    throw err;
  }
}

export function loginCommand(ctx: CommandContext): Command {
  return new Command('login')
    .description(
      'sign in with the browser (OAuth), or with --with-key save an API key (stdin, prompt or IVORA_API_KEY)',
    )
    .addOption(new Option('--base-url <url>', 'API origin to store with the profile'))
    .addOption(
      new Option('--with-key', 'use an API key instead of the browser (for CI and scripts)'),
    )
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
      const out = ctx.out();

      if (!opts.withKey) {
        const baseUrl = resolveBaseUrl(profile, ctx.env, (text) => out.info(`note: ${text}`));
        const meta = await fetchOAuthMetadata(baseUrl, ctx.fetch);
        if (meta) {
          delete profile.keyRef;
          profile.authType = 'oauth';
          await browserLogin(ctx, meta, baseUrl, environment, profile);
          // Replace any earlier API key for this profile.
          if (existing?.keyRef) await (await ctx.secrets()).delete(existing.keyRef);
          config.profiles[name] = profile;
          if (environment === 'test') config.current ??= name;
          await saveConfig(config, ctx.env);
          out.result({
            profile: name,
            environment,
            auth: 'oauth',
            tenant_id: profile.tenantId,
            api_base: baseUrl,
          });
          return;
        }
        out.info(NO_OAUTH_NOTICE);
      }

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
      const access = (await client.request<Access>('GET', '/v1/access')).data ?? {};
      const serverEnvironment = accessEnvironment(access);
      if (serverEnvironment && serverEnvironment !== environment) {
        throw new CliError(
          `The server says this is a ${serverEnvironment} key, not a ${environment} one. Nothing was saved.`,
          ExitCode.Usage,
        );
      }
      const tenantId = defaultTenant(access, (text) => ctx.out().info(`note: ${text}`));
      if (tenantId) profile.tenantId = tenantId;
      else delete profile.tenantId;

      await (await ctx.secrets()).set(profile.keyRef as string, apiKey);
      if (existing?.authType === 'oauth') {
        // Switching from browser sign-in to a key: drop the stored tokens (local only).
        const refs = oauthRefs(name);
        await (await ctx.secrets()).delete(refs.access);
        await (await ctx.secrets()).delete(refs.refresh);
      }
      delete profile.authType;
      delete profile.tokenExpiresAt;
      config.profiles[name] = profile;
      // Only a test profile may become the default; live always needs --live.
      if (environment === 'test') config.current ??= name;
      await saveConfig(config, ctx.env);

      out.result({
        profile: name,
        environment,
        key: displayPrefix(apiKey),
        tenant_id: profile.tenantId,
        api_base: baseUrl,
      });
    });
}

import { Command } from 'commander';
import { CliError, ExitCode } from '../lib/output.js';
import { fetchOAuthMetadata, oauthRefs, revokeToken } from '../lib/oauth.js';
import { loadConfig, resolveBaseUrl, saveConfig, selectProfileName } from '../lib/profiles.js';
import type { CommandContext } from '../lib/session.js';

/**
 * Signs out of a profile. For a browser (OAuth) sign-in the tokens are revoked on the server
 * first; if that fails the CLI says so and still clears the keychain. An API key cannot be
 * revoked from here: it is removed from the keychain only.
 */
export function logoutCommand(ctx: CommandContext): Command {
  return new Command('logout')
    .description('revoke the browser sign-in (OAuth) and remove stored credentials for a profile')
    .action(async () => {
      const g = ctx.globals();
      const out = ctx.out();
      const config = await loadConfig(ctx.env);
      const name = selectProfileName(g, config);
      const profile = config.profiles[name];
      if (!profile) throw new CliError(`No profile "${name}".`, ExitCode.Usage);
      if (g.live && profile.environment !== 'live') {
        throw new CliError(
          `--live was given but profile "${name}" is a test profile.`,
          ExitCode.Usage,
        );
      }
      if (profile.environment === 'live' && !g.live && g.profile !== name) {
        throw new CliError(
          'Live access is opt-in: pass --live (or --profile <name> for a live profile).',
          ExitCode.Usage,
        );
      }

      const store = await ctx.secrets();
      let revokeFailed = false;
      let revoked = false;
      if (profile.authType === 'oauth') {
        const refs = oauthRefs(name);
        const access = await store.get(refs.access);
        const refresh = await store.get(refs.refresh);
        if (access || refresh) {
          let meta;
          try {
            meta = await fetchOAuthMetadata(
              resolveBaseUrl(profile, ctx.env, (t) => out.info(`note: ${t}`)),
              ctx.fetch,
            );
          } catch {
            meta = undefined;
          }
          // Refresh token first: revoking it ends the whole grant on most servers.
          const results: boolean[] = [];
          if (meta && refresh)
            results.push(await revokeToken(meta, refresh, 'refresh_token', ctx.fetch));
          if (meta && access)
            results.push(await revokeToken(meta, access, 'access_token', ctx.fetch));
          revoked = results.length > 0 && results.every(Boolean);
          revokeFailed = !revoked;
        }
        await store.delete(refs.access);
        await store.delete(refs.refresh);
        delete profile.authType;
        delete profile.tokenExpiresAt;
      } else if (profile.keyRef) {
        await store.delete(profile.keyRef);
        delete profile.keyRef;
      }
      config.profiles[name] = profile;
      await saveConfig(config, ctx.env);

      out.result({ profile: name, logged_out: true, revoked });
      if (revokeFailed) {
        throw new CliError(
          `Could not revoke the sign-in on the server. It was removed from this machine only; ` +
            `the tokens expire on their own.`,
          ExitCode.ApiError,
        );
      }
    });
}

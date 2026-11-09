/**
 * Browser sign-in for the CLI: OAuth 2.0 authorization code flow with PKCE (S256) and a
 * loopback redirect on 127.0.0.1. The CLI is a public client (no client secret).
 *
 * Tokens are returned to the caller, which stores them in the OS keychain. Nothing here
 * writes to disk, and no function puts a token in an error message or a log line.
 */

import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CliError, ExitCode } from './output.js';

export const METADATA_PATH = '/.well-known/oauth-authorization-server';
export const DEFAULT_CLIENT_ID = 'ivora-cli';
export const CALLBACK_PATH = '/callback';
const LOOPBACK_HOST = '127.0.0.1';
/** Refresh this long before the access token expires. */
export const REFRESH_SKEW_SECONDS = 60;
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;

export interface OAuthMetadata {
  issuer?: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  clientId: string;
  /** Sent as the RFC 8707 `resource` parameter when the server advertises one. */
  resource?: string;
}

type FetchFn = typeof fetch;

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function strList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** https only; plain http just for loopback (local test servers). */
function secureUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) return url.href;
  } catch {
    /* fall through */
  }
  return undefined;
}

/**
 * Reads the environment's authorization-server metadata. Returns undefined, never throws,
 * when OAuth is not available: no document, an unreadable one, or one that does not
 * advertise the authorization code flow with PKCE S256 for the CLI.
 */
export async function fetchOAuthMetadata(
  baseUrl: string,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<OAuthMetadata | undefined> {
  let doc: unknown;
  try {
    const res = await fetchFn(new URL(METADATA_PATH, baseUrl), {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    doc = JSON.parse(await res.text());
  } catch {
    return undefined;
  }
  if (!doc || typeof doc !== 'object') return undefined;
  const d = doc as Record<string, unknown>;
  if (!strList(d.code_challenge_methods_supported).includes('S256')) return undefined;
  // grant/response types are optional in RFC 8414; when present they must include the code flow.
  if (
    d.response_types_supported !== undefined &&
    !strList(d.response_types_supported).includes('code')
  ) {
    return undefined;
  }
  if (
    d.grant_types_supported !== undefined &&
    !strList(d.grant_types_supported).includes('authorization_code')
  ) {
    return undefined;
  }
  const cli =
    d.ivora_cli && typeof d.ivora_cli === 'object' ? (d.ivora_cli as Record<string, unknown>) : {};
  if (d.ivora_cli !== undefined && cli.token_endpoint_auth_method !== undefined) {
    // The CLI is a public client: refuse a server that wants a client secret.
    if (cli.token_endpoint_auth_method !== 'none') return undefined;
  }
  const template = str(cli.redirect_uri_template);
  if (template !== undefined && template !== `http://${LOOPBACK_HOST}:{port}${CALLBACK_PATH}`) {
    return undefined;
  }
  const authorizationEndpoint = secureUrl(str(d.authorization_endpoint));
  const tokenEndpoint = secureUrl(str(d.token_endpoint));
  if (!authorizationEndpoint || !tokenEndpoint) return undefined;
  const revocationEndpoint = secureUrl(str(d.revocation_endpoint));
  const resource = str(d.resource) ?? str(cli.resource);
  return {
    ...(str(d.issuer) ? { issuer: str(d.issuer) as string } : {}),
    authorizationEndpoint,
    tokenEndpoint,
    ...(revocationEndpoint ? { revocationEndpoint } : {}),
    clientId: str(cli.client_id) ?? DEFAULT_CLIENT_ID,
    ...(resource ? { resource } : {}),
  };
}

export interface Pkce {
  verifier: string;
  challenge: string;
}

/** A PKCE verifier (43 URL-safe characters from 32 random bytes) and its S256 challenge. */
export function createPkce(bytes: Buffer = randomBytes(32)): Pkce {
  const verifier = bytes.toString('base64url');
  return { verifier, challenge: challengeFor(verifier) };
}

export function challengeFor(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function randomState(): string {
  return randomBytes(24).toString('base64url');
}

export interface AuthorizeParams {
  redirectUri: string;
  state: string;
  challenge: string;
}

export function buildAuthorizeUrl(meta: OAuthMetadata, p: AuthorizeParams): string {
  const url = new URL(meta.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', meta.clientId);
  url.searchParams.set('redirect_uri', p.redirectUri);
  url.searchParams.set('state', p.state);
  url.searchParams.set('code_challenge', p.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (meta.resource) url.searchParams.set('resource', meta.resource);
  return url.href;
}

export interface LoopbackListener {
  port: number;
  redirectUri: string;
  /** Resolves with the authorization code once a callback with the right state arrives. */
  waitForCode(): Promise<string>;
  close(): Promise<void>;
}

const PAGE = (title: string, text: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:sans-serif"><h1>${title}</h1><p>${text}</p></body>`;

/**
 * Listens on 127.0.0.1 only (never IPv6 or another interface), on a random free port, for
 * `GET /callback`. A callback whose `state` differs is refused and does not end the wait.
 */
export async function startLoopbackListener(
  expectedState: string,
  timeoutMs: number = LOGIN_TIMEOUT_MS,
): Promise<LoopbackListener> {
  let settle: { resolve(code: string): void; reject(err: Error): void } | undefined;
  const result = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // Avoid an unhandled rejection if the caller closes before waiting.
  result.catch(() => undefined);

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${LOOPBACK_HOST}`);
    const send = (status: number, title: string, text: string): void => {
      res.writeHead(status, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      });
      res.end(PAGE(title, text));
    };
    const hostOk = /^127\.0\.0\.1(:\d+)?$/.test(req.headers.host ?? '');
    if (req.method !== 'GET' || url.pathname !== CALLBACK_PATH || !hostOk) {
      send(404, 'Not found', 'Nothing here.');
      return;
    }
    const state = url.searchParams.get('state');
    if (state === null || state !== expectedState) {
      send(
        400,
        'Sign-in refused',
        'The state did not match. Return to the terminal and try again.',
      );
      settle?.reject(
        new CliError(
          'Sign-in refused: the callback state did not match. Run `ivora login` again.',
          ExitCode.Auth,
        ),
      );
      return;
    }
    const error = url.searchParams.get('error');
    if (error !== null) {
      send(400, 'Sign-in failed', 'You can close this tab and return to the terminal.');
      const safe = /^[a-z_]{1,40}$/.test(error) ? error : 'error';
      settle?.reject(new CliError(`Sign-in was not completed (${safe}).`, ExitCode.Auth));
      return;
    }
    const code = url.searchParams.get('code');
    if (!code) {
      send(400, 'Sign-in failed', 'No authorization code was returned.');
      settle?.reject(
        new CliError('Sign-in failed: no authorization code returned.', ExitCode.Auth),
      );
      return;
    }
    send(200, 'Signed in', 'You can close this tab and return to the terminal.');
    settle?.resolve(code);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK_HOST, resolve);
  });
  const port = (server.address() as AddressInfo).port;
  let timer: NodeJS.Timeout | undefined;
  return {
    port,
    redirectUri: `http://${LOOPBACK_HOST}:${port}${CALLBACK_PATH}`,
    waitForCode: () => {
      timer = setTimeout(
        () =>
          settle?.reject(
            new CliError('Timed out waiting for the browser sign-in.', ExitCode.Timeout),
          ),
        timeoutMs,
      );
      timer.unref();
      return result.finally(() => clearTimeout(timer));
    },
    close: () =>
      new Promise<void>((resolve) => {
        clearTimeout(timer);
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Epoch seconds, when the server gave `expires_in`. */
  expiresAt?: number;
  scope?: string;
}

async function tokenRequest(
  endpoint: string,
  form: Record<string, string>,
  fetchFn: FetchFn,
  now: number,
  failure: string,
): Promise<TokenSet> {
  let res: Response;
  try {
    res = await fetchFn(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams(form).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new CliError(`${failure} (network error).`, ExitCode.ApiError);
  }
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await res.text());
    if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const code =
      typeof body.error === 'string' && /^[a-z_]{1,40}$/.test(body.error) ? body.error : undefined;
    throw new CliError(
      `${failure} (HTTP ${res.status}${code ? `, ${code}` : ''}).`,
      res.status === 400 || res.status === 401 ? ExitCode.Auth : ExitCode.ApiError,
    );
  }
  const accessToken = str(body.access_token);
  if (!accessToken) throw new CliError(`${failure} (no access token returned).`, ExitCode.ApiError);
  const expiresIn =
    typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : undefined;
  const refreshToken = str(body.refresh_token);
  const scope = str(body.scope);
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresIn ? { expiresAt: Math.floor(now / 1000 + expiresIn) } : {}),
    ...(scope ? { scope } : {}),
  };
}

export function exchangeCode(
  meta: OAuthMetadata,
  p: { code: string; verifier: string; redirectUri: string },
  fetchFn: FetchFn = globalThis.fetch,
  now: number = Date.now(),
): Promise<TokenSet> {
  return tokenRequest(
    meta.tokenEndpoint,
    {
      grant_type: 'authorization_code',
      code: p.code,
      redirect_uri: p.redirectUri,
      client_id: meta.clientId,
      code_verifier: p.verifier,
      ...(meta.resource ? { resource: meta.resource } : {}),
    },
    fetchFn,
    now,
    'Sign-in failed: the server did not accept the authorization code',
  );
}

export const REAUTH_MESSAGE = 'Your sign-in has expired or was revoked. Run `ivora login` again.';

export async function refreshTokens(
  meta: OAuthMetadata,
  refreshToken: string,
  fetchFn: FetchFn = globalThis.fetch,
  now: number = Date.now(),
): Promise<TokenSet> {
  try {
    return await tokenRequest(
      meta.tokenEndpoint,
      {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: meta.clientId,
        ...(meta.resource ? { resource: meta.resource } : {}),
      },
      fetchFn,
      now,
      'Could not refresh the sign-in',
    );
  } catch {
    // Any failure to refresh means the user has to sign in again; say so without detail.
    throw new CliError(REAUTH_MESSAGE, ExitCode.Auth);
  }
}

/** Revokes one token (RFC 7009). Returns false when the server did not accept it. */
export async function revokeToken(
  meta: OAuthMetadata,
  token: string,
  hint: 'access_token' | 'refresh_token',
  fetchFn: FetchFn = globalThis.fetch,
): Promise<boolean> {
  if (!meta.revocationEndpoint) return false;
  try {
    const res = await fetchFn(meta.revocationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token,
        token_type_hint: hint,
        client_id: meta.clientId,
      }).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Opens a URL in the default browser. Best effort: the caller prints the URL as well. */
export type OpenUrl = (url: string) => Promise<void>;

export const openInBrowser: OpenUrl = (url) =>
  new Promise((resolve) => {
    const [cmd, args]: [string, string[]] =
      process.platform === 'darwin'
        ? ['open', [url]]
        : process.platform === 'win32'
          ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
          : ['xdg-open', [url]];
    const child = execFile(cmd, args, { timeout: 10_000 }, () => resolve());
    child.on('error', () => resolve());
    child.unref();
  });

/** Secret-store references for a profile's OAuth tokens. */
export function oauthRefs(name: string): { access: string; refresh: string } {
  return { access: `oauth:${name}:access`, refresh: `oauth:${name}:refresh` };
}

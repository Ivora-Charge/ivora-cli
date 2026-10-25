import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CliError, ExitCode } from './output.js';
import { redactBody, redactHeaders } from './secrets.js';
import { CLI_VERSION } from '../version.js';

/**
 * Minimal client for the public /v1 API: bearer key, `Ivora-Version`, an Idempotency-Key on
 * every write, and retries (429 with Retry-After; timeouts, network errors and 503
 * `outcome_unknown` replay a write with the same key). Typed calls from the OpenAPI snapshot
 * are added with the resource commands.
 */

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
const WRITE_METHODS = new Set<Method>(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Path prefixes the CLI never calls. The server refuses them for API keys anyway. */
export const STAFF_PREFIXES = ['/v1/admin', '/v1/host', '/v1/internal'] as const;

export class ApiError extends CliError {
  readonly status: number;
  readonly code: string | undefined;
  readonly body: unknown;

  constructor(status: number, code: string | undefined, message: string, body: unknown) {
    super(message, status === 401 || status === 403 ? ExitCode.Auth : ExitCode.ApiError);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/** Refuses anything but a relative public /v1 path. */
export function assertPublicPath(path: string): void {
  if (!path.startsWith('/v1/') && path !== '/v1') {
    throw new CliError(`Only /v1 paths are supported: ${path}`, ExitCode.Usage);
  }
  const pathname = path.split('?', 1)[0] ?? path;
  if (pathname.split('/').some((seg) => seg === '..' || seg === '.')) {
    throw new CliError(`Invalid path: ${path}`, ExitCode.Usage);
  }
  const lower = pathname.toLowerCase();
  for (const prefix of STAFF_PREFIXES) {
    if (lower === prefix || lower.startsWith(`${prefix}/`)) {
      throw new CliError(`${prefix} is not part of the public API.`, ExitCode.Usage);
    }
  }
}

/** Idempotency keys: 8 to 128 printable ASCII characters. */
export function validateIdempotencyKey(key: string): string {
  if (!/^[\x21-\x7e]{8,128}$/.test(key)) {
    throw new CliError(
      'An idempotency key must be 8-128 printable characters without spaces.',
      ExitCode.Usage,
    );
  }
  return key;
}

/** Seconds to wait from a Retry-After header (delta-seconds or HTTP date), capped. */
export function parseRetryAfter(
  value: string | null,
  now: number = Date.now(),
  capSeconds = 60,
): number {
  if (!value) return 1;
  const trimmed = value.trim();
  const seconds = /^\d+$/.test(trimmed) ? Number(trimmed) : (Date.parse(trimmed) - now) / 1000;
  if (!Number.isFinite(seconds)) return 1;
  return Math.min(Math.max(seconds, 0), capSeconds);
}

export interface ClientOptions {
  baseUrl: string;
  apiKey: string;
  apiVersion: string;
  fetch?: typeof fetch;
  /** Retries after the first attempt. */
  maxRetries?: number;
  timeoutMs?: number;
  /** Receives redacted request/response lines for --debug. */
  debug?: (line: string) => void;
  sleep?: (ms: number) => Promise<unknown>;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  idempotencyKey?: string;
}

export interface ApiResponse<T> {
  status: number;
  headers: Headers;
  data: T;
  idempotencyKey?: string;
}

export class ApiClient {
  private readonly options: Required<Omit<ClientOptions, 'debug'>> & Pick<ClientOptions, 'debug'>;

  constructor(options: ClientOptions) {
    this.options = {
      fetch: globalThis.fetch,
      maxRetries: 2,
      timeoutMs: 30_000,
      sleep: (ms: number) => delay(ms),
      ...options,
      baseUrl: options.baseUrl.replace(/\/+$/, ''),
    };
  }

  async request<T = unknown>(
    method: Method,
    path: string,
    opts: RequestOptions = {},
  ): Promise<ApiResponse<T>> {
    assertPublicPath(path);
    const url = new URL(this.options.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const isWrite = WRITE_METHODS.has(method);
    const idempotencyKey = isWrite
      ? validateIdempotencyKey(opts.idempotencyKey ?? randomUUID())
      : undefined;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${this.options.apiKey}`,
      'Ivora-Version': this.options.apiVersion,
      'User-Agent': `ivora-cli/${CLI_VERSION} node/${process.versions.node}`,
    };
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    for (let attempt = 0; ; attempt++) {
      const last = attempt >= this.options.maxRetries;
      this.debug(
        `> ${method} ${url.pathname}${url.search} ${JSON.stringify(redactHeaders(headers))}`,
      );
      if (opts.body !== undefined) this.debug(`> body ${JSON.stringify(redactBody(opts.body))}`);
      let res: Response;
      try {
        res = await this.options.fetch(url, {
          method,
          headers,
          body,
          redirect: 'error',
          signal: AbortSignal.timeout(this.options.timeoutMs),
        });
      } catch (err) {
        const timeout =
          err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
        // Reads are safe to repeat; writes repeat with the same Idempotency-Key.
        if (!last) {
          this.debug(`< ${timeout ? 'timeout' : 'network error'}, retrying`);
          await this.options.sleep(backoffMs(attempt));
          continue;
        }
        throw new CliError(
          timeout
            ? `Request timed out: ${method} ${path}`
            : `Network error: ${(err as Error).message}`,
          timeout ? ExitCode.Timeout : ExitCode.ApiError,
        );
      }
      const data = await readBody(res);
      this.debug(`< ${res.status} ${JSON.stringify(redactBody(data))}`);
      if (res.ok)
        return { status: res.status, headers: res.headers, data: data as T, idempotencyKey };

      const code = errorCode(data);
      if (!last && res.status === 429) {
        await this.options.sleep(parseRetryAfter(res.headers.get('retry-after')) * 1000);
        continue;
      }
      if (!last && res.status === 503 && code === 'outcome_unknown') {
        await this.options.sleep(backoffMs(attempt));
        continue;
      }
      throw new ApiError(res.status, code, errorMessage(res.status, code, data), data);
    }
  }

  private debug(line: string): void {
    this.options.debug?.(line);
  }
}

function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 8_000);
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorCode(data: unknown): string | undefined {
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    const error = obj.error;
    if (
      error &&
      typeof error === 'object' &&
      typeof (error as Record<string, unknown>).code === 'string'
    ) {
      return (error as Record<string, string>).code;
    }
    if (typeof obj.code === 'string') return obj.code;
  }
  return undefined;
}

function errorMessage(status: number, code: string | undefined, data: unknown): string {
  let detail: string | undefined;
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    const error = obj.error as Record<string, unknown> | undefined;
    const candidate = error?.message ?? obj.message ?? obj.detail;
    if (typeof candidate === 'string') detail = candidate;
  } else if (typeof data === 'string' && data.length < 300) {
    detail = data;
  }
  return [`HTTP ${status}`, code, detail].filter(Boolean).join(': ');
}

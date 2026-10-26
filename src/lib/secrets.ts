/**
 * Secret handling: redaction of keys, webhook secrets and credentials in anything the CLI
 * prints, and the secret-store interface. Keys are stored in the OS keychain only (macOS Keychain
 * or the freedesktop Secret Service). There is no plain-text file fallback: where no keychain
 * is available, `ivora login` refuses and `IVORA_API_KEY` is the way to supply a key.
 */

import { execFile } from 'node:child_process';
import { CliError, ExitCode } from './output.js';

const API_KEY = /\biv_(test|live)_[A-Za-z0-9_-]+/g;
const WEBHOOK_SECRET = /\bwhsec_[A-Za-z0-9+/=_-]+/g;
const AUTH_SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;

export const REDACTED = '[redacted]';

/** Redacts API keys, webhook secrets and Bearer/Basic credentials in free text. */
export function redact(text: string): string {
  return text
    .replace(API_KEY, (_m, env: string) => `iv_${env}_${REDACTED}`)
    .replace(WEBHOOK_SECRET, `whsec_${REDACTED}`)
    .replace(AUTH_SCHEME, (_m, scheme: string) => `${scheme} ${REDACTED}`);
}

const SECRET_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'ivora-signature',
]);

/** Returns a copy of the headers with credential headers replaced, for --debug output. */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = SECRET_HEADERS.has(name.toLowerCase()) ? REDACTED : redact(value);
  }
  return out;
}

const SECRET_FIELD = /password|secret|api_?key|authorization/i;

/** Returns a deep copy of a JSON body with password, secret and key fields replaced. */
export function redactBody(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactBody);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = SECRET_FIELD.test(key) ? REDACTED : redactBody(inner);
    }
    return out;
  }
  return typeof value === 'string' ? redact(value) : value;
}

/** A short, non-secret label for a key, e.g. `iv_test_ab12...`. */
export function displayPrefix(apiKey: string): string {
  const match = /^(iv_(?:test|live)_)(.{0,4})/.exec(apiKey);
  return match ? `${match[1]}${match[2]}...` : '(unrecognised key)';
}

/** Where profile secrets live. Profiles store only a reference, never the secret. */
export interface SecretStore {
  get(ref: string): Promise<string | undefined>;
  set(ref: string, secret: string): Promise<void>;
  delete(ref: string): Promise<boolean>;
}

/** In-memory store, used by tests and by `IVORA_API_KEY` sessions that persist nothing. */
export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>();

  async get(ref: string): Promise<string | undefined> {
    return this.values.get(ref);
  }

  async set(ref: string, secret: string): Promise<void> {
    this.values.set(ref, secret);
  }

  async delete(ref: string): Promise<boolean> {
    return this.values.delete(ref);
  }
}

const SERVICE = 'ivora-cli';
const REF = /^[A-Za-z0-9:_-]{1,80}$/;
const KEYCHAIN_SECRET = /^[A-Za-z0-9_-]{8,200}$/;

export interface ExecResult {
  code: number;
  stdout: string;
  /** True when the program is not installed. */
  missing?: boolean;
}

/** Runs a program with `input` on stdin. The secret is never passed in argv. */
export type Exec = (cmd: string, args: string[], input?: string) => Promise<ExecResult>;

export const defaultExec: Exec = (cmd, args, input) =>
  new Promise((resolve) => {
    const child = execFile(cmd, args, { encoding: 'utf8', timeout: 15_000 }, (err, stdout) => {
      if (!err) return resolve({ code: 0, stdout });
      const e = err as NodeJS.ErrnoException & { code?: number | string };
      resolve({
        code: typeof e.code === 'number' ? e.code : 1,
        stdout: '',
        missing: e.code === 'ENOENT',
      });
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(input ?? '');
  });

/**
 * OS keychain through its command-line tool. The secret travels on stdin only, so it does not
 * show up in the process list. `get` returns undefined for a missing entry.
 */
export class KeychainSecretStore implements SecretStore {
  constructor(
    private readonly platform: 'darwin' | 'linux',
    private readonly exec: Exec = defaultExec,
  ) {}

  private check(ref: string): void {
    if (!REF.test(ref)) throw new CliError('Invalid secret reference.', ExitCode.Usage);
  }

  async get(ref: string): Promise<string | undefined> {
    this.check(ref);
    const r =
      this.platform === 'darwin'
        ? await this.exec('security', ['find-generic-password', '-s', SERVICE, '-a', ref, '-w'])
        : await this.exec('secret-tool', ['lookup', 'service', SERVICE, 'account', ref]);
    const value = r.stdout.replace(/\r?\n$/, '');
    return r.code === 0 && value !== '' ? value : undefined;
  }

  async set(ref: string, secret: string): Promise<void> {
    this.check(ref);
    // Stricter than any real key, so the value is safe in the `security -i` command line.
    if (!KEYCHAIN_SECRET.test(secret)) {
      throw new CliError('The key has an unexpected format.', ExitCode.Usage);
    }
    const r =
      this.platform === 'darwin'
        ? await this.exec(
            'security',
            ['-i'],
            `add-generic-password -U -s ${SERVICE} -a ${ref} -w ${secret}\n`,
          )
        : await this.exec(
            'secret-tool',
            ['store', '--label=Ivora CLI API key', 'service', SERVICE, 'account', ref],
            secret,
          );
    if (r.code !== 0) {
      throw new CliError(
        'Could not save the key in the OS keychain. Use the IVORA_API_KEY environment variable instead.',
        ExitCode.ApiError,
      );
    }
  }

  async delete(ref: string): Promise<boolean> {
    this.check(ref);
    const r =
      this.platform === 'darwin'
        ? await this.exec('security', ['delete-generic-password', '-s', SERVICE, '-a', ref])
        : await this.exec('secret-tool', ['clear', 'service', SERVICE, 'account', ref]);
    return r.code === 0;
  }
}

/** Used where no keychain exists: reads find nothing and writes explain the alternative. */
export class UnavailableSecretStore implements SecretStore {
  async get(): Promise<string | undefined> {
    return undefined;
  }

  async set(): Promise<void> {
    throw new CliError(
      'No OS keychain is available on this system, and the CLI never writes keys to disk in ' +
        'plain text. Set the IVORA_API_KEY environment variable instead.',
      ExitCode.Usage,
    );
  }

  async delete(): Promise<boolean> {
    return false;
  }
}

/** The keychain store for this platform, or one that refuses writes. */
export async function openSecretStore(
  platform: NodeJS.Platform = process.platform,
  exec: Exec = defaultExec,
): Promise<SecretStore> {
  if (platform === 'darwin') return new KeychainSecretStore('darwin', exec);
  if (platform === 'linux') {
    const probe = await exec('secret-tool', ['--version']);
    if (!probe.missing) return new KeychainSecretStore('linux', exec);
  }
  return new UnavailableSecretStore();
}

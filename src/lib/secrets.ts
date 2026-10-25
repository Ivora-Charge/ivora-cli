/**
 * Secret handling: redaction of keys, webhook secrets and credentials in anything the CLI
 * prints, and the secret-store interface. The OS keychain store and the 0600 file fallback
 * are added with `ivora login`.
 */

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

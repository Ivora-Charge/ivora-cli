import { redact } from './secrets.js';

/** Process exit codes. Scripts may rely on these. */
export const ExitCode = {
  Ok: 0,
  ApiError: 1,
  Usage: 2,
  ConfirmRefused: 3,
  Timeout: 4,
  Auth: 5,
} as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/** An error that ends the command with a specific exit code and a user-facing message. */
export class CliError extends Error {
  readonly exitCode: ExitCode;

  constructor(message: string, exitCode: ExitCode = ExitCode.ApiError) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

export interface Writable {
  write(chunk: string): unknown;
  isTTY?: boolean;
}

export interface OutputOptions {
  json?: boolean;
  stdout?: Writable;
  stderr?: Writable;
  env?: NodeJS.ProcessEnv;
}

/**
 * Where command output goes. Results go to stdout (a table, or JSON with --json); prompts,
 * progress and errors go to stderr, so `--json` output stays machine-readable.
 * Everything written passes through secret redaction.
 */
export class Output {
  readonly json: boolean;
  readonly color: boolean;
  private readonly stdout: Writable;
  private readonly stderr: Writable;

  constructor(options: OutputOptions = {}) {
    const env = options.env ?? process.env;
    this.json = options.json ?? false;
    this.stdout = options.stdout ?? process.stdout;
    this.stderr = options.stderr ?? process.stderr;
    this.color = !this.json && this.stdout.isTTY === true && !('NO_COLOR' in env);
  }

  /** Writes a result: JSON in --json mode, otherwise a table (arrays) or key/value lines. */
  result(data: unknown, columns?: string[]): void {
    if (this.json) {
      this.stdout.write(redact(JSON.stringify(data, null, 2)) + '\n');
      return;
    }
    if (Array.isArray(data)) {
      this.stdout.write(redact(formatTable(data as Record<string, unknown>[], columns)));
      return;
    }
    if (data !== null && typeof data === 'object') {
      this.stdout.write(redact(formatKeyValues(data as Record<string, unknown>)));
      return;
    }
    this.stdout.write(redact(String(data)) + '\n');
  }

  /** Writes a human line to stdout (not used in --json mode). */
  line(text: string): void {
    if (!this.json) this.stdout.write(redact(text) + '\n');
  }

  /** Writes progress or diagnostics to stderr. */
  info(text: string): void {
    this.stderr.write(redact(text) + '\n');
  }

  error(text: string): void {
    this.stderr.write(redact(`error: ${text}`) + '\n');
  }
}

/** The environment marker shown in prompts and human-mode headers. */
export function envTag(environment: 'test' | 'live', project?: string): string {
  if (environment === 'live') return project ? `[LIVE] ${project}` : '[LIVE]';
  return '[TEST]';
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Formats rows as a left-aligned, space-padded table with an upper-case header. */
export function formatTable(rows: Record<string, unknown>[], columns?: string[]): string {
  const cols = columns ?? [...new Set(rows.flatMap((row) => Object.keys(row)))];
  if (cols.length === 0) return '';
  const header = cols.map((c) => c.toUpperCase());
  const body = rows.map((row) => cols.map((c) => cell(row[c])));
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => (r[i] ?? '').length)));
  const render = (cells: string[]): string =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] ?? 0)))
      .join('  ')
      .trimEnd();
  return [render(header), ...body.map(render)].join('\n') + '\n';
}

function formatKeyValues(data: Record<string, unknown>): string {
  const keys = Object.keys(data);
  const width = Math.max(0, ...keys.map((k) => k.length));
  return keys.map((k) => `${k.padEnd(width)}  ${cell(data[k])}`).join('\n') + '\n';
}

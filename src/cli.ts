import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { CliError, ExitCode, Output, type Writable } from './lib/output.js';
import { validateIdempotencyKey } from './lib/http.js';
import {
  CLI_VERSION,
  DEFAULT_API_VERSION,
  SUPPORTED_API_VERSIONS,
  isSupportedApiVersion,
} from './version.js';

export interface GlobalOptions {
  profile?: string;
  live?: boolean;
  json?: boolean;
  yes?: boolean;
  idempotencyKey?: string;
  apiVersion: string;
  debug?: boolean;
}

export interface RunIo {
  stdout?: Writable;
  stderr?: Writable;
  env?: NodeJS.ProcessEnv;
}

export function versionText(): string {
  return `ivora ${CLI_VERSION} (API ${DEFAULT_API_VERSION})`;
}

function parseApiVersion(value: string): string {
  if (!isSupportedApiVersion(value)) {
    throw new InvalidArgumentError(`supported versions: ${SUPPORTED_API_VERSIONS.join(', ')}`);
  }
  return value;
}

function parseIdempotencyKey(value: string): string {
  try {
    return validateIdempotencyKey(value);
  } catch (err) {
    throw new InvalidArgumentError((err as Error).message);
  }
}

export function buildProgram(io: Required<Pick<RunIo, 'stdout' | 'stderr'>>): Command {
  const program = new Command('ivora')
    .description('Command-line client for the public Ivora /v1 API (pre-alpha: no commands yet).')
    .version(versionText(), '-v, --version', 'print the CLI and API versions')
    .option('--profile <name>', 'profile to use (default: the current profile, else "test")')
    .option('--live', 'use the live profile')
    .option('--json', 'machine-readable output on stdout')
    .option(
      '-y, --yes',
      'skip confirmation prompts (required for writes that ask when not on a TTY)',
    )
    .addOption(
      new Option('--idempotency-key <key>', 'Idempotency-Key for the write request').argParser(
        parseIdempotencyKey,
      ),
    )
    .addOption(
      new Option('--api-version <date>', 'dated API version to send as Ivora-Version')
        .default(DEFAULT_API_VERSION)
        .argParser(parseApiVersion),
    )
    .option('--debug', 'print requests and responses to stderr, with credentials redacted')
    .showHelpAfterError('(run "ivora --help" for usage)')
    .exitOverride()
    .configureOutput({
      writeOut: (s) => io.stdout.write(s),
      writeErr: (s) => io.stderr.write(s),
    })
    .action(function (this: Command) {
      io.stdout.write(this.helpInformation());
    });
  return program;
}

/** Runs the CLI and returns the exit code. Never calls process.exit. */
export async function run(argv: string[], io: RunIo = {}): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const program = buildProgram({ stdout, stderr });
  try {
    await program.parseAsync(argv, { from: 'user' });
    return ExitCode.Ok;
  } catch (err) {
    if (err instanceof CommanderError) {
      if (
        err.code === 'commander.version' ||
        err.code === 'commander.helpDisplayed' ||
        err.code === 'commander.help'
      ) {
        return ExitCode.Ok;
      }
      return ExitCode.Usage;
    }
    const out = new Output({
      stdout,
      stderr,
      env: io.env,
      json: program.opts<GlobalOptions>().json,
    });
    if (err instanceof CliError) {
      out.error(err.message);
      return err.exitCode;
    }
    out.error(err instanceof Error ? err.message : String(err));
    return ExitCode.ApiError;
  }
}

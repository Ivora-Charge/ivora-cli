import { createInterface } from 'node:readline/promises';
import { CliError, ExitCode, envTag } from './output.js';
import type { Environment } from './profiles.js';

/**
 * Confirmation rules: reads never ask; writes on live ask interactively; dangerous actions
 * (hard reset, decommission) always ask. Non-interactive runs need --yes instead of a prompt,
 * and decommission needs --confirm-name.
 */

export interface Prompter {
  /** True when both stdin and stderr are terminals. */
  readonly interactive: boolean;
  ask(question: string): Promise<string>;
}

/** Prompts on stderr and reads stdin, so stdout stays clean for results. */
export function ttyPrompter(
  input: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
  output: NodeJS.WritableStream & { isTTY?: boolean } = process.stderr,
): Prompter {
  return {
    interactive: input.isTTY === true && output.isTTY === true,
    async ask(question: string): Promise<string> {
      const rl = createInterface({ input, output, terminal: true });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
  };
}

export interface ConfirmRequest {
  environment: Environment;
  /** What is about to happen, e.g. "Hard reset station st_123". */
  summary: string;
  write: boolean;
  dangerous?: boolean;
  /** Set by --yes. */
  yes?: boolean;
  project?: string;
}

export function needsConfirmation(
  req: Pick<ConfirmRequest, 'environment' | 'write' | 'dangerous'>,
): boolean {
  if (!req.write) return false;
  return req.dangerous === true || req.environment === 'live';
}

/** Resolves when the action may proceed; throws a CliError (exit 3) when it is refused. */
export async function confirmAction(prompter: Prompter, req: ConfirmRequest): Promise<void> {
  if (!needsConfirmation(req) || req.yes) return;
  if (!prompter.interactive) {
    throw new CliError(
      `${req.summary}: confirmation needed. Pass --yes to run non-interactively.`,
      ExitCode.ConfirmRefused,
    );
  }
  const answer = await prompter.ask(
    `${envTag(req.environment, req.project)} ${req.summary}. Continue? [y/N] `,
  );
  if (!/^(y|yes)$/i.test(answer.trim())) {
    throw new CliError('Cancelled.', ExitCode.ConfirmRefused);
  }
}

export interface ConfirmNameRequest {
  environment: Environment;
  /** The name the user must type, e.g. the station name. */
  expected: string;
  what: string;
  /** Set by --confirm-name. */
  confirmName?: string;
  project?: string;
}

/**
 * Type-the-name confirmation. Returns the confirmed name, which the caller sends to the API
 * (the server checks it again). Non-interactive runs must pass --confirm-name.
 */
export async function confirmName(prompter: Prompter, req: ConfirmNameRequest): Promise<string> {
  let typed = req.confirmName;
  if (typed === undefined) {
    if (!prompter.interactive) {
      throw new CliError(
        `Pass --confirm-name "<name>" to confirm ${req.what} non-interactively.`,
        ExitCode.ConfirmRefused,
      );
    }
    typed = await prompter.ask(
      `${envTag(req.environment, req.project)} Type "${req.expected}" to confirm ${req.what}: `,
    );
  }
  if (typed.trim() !== req.expected) {
    throw new CliError('The name did not match. Nothing was changed.', ExitCode.ConfirmRefused);
  }
  return req.expected;
}

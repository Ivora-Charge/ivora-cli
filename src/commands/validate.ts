import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { Command } from 'commander';
import { CliError, ExitCode } from '../lib/output.js';
import type { CommandContext } from '../lib/session.js';
import { validateText } from '../schema/document.js';
import { buildSchema } from '../schema/index.js';

const MAX_BYTES = 1024 * 1024;

/**
 * `ivora validate [-f ivora.yaml]` checks a site file offline: no network, no credentials, no
 * writes. Sections that need a signed-in admin are skipped with a key and the reason. `file:`
 * secret references are checked for mode 600 and the git work-tree rule; secret files are never
 * read.
 */
export function validateCommand(ctx: CommandContext): Command {
  return new Command('validate')
    .description('check an ivora.yaml file offline (read-only; nothing is sent or changed)')
    .option('-f, --file <path>', 'the file to check', 'ivora.yaml')
    .option('--schema', 'print the JSON Schema for ivora.yaml and exit')
    .action(async (opts: { file: string; schema?: boolean }) => {
      const out = ctx.out();
      if (opts.schema) {
        ctx.stdout.write(JSON.stringify(buildSchema(), null, 2) + '\n');
        return;
      }
      let text: string;
      try {
        if ((await stat(opts.file)).size > MAX_BYTES) {
          throw new CliError(`${opts.file} is larger than 1 MiB.`, ExitCode.Usage);
        }
        text = await readFile(opts.file, 'utf8');
      } catch (err) {
        if (err instanceof CliError) throw err;
        throw new CliError(`Cannot read ${opts.file}.`, ExitCode.Usage);
      }
      const result = validateText(text, {
        baseDir: dirname(resolve(opts.file)),
        homeDir: ctx.env['HOME'] || homedir(),
      });
      for (const s of result.skipped) {
        ctx.stderr.write(`skipped ${s.section}: ${s.reason}\n`);
      }
      for (const w of result.warnings) {
        ctx.stderr.write(`${opts.file}: warning: ${w.path || '(root)'}: ${w.message}\n`);
      }
      if (out.json) {
        out.result({
          valid: result.issues.length === 0,
          errors: result.issues,
          warnings: result.warnings,
          skipped: result.skipped,
        });
      } else {
        for (const i of result.issues) {
          ctx.stderr.write(`${opts.file}: ${i.path || '(root)'}: ${i.message}\n`);
        }
        if (result.issues.length === 0) out.result({ valid: true, file: opts.file });
      }
      if (result.issues.length > 0) {
        throw new CliError(
          `${opts.file} is not valid (${result.issues.length} error${result.issues.length === 1 ? '' : 's'}).`,
          ExitCode.Usage,
        );
      }
    });
}

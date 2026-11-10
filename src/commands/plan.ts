import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { Command } from 'commander';
import { parse } from 'yaml';
import { CliError, ExitCode } from '../lib/output.js';
import { diffSite } from '../lib/plan/diff.js';
import { readLive } from '../lib/plan/live.js';
import { powerImpact } from '../lib/plan/power.js';
import { renderPlan } from '../lib/plan/render.js';
import { resolveTenant } from '../lib/resource.js';
import { openSession, type CommandContext } from '../lib/session.js';
import { validateText } from '../schema/document.js';

const MAX_BYTES = 1024 * 1024;

/**
 * `ivora plan [-f ivora.yaml]` compares the file with the live project and prints what would be
 * created, updated or deleted. Phase 1 is read-only: it sends GET requests only, never applies
 * anything, never reads a secret and never calls a charger-control operation.
 */
export function planCommand(ctx: CommandContext): Command {
  return new Command('plan')
    .description(
      'show what ivora.yaml would change in the live project (read-only; applies nothing)',
    )
    .option('-f, --file <path>', 'the file to compare', 'ivora.yaml')
    .option('--tenant <id>', 'tenant id (default: the key’s only tenant)')
    .action(async (opts: { file: string; tenant?: string }) => {
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
      const checked = validateText(text, {
        baseDir: dirname(resolve(opts.file)),
        homeDir: ctx.env['HOME'] || homedir(),
      });
      if (checked.issues.length > 0) {
        for (const i of checked.issues)
          ctx.stderr.write(`${opts.file}: ${i.path || '(root)'}: ${i.message}\n`);
        throw new CliError(
          `${opts.file} is not valid (${checked.issues.length} error${checked.issues.length === 1 ? '' : 's'}); run \`ivora validate\`.`,
          ExitCode.Usage,
        );
      }
      const doc = parse(text, { maxAliasCount: 50 }) as Record<string, unknown>;
      const admin = new Set(checked.skipped.map((s) => s.section));
      const body = Object.fromEntries(Object.entries(doc).filter(([k]) => !admin.has(k)));

      const s = await openSession(ctx);
      const tenant = await resolveTenant(ctx, s, opts.tenant);
      const project = String(doc['project'] ?? '');
      const wanted = /^(?:proj_|p|tenant_)?(\d+)$/.exec(project)?.[1];
      if (wanted !== undefined && wanted !== tenant) {
        throw new CliError(
          `${opts.file} is for project ${project}, but this key reaches project ${tenant}. Nothing was read.`,
          ExitCode.Usage,
        );
      }

      const live = await readLive(s, tenant);
      const plan = diffSite(body, live, opts.file, tenant);
      plan.skipped = checked.skipped;
      plan.power = powerImpact(body);
      if (wanted === undefined) {
        plan.notes.push(
          `project "${project}" is not a numeric id, so it was not checked against the key`,
        );
      }
      for (const w of checked.warnings) plan.notes.push(`${w.path || '(root)'}: ${w.message}`);

      const out = ctx.out();
      if (out.json) out.result(plan);
      else ctx.stdout.write(renderPlan(plan, s.profile.environment));
    });
}

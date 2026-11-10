import { writeFile } from 'node:fs/promises';
import { Command } from 'commander';
import { stringify } from 'yaml';
import { CliError, ExitCode } from '../lib/output.js';
import { callOperation, parseIntOption, resolveTenant, addTenantOption } from '../lib/resource.js';
import { openSession, type CommandContext } from '../lib/session.js';
import { buildDocument, type Obj, type Skip } from '../lib/export/build.js';
import { EXPORT_OPERATIONS as OP, listAll, optional } from '../lib/export/fetch.js';
import { validateText } from '../schema/document.js';
import { ADMIN_SECTIONS } from '../schema/handwritten.js';

interface ExportOptions {
  tenant?: string;
  project?: boolean;
  location?: string;
  output: string;
  force?: boolean;
}

type Id = string | number;

/** A default-tariff read: its tariff id, or null when none is set. */
function defaultTariffId(r: Obj | undefined): Id | null {
  const id = r?.tariff_id;
  return typeof id === 'number' || (typeof id === 'string' && id !== '') ? id : null;
}

function header(tenant: string, scope: string, skipped: Skip[]): string {
  const lines = [
    `# ivora.yaml: ${scope} of project ${tenant}, exported by \`ivora export\` (read-only).`,
    '# Secrets are references only ({ secret: env:NAME }); provide them before plan or apply.',
  ];
  if (skipped.length > 0) {
    lines.push('# Not exported:');
    for (const s of skipped) lines.push(`#   ${s.section}: ${s.reason}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * `ivora export` reads the live project through GET requests of the public /v1 API and writes
 * ivora.yaml in the shape of design 1.1. It changes nothing in the project (Phase 1 of site as
 * code is read-only) and needs only an API key. Sections that need a signed-in admin are not
 * exported; the reason is printed and noted in the file's header.
 */
export function exportCommand(ctx: CommandContext): Command {
  return addTenantOption(new Command('export'))
    .description('write ivora.yaml from the live project (read-only; nothing is changed)')
    .option('--project', 'export the whole project (the default)')
    .option('--location <id>', 'export one location with its stations, tariffs and displays')
    .option('-o, --output <file>', 'file to write, or - for stdout', 'ivora.yaml')
    .option('--force', 'overwrite the output file if it exists')
    .action(async (opts: ExportOptions) => {
      if (opts.project && opts.location !== undefined) {
        throw new CliError('Use either --project or --location, not both.', ExitCode.Usage);
      }
      const locationId = parseIntOption('--location', opts.location);
      const s = await openSession(ctx);
      const tenant = await resolveTenant(ctx, s, opts.tenant);
      const params = { tenant_id: tenant };
      const skipped: Skip[] = [];
      const skip = (x: Skip): void => {
        skipped.push(x);
      };
      const scope = locationId !== undefined ? 'location' : 'project';

      let locations: Obj[];
      if (locationId !== undefined) {
        const res = await callOperation<Obj>(s, OP.location, {
          ...params,
          location_id: String(locationId),
        });
        locations = res.data ? [res.data] : [];
      } else {
        locations = await listAll(s, OP.locations, params);
      }
      const tariffs = await listAll(s, OP.tariffs, params);
      let stations = await listAll(s, OP.stations, params);
      if (locationId !== undefined) {
        stations = stations.filter((st) => String(st.location_id) === String(locationId));
      }

      // Per-resource reads: a 403/404 leaves out that one field, never the whole section.
      const locationDefaultTariffs = new Map<string, Id | null>();
      const locationTax = new Map<string, Obj>();
      for (const l of locations) {
        const lp = { ...params, location_id: String(l.id) };
        const d = await optional(() => callOperation<Obj>(s, OP.locationDefaultTariff, lp));
        if ('skip' in d)
          skip({ section: `location ${String(l.id)} default_tariff`, reason: d.skip });
        else locationDefaultTariffs.set(String(l.id), defaultTariffId(d.value.data));
        const t = await optional(() => callOperation<Obj>(s, OP.locationTax, lp));
        if ('skip' in t) skip({ section: `location ${String(l.id)} tax`, reason: t.skip });
        else if (t.value.data) locationTax.set(String(l.id), t.value.data);
      }

      const displays = new Map<string, Obj[]>();
      const runningCost = new Map<string, Obj>();
      const pricingText = new Map<string, Obj>();
      for (const st of stations) {
        const id = String(st.id);
        const sp = { ...params, station_id: id };
        const d = await optional(() => callOperation<{ data?: Obj[] }>(s, OP.displays, sp));
        if ('skip' in d) skip({ section: `station ${id} displays`, reason: d.skip });
        else displays.set(id, d.value.data?.data ?? []);
        const r = await optional(() => callOperation<Obj>(s, OP.runningCost, sp));
        if ('skip' in r) skip({ section: `station ${id} running_cost`, reason: r.skip });
        else if (r.value.data) runningCost.set(id, r.value.data);
        const p = await optional(() => callOperation<Obj>(s, OP.pricingText, sp));
        if ('skip' in p) skip({ section: `station ${id} pricing_text`, reason: p.skip });
        else if (p.value.data) pricingText.set(id, p.value.data);
      }

      let projectDefaultTariff: Id | null | undefined;
      let webhooks: Obj[] | undefined;
      let ocpi: Obj | undefined;
      if (scope === 'project') {
        const d = await optional(() => callOperation<Obj>(s, OP.projectDefaultTariff, params));
        if ('skip' in d) skip({ section: 'default_tariff', reason: d.skip });
        else projectDefaultTariff = defaultTariffId(d.value.data);
        // The webhook list is not paginated.
        const w = await optional(() => callOperation<{ data?: Obj[] }>(s, OP.webhooks, params));
        if ('skip' in w) skip({ section: 'webhooks', reason: w.skip });
        else webhooks = w.value.data?.data ?? [];
        const o = await optional(() => callOperation<Obj>(s, OP.ocpi, params));
        if ('skip' in o) skip({ section: 'ocpi_publishing', reason: o.skip });
        else ocpi = o.value.data;
        for (const [section, { reason }] of Object.entries(ADMIN_SECTIONS)) {
          skip({ section, reason });
        }
      }

      const doc = buildDocument(
        {
          tenant,
          scope,
          locations,
          tariffs,
          stations,
          locationDefaultTariffs,
          locationTax,
          projectDefaultTariff,
          displays,
          runningCost,
          pricingText,
          webhooks,
          ocpi,
        },
        skip,
      );
      const text =
        header(
          tenant,
          scope === 'location' ? `location ${String(locationId)}` : 'the whole',
          skipped,
        ) + stringify(doc, { lineWidth: 0 });

      for (const sk of skipped) ctx.stderr.write(`skipped ${sk.section}: ${sk.reason}\n`);
      // The file should pass `ivora validate`; say so loudly when live data does not.
      for (const issue of validateText(text).issues) {
        ctx.stderr.write(
          `warning: the exported file does not validate: ${issue.path || '(root)'} ${issue.message}\n`,
        );
      }

      if (opts.output === '-') {
        ctx.stdout.write(text);
        return;
      }
      try {
        await writeFile(opts.output, text, { flag: opts.force ? 'w' : 'wx' });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new CliError(
            `${opts.output} exists: pass --force to overwrite it.`,
            ExitCode.Usage,
          );
        }
        throw new CliError(`Cannot write ${opts.output}.`, ExitCode.Usage);
      }
      ctx.out().info(`Wrote ${opts.output}.`);
    });
}

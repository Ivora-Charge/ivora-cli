import { writeFile } from 'node:fs/promises';
import { Command } from 'commander';
import { stringify } from 'yaml';
import { CliError, ExitCode } from '../lib/output.js';
import { callOperation, parseIntOption, resolveTenant, addTenantOption } from '../lib/resource.js';
import { openSession, type CommandContext } from '../lib/session.js';
import { buildDocument, defaultTariffId, type Obj, type Skip } from '../lib/export/build.js';
import { EXPORT_OPERATIONS as OP, listAll, optional } from '../lib/export/fetch.js';

interface ExportOptions {
  tenant?: string;
  project?: boolean;
  location?: string;
  output: string;
  force?: boolean;
}

const HEADER =
  '# ivora.yaml: exported from the live project by `ivora export` (read-only).\n' +
  '# Secrets are references only (secret_ref), never values.\n';

/**
 * `ivora export` reads the live project through GET requests of the public /v1 API and writes
 * ivora.yaml. It changes nothing in the project (Phase 1 of site as code is read-only) and needs
 * only an API key. Sections that need a signed-in admin are written as `skipped` with a reason.
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
      const skip = (section: string, reason: string): void => {
        skipped.push({ section, reason });
      };

      let locations: Obj[];
      if (locationId !== undefined) {
        const res = await callOperation<Obj>(s, OP.location, {
          ...params,
          location_id: String(locationId),
        });
        locations = [res.data ?? {}];
      } else {
        locations = await listAll(s, OP.locations, params);
      }
      const tariffs = await listAll(s, OP.tariffs, params);
      let stations = await listAll(s, OP.stations, params);
      if (locationId !== undefined) {
        stations = stations.filter((st) => st.location_id === locationId);
      }

      const locationDefaultTariffs = new Map<string, number | string>();
      for (const l of locations) {
        const r = await optional(() =>
          callOperation<Obj>(s, OP.locationDefaultTariff, {
            ...params,
            location_id: String(l.id),
          }),
        );
        if ('skip' in r) {
          skip('locations', `default tariffs not read: ${r.skip}`);
          break;
        }
        const id = defaultTariffId(r.value.data);
        if (id !== undefined && l.id !== undefined) locationDefaultTariffs.set(String(l.id), id);
      }

      const displays = new Map<string, Obj[]>();
      for (const st of stations) {
        const r = await optional(() =>
          callOperation<{ data?: Obj[] }>(s, OP.displays, { ...params, station_id: String(st.id) }),
        );
        if ('skip' in r) {
          skip('displays', r.skip);
          displays.clear();
          break;
        }
        const list = (r.value.data?.data ?? []).filter((d) => d.deleted !== true);
        if (list.length > 0) displays.set(String(st.id), list);
      }

      let projectDefaultTariff: number | string | undefined;
      let webhooks: Obj[] | undefined;
      let ocpi: Obj | undefined;
      if (locationId === undefined) {
        const d = await optional(() => callOperation<Obj>(s, OP.projectDefaultTariff, params));
        if ('skip' in d) skip('project', d.skip);
        else projectDefaultTariff = defaultTariffId(d.value.data);
        const w = await optional(() => listAll(s, OP.webhooks, params));
        if ('skip' in w) skip('webhooks', w.skip);
        else webhooks = w.value;
        const o = await optional(() => callOperation<Obj>(s, OP.ocpi, params));
        if ('skip' in o) skip('ocpi_publishing', o.skip);
        else ocpi = o.value.data;
      }

      const doc = buildDocument({
        scope: locationId !== undefined ? { location: String(locationId) } : 'project',
        locations,
        tariffs,
        stations,
        displays,
        projectDefaultTariff,
        locationDefaultTariffs,
        webhooks,
        ocpi,
        skipped,
      });
      const text = HEADER + stringify(doc, { lineWidth: 0 });

      for (const sk of skipped) ctx.stderr.write(`skipped ${sk.section}: ${sk.reason}\n`);
      for (const [section, reason] of Object.entries(doc)
        .filter(([, v]) => typeof v === 'object' && v !== null && 'skipped' in v)
        .map(([k, v]) => [k, (v as { skipped: string }).skipped])) {
        if (!skipped.some((x) => x.section === section)) {
          ctx.stderr.write(`skipped ${section}: ${reason}\n`);
        }
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

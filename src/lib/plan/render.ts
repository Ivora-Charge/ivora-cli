import type { Plan } from './types.js';

const SYMBOL = { create: '+', update: '~', delete: '-', 'no-op': '=' } as const;
const show = (v: unknown): string => (v === undefined ? '(unset)' : JSON.stringify(v));

/** The plan as text. It holds no secret: references are never resolved and webhook secrets are dropped. */
export function renderPlan(plan: Plan, environment: string): string {
  const out: string[] = [];
  out.push(
    `Plan for ${plan.file} against project ${plan.tenant} (${environment}). Read-only: nothing was changed.`,
  );
  for (const s of plan.skipped) out.push(`skipped ${s.section}: ${s.reason}`);
  out.push('');
  for (const e of plan.entries) {
    const id = e.id !== undefined ? ` (id ${String(e.id)})` : '';
    out.push(`${SYMBOL[e.action]} ${e.section}.${e.key}: ${e.action}${id}`);
    for (const c of e.changes) {
      out.push(
        c.from === undefined &&
          c.to !== undefined &&
          typeof c.to === 'string' &&
          /connector$/.test(c.to)
          ? `    ${c.path}: ${c.to}`
          : `    ${c.path}: ${show(c.from)} -> ${show(c.to)}`,
      );
    }
    for (const r of e.risks) out.push(`    risk: ${r}`);
  }
  if (plan.entries.length === 0)
    out.push('(the file declares no resources and nothing is managed live)');
  out.push('');
  const s = plan.summary;
  out.push(
    `${s.create} to create, ${s.update} to update, ${s.delete} to delete, ${s['no-op']} unchanged.`,
  );
  out.push('');
  out.push('Site power impact:');
  if (!plan.power.available) out.push(`  not available: ${plan.power.note}`);
  else {
    out.push(`  ${plan.power.note}`);
    for (const g of plan.power.groups) {
      const lim = g.limit_w === undefined ? 'limit unknown' : `limit ${g.limit_w} W`;
      out.push(
        `  ${g.group}: rated ${g.connected_w} W, ${lim}: ${g.status}${g.note ? ` (${g.note})` : ''}`,
      );
    }
  }
  if (plan.adopt.length > 0) {
    out.push('');
    out.push('Adopt hints (proposals only; plan changes nothing):');
    for (const a of plan.adopt) out.push(`  ${a.section}.${a.key}: ${a.proposal} (${a.reason})`);
  }
  if (plan.unmanaged.length > 0) {
    out.push('');
    out.push('Live resources not in the file and not linked to a key (left alone):');
    for (const u of plan.unmanaged) out.push(`  ${u.section} ${String(u.id)}: ${u.identity}`);
  }
  if (plan.notes.length > 0) {
    out.push('');
    out.push('Notes:');
    for (const n of [...new Set(plan.notes)]) out.push(`  ${n}`);
  }
  return out.join('\n') + '\n';
}

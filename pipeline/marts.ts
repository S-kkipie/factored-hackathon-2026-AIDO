import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Duck } from "./duck";
import { mdTable } from "./markdown";
import { lit } from "./sql";

export type MartRows = Record<string, Record<string, unknown>[]>;

/** Demand evidence used to justify the workflow and as the operational baseline. */
const MARTS: Record<string, string> = {
  contact_mix: `
    select reason_category, count(*)::integer as n,
      round(100.0 * count(*) / sum(count(*)) over (), 1)::double as pct,
      round(100.0 * avg(was_resolved::integer), 1)::double as fcr_pct,
      round(100.0 * avg(was_escalated::integer), 1)::double as escalation_pct,
      round(avg(duration_seconds))::double as avg_duration_s
    from stg.call_center_interactions group by 1 order by n desc, 1`,
  complaint_mix: `
    select category, coalesce(subcategory, '(missing)') as subcategory, count(*)::integer as n,
      round(100.0 * count(*) / sum(count(*)) over (), 1)::double as pct,
      round(100.0 * avg(sla_breached::integer), 1)::double as sla_breach_pct,
      round(avg(resolution_days), 1)::double as avg_resolution_days,
      round(avg(resolution_satisfaction), 2)::double as avg_satisfaction
    from stg.complaints group by 1, 2 order by n desc, 1, 2`,
  monthly_contacts: `
    select strftime(interaction_date, '%Y-%m') as month, reason_category, count(*)::integer as n
    from stg.call_center_interactions group by 1, 2 order by 1, 2`,
};

export async function buildMarts(duck: Duck, martsDir: string): Promise<MartRows> {
  await mkdir(martsDir, { recursive: true });
  const out: MartRows = {};
  for (const [name, sql] of Object.entries(MARTS)) {
    await duck.run(`copy (${sql}) to ${lit(join(martsDir, `${name}.parquet`))} (format parquet)`);
    out[name] = await duck.all(sql);
  }
  return out;
}

export function renderDemandMarkdown(marts: MartRows): string {
  const sections = Object.entries(marts)
    .filter(([name]) => name !== "monthly_contacts")
    .map(([name, rows]) => `## ${name}\n\n${mdTable(rows)}`);
  return `# Demand evidence\n\nSource: staged call_center_interactions and complaints.\n\n${sections.join("\n")}`;
}

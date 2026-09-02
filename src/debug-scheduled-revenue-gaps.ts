#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * Read-only: the user just linked a batch of company_qbo_recurring_invoices
 * but says not all of them show up in the Financials Scheduled breakdown.
 * getQboRecurringScheduleByMonth (server/storage.ts) silently drops a
 * template into "stale" and skips it for every month if its computed next
 * cycle (stepped from previous_date) is still before the current month --
 * this dumps every active template, whether it's linked to a company, and
 * whether it would be projected or dropped as stale, so the exact gap is
 * visible instead of guessed at.
 *
 *   npm run debug-scheduled-revenue-gaps
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

function stepDate(d: Date, intervalType: string | null, numInterval: number): Date {
  const n = numInterval || 1;
  switch (intervalType) {
    case "Daily": return new Date(d.getTime() + n * 86_400_000);
    case "Weekly": return new Date(d.getTime() + n * 7 * 86_400_000);
    case "Yearly": return new Date(d.getFullYear() + n, d.getMonth(), d.getDate());
    case "Monthly":
    default: return new Date(d.getFullYear(), d.getMonth() + n, d.getDate());
  }
}
const ymOf = (d: string | Date) => new Date(d).toISOString().slice(0, 7);

async function main() {
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const { rows: templates } = await c.query(
      `SELECT id, customer_id, customer_name, template_name, amount_cents, active,
              interval_type, num_interval, start_date, next_date, previous_date, end_date, synced_at
         FROM qbo_recurring_invoices WHERE active = true ORDER BY customer_name`,
    );
    const { rows: links } = await c.query(
      `SELECT cqr.qbo_recurring_invoice_id, co.name AS company_name, co.id AS company_id
         FROM company_qbo_recurring_invoices cqr LEFT JOIN companies co ON co.id = cqr.company_id`,
    );
    const linkedByTemplate = new Map<string, { companyId: string; companyName: string }>();
    for (const l of links) linkedByTemplate.set(l.qbo_recurring_invoice_id, { companyId: l.company_id, companyName: l.company_name });

    const currentYm = ymOf(new Date());
    console.log(`${templates.length} active qbo_recurring_invoices row(s). Current month: ${currentYm}\n`);

    let projectable = 0, stale = 0, noAnchor = 0, linked = 0, unlinked = 0;
    for (const t of templates) {
      const link = linkedByTemplate.get(t.id);
      const linkTag = link ? `LINKED → ${link.companyName}` : "unlinked";
      if (link) linked++; else unlinked++;

      let status: string;
      if (t.next_date) {
        status = `projectable (next_date=${t.next_date})`;
        projectable++;
      } else if (t.previous_date) {
        const candidate = stepDate(new Date(t.previous_date), t.interval_type, t.num_interval);
        if (ymOf(candidate) < currentYm) {
          status = `STALE (previous_date=${t.previous_date}, computed next=${ymOf(candidate)} < ${currentYm} — DROPPED from every month)`;
          stale++;
        } else {
          status = `projectable (previous_date=${t.previous_date} → ${ymOf(candidate)})`;
          projectable++;
        }
      } else if (t.start_date) {
        status = `projectable via start_date=${t.start_date} (no invoice fired yet)`;
        projectable++;
      } else {
        status = "NO ANCHOR AT ALL (no start/next/previous date) — DROPPED from every month";
        noAnchor++;
      }
      console.log(`  ${(t.customer_name ?? "?").padEnd(30)} ${(t.template_name ?? "").slice(0, 30).padEnd(30)} $${(t.amount_cents / 100).toFixed(0).padStart(7)}/${t.interval_type ?? "?"} [${linkTag}] — ${status}`);
    }
    console.log(`\nSummary: ${projectable} projectable, ${stale} stale, ${noAnchor} with no anchor at all. ${linked} linked to a company, ${unlinked} unlinked.`);

    // The cases the user actually cares about: linked but not showing up.
    const linkedButBroken = templates.filter((t) => {
      if (!linkedByTemplate.has(t.id)) return false;
      if (t.next_date) return false;
      if (t.previous_date) {
        const candidate = stepDate(new Date(t.previous_date), t.interval_type, t.num_interval);
        return ymOf(candidate) < currentYm;
      }
      return !t.start_date;
    });
    if (linkedButBroken.length) {
      console.log(`\n${linkedButBroken.length} template(s) ARE linked to a company but will NOT appear in any month's Scheduled breakdown:`);
      for (const t of linkedButBroken) {
        const link = linkedByTemplate.get(t.id)!;
        console.log(`  ${link.companyName} — ${t.customer_name} / ${t.template_name} — $${(t.amount_cents / 100).toFixed(0)}/${t.interval_type} — synced_at=${t.synced_at}`);
      }
    } else {
      console.log(`\nEvery linked template IS projectable — if one still isn't showing, check whether the CLIENT itself has parentCompanyId/clientId wired correctly, not the template.`);
    }
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { QboClient } from "./qbo.js";
import { ymd } from "./dates.js";

/**
 * On quote signature → QuickBooks. Finds signed quotes and, in the sandbox/prod
 * company, creates:
 *   • an ESTIMATE (always) — the accepted quote as a non-binding QBO record,
 *   • an INVOICE (when QBO_AUTO_INVOICE=true) — the billable document, emailed to
 *     the signer if we have their address, and
 *   • a RECURRING INVOICE TEMPLATE, if the quote has any monthly line items —
 *     the retainer's actual ongoing billing, not just its one-time setup fee.
 *     Starts on the signature date; ends after retainer_term_months if the
 *     quote set one, else runs ongoing/evergreen.
 * The estimate/invoice/recurring-template ids are recorded back on the quote
 * so it's idempotent.
 *
 * The deployed app writes zero to QBO — it just marks quotes signed; this worker
 * job is the only thing that touches QuickBooks.
 *
 *   npm run import-qbo-invoices
 *   npm run import-qbo-invoices -- --dry-run
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

interface Line { id: string; name: string; description?: string; qty: number; unitPriceCents: number; recurring: string; qboItemId?: string | null }

/** startDate + N months, same day-of-month (clamped by JS Date rollover for
 *  a short month, e.g. Jan 31 + 1 month → Mar 3, same as deal-side schedule
 *  math elsewhere in this system — acceptable for a billing-window edge). */
function addMonthsToYmd(startYmd: string, months: number): string {
  const parts = startYmd.split("-").map(Number);
  const y = parts[0] ?? 1970, m = parts[1] ?? 1, d = parts[2] ?? 1;
  const total = (m - 1) + months;
  const ny = y + Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const autoInvoice = (process.env.QBO_AUTO_INVOICE || "").trim().toLowerCase() === "true";
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    // Need an estimate whenever it's missing; an invoice when auto-invoicing
    // is on and one hasn't been created yet; or a recurring template when the
    // quote has monthly line items and hasn't gotten one yet (the LIKE check
    // avoids re-selecting a one-time-only quote forever, since its recurring
    // template id can never become non-null).
    const { rows } = await c.query<{
      id: string; quote_number: string | null; client_name: string; line_items_json: string | null;
      signed_email: string | null; signed_at: string | null; retainer_term_months: number | null;
      qbo_estimate_id: string | null; qbo_invoice_id: string | null; qbo_recurring_template_id: string | null;
    }>(
      `SELECT id, quote_number, client_name, line_items_json, signed_email, signed_at, retainer_term_months,
              qbo_estimate_id, qbo_invoice_id, qbo_recurring_template_id
         FROM pricing_quotes
        WHERE status = 'signed' AND kind = 'designer'
          AND (qbo_estimate_id IS NULL
               ${autoInvoice ? "OR qbo_invoice_id IS NULL" : ""}
               OR (qbo_recurring_template_id IS NULL AND line_items_json LIKE '%"recurring":"monthly"%'))
        ORDER BY signed_at ASC NULLS LAST
        LIMIT 50`,
    );
    console.log(`import-qbo-invoices — ${rows.length} signed quote(s) to sync${autoInvoice ? " (auto-invoice ON)" : ""}${dryRun ? " (dry-run)" : ""}`);
    if (rows.length === 0) return;

    const qbo = new QboClient(c);
    if (!dryRun) await qbo.connect();

    let done = 0, failed = 0;
    for (const r of rows) {
      let items: Line[] = [];
      try { items = r.line_items_json ? JSON.parse(r.line_items_json) : []; } catch { items = []; }
      const lines = items.map((i) => ({
        name: i.name || "Service",
        amount: ((i.unitPriceCents || 0) * (i.qty || 1)) / 100,
        itemId: i.qboItemId ?? null,
        monthly: i.recurring === "monthly",
      }));
      if (lines.length === 0) {
        console.log(`  skip ${r.quote_number}: no line items`);
        continue;
      }
      const monthlyLines = lines.filter((l) => l.monthly);
      const needEstimate = !r.qbo_estimate_id;
      const needInvoice = autoInvoice && !r.qbo_invoice_id;
      const needRecurring = monthlyLines.length > 0 && !r.qbo_recurring_template_id;
      if (dryRun) {
        const total = lines.reduce((s, l) => s + l.amount, 0).toFixed(2);
        console.log(`  would ${[needEstimate && "estimate", needInvoice && "invoice", needRecurring && "recurring template"].filter(Boolean).join(" + ")} for ${r.client_name} (${r.quote_number}) — $${total}`);
        done++; continue;
      }
      try {
        const customerId = await qbo.findOrCreateCustomer(r.client_name || "Client", r.signed_email);
        if (needEstimate) {
          const estimateId = await qbo.createEstimate(customerId, lines);
          await c.query(`UPDATE pricing_quotes SET qbo_estimate_id=$2, qbo_synced_at=now(), qbo_sync_error=NULL WHERE id=$1`, [r.id, estimateId]);
          console.log(`  ✓ ${r.client_name} (${r.quote_number}) → estimate ${estimateId}`);
        }
        if (needInvoice) {
          const invoiceId = await qbo.createInvoice(customerId, lines, { email: r.signed_email });
          await c.query(`UPDATE pricing_quotes SET qbo_invoice_id=$2, qbo_synced_at=now(), qbo_sync_error=NULL WHERE id=$1`, [r.id, invoiceId]);
          console.log(`  ✓ ${r.client_name} (${r.quote_number}) → invoice ${invoiceId}`);
        }
        if (needRecurring) {
          const startDate = r.signed_at ? ymd(new Date(r.signed_at)) : ymd(new Date());
          const endDate = r.retainer_term_months ? addMonthsToYmd(startDate, r.retainer_term_months) : null;
          const templateName = `${r.quote_number ?? r.client_name} — Monthly Retainer`;
          const recurringId = await qbo.createRecurringInvoiceTemplate(customerId, templateName, monthlyLines, startDate, endDate);
          await c.query(`UPDATE pricing_quotes SET qbo_recurring_template_id=$2, qbo_synced_at=now(), qbo_sync_error=NULL WHERE id=$1`, [r.id, recurringId]);
          console.log(`  ✓ ${r.client_name} (${r.quote_number}) → recurring template ${recurringId}${endDate ? ` (ends ${endDate})` : " (ongoing)"}`);
        }
        done++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await c.query(`UPDATE pricing_quotes SET qbo_sync_error=$2 WHERE id=$1`, [r.id, msg.slice(0, 500)]);
        console.log(`  ✗ ${r.client_name} (${r.quote_number}): ${msg}`);
        failed++;
      }
    }
    console.log(`Done: ${done} ${dryRun ? "to sync" : "synced"}, ${failed} failed.`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

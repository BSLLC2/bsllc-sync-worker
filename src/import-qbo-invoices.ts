#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { QboClient } from "./qbo.js";
import { ymd } from "./dates.js";
import { buildQuotePdf } from "./quote-pdf.js";

/**
 * On quote signature → QuickBooks. Finds signed (or legacy — see below)
 * quotes and, in the sandbox/prod company, creates:
 *   • an INVOICE — the one-time/setup line items, always created (no
 *     QBO_AUTO_INVOICE gate — an Estimate-only quote was never a real billing
 *     document, so this used to silently mean nothing landed in QBO at all
 *     unless that flag was set). Emailed to the signer if we have their
 *     address. The signed-quote PDF is attached to it.
 *   • a RECURRING INVOICE TEMPLATE, if the quote has any monthly line items —
 *     the retainer's actual ongoing billing, not just its one-time setup fee.
 *     Starts on the signature date; ends after retainer_term_months if the
 *     quote set one, else runs ongoing/evergreen. The signed-quote PDF is
 *     attached to the template's own invoice record too, though whether QBO
 *     carries that attachment onto each auto-generated monthly instance is
 *     unconfirmed — worth checking after the first one lands.
 * The invoice/recurring-template ids are recorded back on the quote so it's
 * idempotent.
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

/** Real recurring billing waits on the client's confirmed accounting/AP
 *  contact (accounting_setup_requests, written by the app's onboarding
 *  automation on close-won) — "the project officially begins once
 *  accounting is set up." Resolved via the quote's deal -> company -> client
 *  chain (pricing_quotes.client_id itself is a looser, often-null field, not
 *  reliable for a net-new signup). Defaults to "complete, no contact" (never
 *  blocks) whenever the chain doesn't resolve to a real, still-open request
 *  -- this gate exists to hold billing for a genuine pending ask, not to
 *  invent a new stall for data gaps (a legacy quote with no deal, a deal
 *  with no company yet, or a client that predates this feature).
 *  paysByCard/ccFeePct come along for the ride — most clients pay by
 *  check/ACH, but a client who opted into card payment on that same form
 *  gets a processing-fee line item added to their invoices (see withCcFee). */
async function resolveAccountingSetup(c: pg.Client, dealId: string | null): Promise<{ complete: boolean; email: string | null; ccEmails: string | null; paysByCard: boolean; ccFeePct: number | null }> {
  const notBlocked = { complete: true, email: null, ccEmails: null, paysByCard: false, ccFeePct: null };
  if (!dealId) return notBlocked;
  const { rows: dealRows } = await c.query<{ client_id: string | null }>(
    `SELECT co.client_id FROM deals d LEFT JOIN companies co ON co.id = d.company_id WHERE d.id = $1`,
    [dealId],
  );
  const clientId = dealRows[0]?.client_id;
  if (!clientId) return notBlocked;
  const { rows: reqRows } = await c.query<{ billing_email: string | null; cc_emails: string | null; completed_at: string | null; pays_by_card: boolean; cc_fee_pct: number | null }>(
    `SELECT billing_email, cc_emails, completed_at, pays_by_card, cc_fee_pct FROM accounting_setup_requests WHERE client_id = $1 ORDER BY requested_at DESC LIMIT 1`,
    [clientId],
  );
  const row = reqRows[0];
  if (!row) return notBlocked;
  return {
    complete: row.completed_at != null, email: row.billing_email, ccEmails: row.cc_emails,
    paysByCard: row.pays_by_card, ccFeePct: row.cc_fee_pct,
  };
}

interface QuoteLine { name: string; amount: number; itemId: string | null; monthly: boolean }

/** Append a processing-fee line item (a % of the given lines' subtotal) when
 *  the client opted into paying by card — the rare exception, so this only
 *  ever adds a line, never touches the base pricing lines. */
function withCcFee(lines: QuoteLine[], accounting: { paysByCard: boolean; ccFeePct: number | null }): QuoteLine[] {
  if (!accounting.paysByCard || !accounting.ccFeePct) return lines;
  const subtotal = lines.reduce((s, l) => s + l.amount, 0);
  const fee = Math.round(subtotal * (accounting.ccFeePct / 100) * 100) / 100;
  if (fee <= 0) return lines;
  return [...lines, { name: `Credit card processing fee (${accounting.ccFeePct}%)`, amount: fee, itemId: null, monthly: false }];
}

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    // Need an invoice whenever it's missing (always — no more Estimate-only
    // gate), or a recurring template when the quote has monthly line items
    // and hasn't gotten one yet (the LIKE check avoids re-selecting a
    // one-time-only quote forever, since its recurring template id can never
    // become non-null). 'legacy' = pricing already agreed outside this
    // system (a deal that predates Quote Designer, or the old CRM) and
    // recorded via POST /api/quotes/:id/mark-legacy with no client
    // signature — treated identically to 'signed' here so those deals still
    // get a real QBO invoice/recurring template instead of sitting with no
    // billing automation just because they never got a proper quote.
    const { rows } = await c.query<{
      id: string; quote_number: string | null; client_name: string; line_items_json: string | null;
      signed_name: string | null; signed_email: string | null; signed_at: string | null;
      retainer_term_months: number | null; deal_id: string | null;
      qbo_invoice_id: string | null; qbo_recurring_template_id: string | null;
    }>(
      `SELECT id, quote_number, client_name, line_items_json, signed_name, signed_email, signed_at, retainer_term_months, deal_id,
              qbo_invoice_id, qbo_recurring_template_id
         FROM pricing_quotes
        WHERE status IN ('signed', 'legacy') AND kind = 'designer'
          AND (qbo_invoice_id IS NULL
               OR (qbo_recurring_template_id IS NULL AND line_items_json LIKE '%"recurring":"monthly"%'))
        ORDER BY signed_at ASC NULLS LAST
        LIMIT 50`,
    );
    console.log(`import-qbo-invoices — ${rows.length} signed quote(s) to sync${dryRun ? " (dry-run)" : ""}`);
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
      const needInvoice = !r.qbo_invoice_id;
      const wantsRecurring = monthlyLines.length > 0 && !r.qbo_recurring_template_id;
      const accounting = (needInvoice || wantsRecurring)
        ? await resolveAccountingSetup(c, r.deal_id)
        : { complete: true, email: null, ccEmails: null, paysByCard: false, ccFeePct: null };
      const needRecurring = wantsRecurring && accounting.complete;
      if (dryRun) {
        const total = lines.reduce((s, l) => s + l.amount, 0).toFixed(2);
        const feeNote = accounting.paysByCard && accounting.ccFeePct ? ` (+${accounting.ccFeePct}% card fee)` : "";
        const parts = [needInvoice && "invoice", needRecurring && "recurring template", wantsRecurring && !accounting.complete && "recurring template (BLOCKED on accounting setup)"];
        console.log(`  would ${parts.filter(Boolean).join(" + ")} for ${r.client_name} (${r.quote_number}) — $${total}${feeNote}`);
        done++; continue;
      }
      try {
        const customerId = await qbo.findOrCreateCustomer(r.client_name || "Client", r.signed_email);
        const quotePdf = () => buildQuotePdf({
          quoteNumber: r.quote_number, clientName: r.client_name, lines,
          signedName: r.signed_name, signedEmail: r.signed_email, signedAt: r.signed_at,
        });
        if (needInvoice) {
          const invoiceId = await qbo.createInvoice(customerId, withCcFee(lines, accounting), { email: r.signed_email });
          await c.query(`UPDATE pricing_quotes SET qbo_invoice_id=$2, qbo_synced_at=now(), qbo_sync_error=NULL WHERE id=$1`, [r.id, invoiceId]);
          console.log(`  ✓ ${r.client_name} (${r.quote_number}) → invoice ${invoiceId}`);
          try {
            await qbo.attachPdfToInvoice(invoiceId, `${r.quote_number ?? "quote"}-signed.pdf`, await quotePdf());
          } catch (e) {
            console.log(`  … ${r.client_name} (${r.quote_number}): couldn't attach signed quote to invoice ${invoiceId}: ${e instanceof Error ? e.message : e}`);
          }
        }
        if (wantsRecurring && !accounting.complete) {
          console.log(`  … ${r.client_name} (${r.quote_number}): recurring template held — waiting on accounting setup`);
        }
        if (needRecurring) {
          const startDate = r.signed_at ? ymd(new Date(r.signed_at)) : ymd(new Date());
          const endDate = r.retainer_term_months ? addMonthsToYmd(startDate, r.retainer_term_months) : null;
          const templateName = `${r.quote_number ?? r.client_name} — Monthly Retainer`;
          const recurringId = await qbo.createRecurringInvoiceTemplate(customerId, templateName, withCcFee(monthlyLines, accounting), startDate, endDate, {
            email: accounting.email ?? r.signed_email, ccEmails: accounting.ccEmails,
          });
          await c.query(`UPDATE pricing_quotes SET qbo_recurring_template_id=$2, qbo_synced_at=now(), qbo_sync_error=NULL WHERE id=$1`, [r.id, recurringId]);
          console.log(`  ✓ ${r.client_name} (${r.quote_number}) → recurring template ${recurringId}${endDate ? ` (ends ${endDate})` : " (ongoing)"}`);
          // Attaches to the template's own underlying Invoice record. Whether
          // QBO carries this onto each auto-generated monthly instance is
          // unconfirmed -- check after the first one lands.
          try {
            await qbo.attachPdfToInvoice(recurringId, `${r.quote_number ?? "quote"}-signed.pdf`, await quotePdf());
          } catch (e) {
            console.log(`  … ${r.client_name} (${r.quote_number}): couldn't attach signed quote to recurring template ${recurringId}: ${e instanceof Error ? e.message : e}`);
          }
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

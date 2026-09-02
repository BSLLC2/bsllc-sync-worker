#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { QboClient } from "./qbo.js";
import { ymd } from "./dates.js";
import { buildQuotePdf } from "./quote-pdf.js";

/**
 * On quote signature → QuickBooks, once an AM presses "Launch invoicing" on
 * the client's Onboarding timeline (see resolveAccountingSetup). Finds
 * signed (or legacy — see below) quotes ready to invoice and, in the
 * sandbox/prod company, creates:
 *   • an INVOICE — the one-time/setup line items. Emailed to the signer if
 *     we have their address. The signed-quote PDF is attached to it.
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

interface BillingAddress { line1: string | null; line2: string | null; city: string | null; state: string | null; postalCode: string | null; country: string | null }

/** Real billing waits on two human checkpoints: the client's confirmed
 *  accounting/AP contact (accounting_setup_requests.completed_at, written by
 *  the app's onboarding automation on close-won), AND an AM's explicit
 *  "Launch invoicing" click on the client's Onboarding timeline
 *  (invoicing_launched_at) — nothing hits QuickBooks just because a form got
 *  filled out. Resolved via the quote's deal -> company -> client chain
 *  (pricing_quotes.client_id itself is a looser, often-null field, not
 *  reliable for a net-new signup). Defaults to "complete + launched, no
 *  contact" (never blocks) whenever the chain doesn't resolve to a real,
 *  still-open request -- this gate exists to hold billing for a genuine
 *  pending ask, not to invent a new stall for data gaps (a legacy quote with
 *  no deal, a deal with no company yet, or a client that predates this
 *  feature). paysByCard/ccFeePct come along for the ride — most clients pay
 *  by check/ACH, but a client who opted into card payment on that same form
 *  gets a processing-fee line item added to their invoices (see withCcFee).
 *
 *  phone/contactName/address are best-effort extras for the QBO Customer
 *  record itself (see qbo.findOrCreateCustomer) -- never gate anything on
 *  them. contactName/phone come from the dedicated accounting-setup ask;
 *  address only ever comes from the fuller onboarding wizard (the
 *  accounting-setup form itself has no address field), so both sources are
 *  joined in and whichever has a contact name/phone wins (accounting-setup's
 *  is the more likely to be current, since it can be resubmitted on its own
 *  without redoing the whole onboarding sequence). */
async function resolveAccountingSetup(c: pg.Client, dealId: string | null): Promise<{ complete: boolean; launched: boolean; email: string | null; ccEmails: string | null; paysByCard: boolean; ccFeePct: number | null; contactName: string | null; phone: string | null; address: BillingAddress | null }> {
  const notBlocked = { complete: true, launched: true, email: null, ccEmails: null, paysByCard: false, ccFeePct: null, contactName: null, phone: null, address: null };
  if (!dealId) return notBlocked;
  const { rows: dealRows } = await c.query<{ client_id: string | null }>(
    `SELECT co.client_id FROM deals d LEFT JOIN companies co ON co.id = d.company_id WHERE d.id = $1`,
    [dealId],
  );
  const clientId = dealRows[0]?.client_id;
  if (!clientId) return notBlocked;
  const { rows: reqRows } = await c.query<{
    billing_email: string | null; cc_emails: string | null; completed_at: string | null; invoicing_launched_at: string | null;
    pays_by_card: boolean; cc_fee_pct: number | null; contact_name: string | null; phone: string | null;
    ob_contact_name: string | null; ob_phone: string | null;
    ob_line1: string | null; ob_line2: string | null; ob_city: string | null; ob_state: string | null; ob_postal: string | null; ob_country: string | null;
  }>(
    `SELECT a.billing_email, a.cc_emails, a.completed_at, a.invoicing_launched_at, a.pays_by_card, a.cc_fee_pct,
            a.contact_name, a.phone,
            ob.billing_contact_name AS ob_contact_name, ob.billing_phone AS ob_phone,
            ob.billing_address_line1 AS ob_line1, ob.billing_address_line2 AS ob_line2,
            ob.billing_city AS ob_city, ob.billing_state AS ob_state,
            ob.billing_postal_code AS ob_postal, ob.billing_country AS ob_country
       FROM accounting_setup_requests a
       LEFT JOIN LATERAL (
         SELECT * FROM client_onboarding_submissions
          WHERE client_id = a.client_id ORDER BY created_at DESC LIMIT 1
       ) ob ON true
      WHERE a.client_id = $1
      ORDER BY a.requested_at DESC LIMIT 1`,
    [clientId],
  );
  const row = reqRows[0];
  if (!row) return notBlocked;
  const address: BillingAddress | null = (row.ob_line1 || row.ob_city)
    ? { line1: row.ob_line1, line2: row.ob_line2, city: row.ob_city, state: row.ob_state, postalCode: row.ob_postal, country: row.ob_country }
    : null;
  return {
    complete: row.completed_at != null, launched: row.invoicing_launched_at != null,
    email: row.billing_email, ccEmails: row.cc_emails,
    paysByCard: row.pays_by_card, ccFeePct: row.cc_fee_pct,
    contactName: row.contact_name ?? row.ob_contact_name, phone: row.phone ?? row.ob_phone,
    address,
  };
}

interface QuoteLine { name: string; description: string | null; amount: number; itemId: string | null; monthly: boolean }

/** Append a processing-fee line item (a % of the given lines' subtotal) when
 *  the client opted into paying by card — the rare exception, so this only
 *  ever adds a line, never touches the base pricing lines. */
function withCcFee(lines: QuoteLine[], accounting: { paysByCard: boolean; ccFeePct: number | null }): QuoteLine[] {
  if (!accounting.paysByCard || !accounting.ccFeePct) return lines;
  const subtotal = lines.reduce((s, l) => s + l.amount, 0);
  const fee = Math.round(subtotal * (accounting.ccFeePct / 100) * 100) / 100;
  if (fee <= 0) return lines;
  return [...lines, { name: `Credit card processing fee (${accounting.ccFeePct}%)`, description: null, amount: fee, itemId: null, monthly: false }];
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
      signed_name: string | null; signed_email: string | null; signed_at: string | null; signed_ip: string | null;
      retainer_term_months: number | null; deal_id: string | null; company_id: string | null; company_name: string | null;
      qbo_invoice_id: string | null; qbo_recurring_template_id: string | null; qbo_invoice_sent_at: string | null;
      comments: string | null; sow_text: string | null; contract_text: string | null;
      payment_terms: string | null; payment_months: number | null;
      deposit_cents: number | null; deposit_type: string | null; deposit_percent: number | null;
      accepted_price_cents: number | null; terms_label: string | null;
    }>(
      `SELECT q.id, q.quote_number, q.client_name, q.line_items_json, q.signed_name, q.signed_email, q.signed_at, q.signed_ip,
              q.retainer_term_months, q.deal_id, q.company_id, co.name AS company_name,
              q.qbo_invoice_id, q.qbo_recurring_template_id, q.qbo_invoice_sent_at,
              q.comments, q.sow_text, q.contract_text, q.payment_terms, q.payment_months,
              q.deposit_cents, q.deposit_type, q.deposit_percent, q.accepted_price_cents,
              tv.label AS terms_label
         FROM pricing_quotes q
         LEFT JOIN companies co ON co.id = q.company_id
         LEFT JOIN terms_versions tv ON tv.id = q.accepted_terms_version_id
        WHERE q.status IN ('signed', 'legacy') AND q.kind = 'designer'
          AND (q.qbo_invoice_id IS NULL
               OR (q.qbo_recurring_template_id IS NULL AND q.line_items_json LIKE '%"recurring":"monthly"%')
               -- Invoice already exists in QBO but was never emailed (created
               -- before a billing contact was confirmed, e.g. via
               -- skipAccountingSetup) -- revisit every run until a real
               -- billing email shows up and we can actually send it.
               OR (q.qbo_invoice_id IS NOT NULL AND q.qbo_invoice_sent_at IS NULL))
        ORDER BY q.signed_at ASC NULLS LAST
        LIMIT 50`,
    );
    console.log(`import-qbo-invoices — ${rows.length} signed quote(s) to sync${dryRun ? " (dry-run)" : ""}`);
    if (rows.length === 0) return;

    const qbo = new QboClient(c);
    if (!dryRun) await qbo.connect();

    // Defense-in-depth against ever double-billing a customer again --
    // confirmed live 2026-09-01 that a one-time invoice + a recurring
    // template's own first cycle could land the same day (see the
    // oneTimeLines fix above for the actual root cause of that one). This
    // doesn't depend on understanding every future code path that could
    // create an invoice; it just refuses to create a NEW one-time invoice
    // for a customer QBO's own records show was already billed within the
    // last MIN_DAYS_BETWEEN_INVOICES days, full stop. Not checked in
    // dry-run (no QBO connection yet at that point) -- a dry-run preview
    // may show a hold that a real run would actually apply.
    const MIN_DAYS_BETWEEN_INVOICES = 15;
    const lastInvoiceDateByCustomer = new Map<string, string>();
    if (!dryRun) {
      for (const inv of await qbo.getInvoices()) {
        if (!inv.customerId || !inv.txnDate) continue;
        const prev = lastInvoiceDateByCustomer.get(inv.customerId);
        if (!prev || inv.txnDate > prev) lastInvoiceDateByCustomer.set(inv.customerId, inv.txnDate);
      }
    }

    let done = 0, failed = 0;
    for (const r of rows) {
      let items: Line[] = [];
      try { items = r.line_items_json ? JSON.parse(r.line_items_json) : []; } catch { items = []; }
      const lines = items.map((i) => ({
        name: i.name || "Service",
        description: i.description || null,
        amount: ((i.unitPriceCents || 0) * (i.qty || 1)) / 100,
        itemId: i.qboItemId ?? null,
        monthly: i.recurring === "monthly",
      }));
      if (lines.length === 0) {
        console.log(`  skip ${r.quote_number}: no line items`);
        continue;
      }
      const monthlyLines = lines.filter((l) => l.monthly);
      // The recurring template (below) bills every monthly line every cycle,
      // including its very first one -- confirmed live 2026-09-01: Integrus
      // (a retainer-only quote, no one-time lines) got double-billed $5,000
      // because this one-time invoice used to include the monthly lines too,
      // then the template's first cycle fired the same day and billed them
      // again. Only genuinely one-time lines belong on this invoice; a
      // quote with nothing one-time to bill (retainer-only) gets no separate
      // invoice at all -- the recurring template's first cycle is the bill.
      const oneTimeLines = lines.filter((l) => !l.monthly);
      const wantsInvoice = !r.qbo_invoice_id && oneTimeLines.length > 0;
      const wantsRecurring = monthlyLines.length > 0 && !r.qbo_recurring_template_id;
      // An invoice that already exists in QBO but was created with no
      // billing email (e.g. pushed via skipAccountingSetup, so nothing
      // spammy went out before the real contact was confirmed) -- revisit
      // every run until one shows up, then update the QBO customer's own
      // email and actually send it. Deliberately does NOT require
      // accounting.launched below: invoicing was obviously already launched
      // if the invoice exists, and requestAccountingSetupUpdate's fresh row
      // never carries invoicing_launched_at forward, so gating on it here
      // would make this un-satisfiable forever.
      const wantsSendExisting = !!r.qbo_invoice_id && !r.qbo_invoice_sent_at;
      const accounting = (wantsInvoice || wantsRecurring || wantsSendExisting)
        ? await resolveAccountingSetup(c, r.deal_id)
        : { complete: true, launched: true, email: null, ccEmails: null, paysByCard: false, ccFeePct: null, contactName: null, phone: null, address: null };
      // Nothing hits QuickBooks until both the billing contact is confirmed
      // AND an AM has pressed "Launch invoicing" on the client's Onboarding
      // timeline — see resolveAccountingSetup.
      const canInvoice = accounting.complete && accounting.launched;
      const needInvoice = wantsInvoice && canInvoice;
      const needRecurring = wantsRecurring && canInvoice;
      const needSendExisting = wantsSendExisting && accounting.complete && !!accounting.email;
      if (dryRun) {
        const total = lines.reduce((s, l) => s + l.amount, 0).toFixed(2);
        const feeNote = accounting.paysByCard && accounting.ccFeePct ? ` (+${accounting.ccFeePct}% card fee)` : "";
        const blockedNote = !canInvoice ? (accounting.complete ? " (BLOCKED on invoicing launch)" : " (BLOCKED on accounting setup)") : "";
        const parts = [
          needInvoice && "invoice", needRecurring && "recurring template",
          !canInvoice && (wantsInvoice || wantsRecurring) && `${[wantsInvoice && "invoice", wantsRecurring && "recurring template"].filter(Boolean).join("/")}${blockedNote}`,
          needSendExisting && `send previously-unsent invoice ${r.qbo_invoice_id} to ${accounting.email}`,
          wantsSendExisting && !needSendExisting && `invoice ${r.qbo_invoice_id} still has no billing email — nothing to send yet`,
        ];
        console.log(`  would ${parts.filter(Boolean).join(" + ")} for ${r.client_name} (${r.quote_number}) — $${total}${feeNote}`);
        done++; continue;
      }
      try {
        const customerId = await qbo.findOrCreateCustomer(r.client_name || "Client", {
          email: accounting.email ?? r.signed_email,
          phone: accounting.phone,
          address: accounting.address,
        });
        // Auto-link the CRM company to this QBO customer the moment we
        // find-or-create it, instead of leaving an AM to notice the
        // "QuickBooks customers" card on the Company page is empty and link
        // it by hand every time — confirmed live this session that even
        // Integrus's own company record needed a manual link after this
        // exact script created its customer/invoice/recurring template.
        if (r.company_id) {
          await c.query(
            `INSERT INTO company_qbo_customers (id, company_id, qbo_customer_id) VALUES ($1, $2, $3)
             ON CONFLICT (company_id, qbo_customer_id) DO NOTHING`,
            [randomUUID(), r.company_id, customerId],
          );
        }
        const quotePdf = () => buildQuotePdf({
          quoteNumber: r.quote_number, clientName: r.client_name, companyName: r.company_name,
          lines: items.map((i) => ({
            name: i.name || "Service", description: i.description || null,
            qty: i.qty || 1, unitPriceCents: i.unitPriceCents || 0, monthly: i.recurring === "monthly",
          })),
          comments: r.comments, sowText: r.sow_text, contractText: r.contract_text,
          paymentTerms: r.payment_terms, paymentMonths: r.payment_months,
          depositCents: r.deposit_cents, depositType: r.deposit_type, depositPercent: r.deposit_percent,
          retainerTermMonths: r.retainer_term_months, acceptedPriceCents: r.accepted_price_cents,
          signedName: r.signed_name, signedEmail: r.signed_email, signedAt: r.signed_at, signedIp: r.signed_ip,
          termsLabel: r.terms_label,
        });
        const lastBilledDate = lastInvoiceDateByCustomer.get(customerId);
        const daysSinceLastBill = lastBilledDate ? Math.round((Date.now() - new Date(lastBilledDate).getTime()) / 86_400_000) : null;
        const tooSoonToInvoice = needInvoice && daysSinceLastBill != null && daysSinceLastBill < MIN_DAYS_BETWEEN_INVOICES;
        if (tooSoonToInvoice) {
          const msg = `Held: QBO shows this customer was already billed ${daysSinceLastBill}d ago (${lastBilledDate}) -- refusing to create another invoice within ${MIN_DAYS_BETWEEN_INVOICES}d. Needs manual review.`;
          await c.query(`UPDATE pricing_quotes SET qbo_sync_error=$2 WHERE id=$1`, [r.id, msg]);
          console.log(`  ⚠ ${r.client_name} (${r.quote_number}): ${msg}`);
        }
        if (needInvoice && !tooSoonToInvoice) {
          const billTo = accounting.email ?? r.signed_email;
          const invoiceId = await qbo.createInvoice(customerId, withCcFee(oneTimeLines, accounting), { email: billTo, allowOnlinePayment: accounting.paysByCard });
          await c.query(`UPDATE pricing_quotes SET qbo_invoice_id=$2, qbo_synced_at=now(), qbo_sync_error=NULL WHERE id=$1`, [r.id, invoiceId]);
          console.log(`  ✓ ${r.client_name} (${r.quote_number}) → invoice ${invoiceId}`);
          try {
            await qbo.attachPdfToInvoice(invoiceId, `${r.quote_number ?? "quote"}-signed.pdf`, await quotePdf());
          } catch (e) {
            console.log(`  … ${r.client_name} (${r.quote_number}): couldn't attach signed quote to invoice ${invoiceId}: ${e instanceof Error ? e.message : e}`);
          }
          // Creating the invoice does NOT email it -- QBO only marks it
          // "needs to be sent" until a separate send call fires. Without
          // this, every auto-created invoice sat in QBO undelivered.
          if (billTo) {
            try {
              await qbo.sendInvoice(invoiceId, billTo);
              await c.query(`UPDATE pricing_quotes SET qbo_invoice_sent_at=now() WHERE id=$1`, [r.id]);
            } catch (e) {
              console.log(`  … ${r.client_name} (${r.quote_number}): couldn't send invoice ${invoiceId} to ${billTo}: ${e instanceof Error ? e.message : e}`);
            }
          } else {
            console.log(`  … ${r.client_name} (${r.quote_number}): invoice ${invoiceId} created but not sent -- no billing email on file. Will retry sending once one shows up.`);
          }
        }
        if ((wantsInvoice || wantsRecurring) && !canInvoice) {
          console.log(`  … ${r.client_name} (${r.quote_number}): held — waiting on ${accounting.complete ? "invoicing launch" : "accounting setup"}`);
        }
        // The client's real billing contact just showed up (via a later
        // accounting-setup update) for an invoice we already created without
        // one -- override the QBO customer's own email and finally send it,
        // instead of leaving a fully-created invoice sitting undelivered
        // forever. See the wantsSendExisting comment above.
        if (needSendExisting && r.qbo_invoice_id) {
          try {
            await qbo.updateCustomerEmail(customerId, accounting.email as string);
            await qbo.sendInvoice(r.qbo_invoice_id, accounting.email);
            await c.query(`UPDATE pricing_quotes SET qbo_invoice_sent_at=now() WHERE id=$1`, [r.id]);
            console.log(`  ✓ ${r.client_name} (${r.quote_number}): billing contact confirmed — sent invoice ${r.qbo_invoice_id} to ${accounting.email}`);
          } catch (e) {
            console.log(`  … ${r.client_name} (${r.quote_number}): couldn't send existing invoice ${r.qbo_invoice_id} to ${accounting.email}: ${e instanceof Error ? e.message : e}`);
          }
        } else if (wantsSendExisting && !needSendExisting) {
          console.log(`  … ${r.client_name} (${r.quote_number}): invoice ${r.qbo_invoice_id} still has no billing email on file — nothing to send yet.`);
        }
        if (needRecurring) {
          const startDate = r.signed_at ? ymd(new Date(r.signed_at)) : ymd(new Date());
          const endDate = r.retainer_term_months ? addMonthsToYmd(startDate, r.retainer_term_months) : null;
          // Leads with the client's name so it's actually findable by
          // searching QBO's global Recurring Transactions list (confirmed
          // live 2026-09-01: a name like "Q-1006 — Monthly Retainer" with no
          // client name in it doesn't turn up searching "integrus", even
          // though the template is genuinely real and correctly tied to that
          // customer). legacyTemplateName is the old format -- matched below
          // too so a template already created under it (e.g. Integrus's
          // Q-1006) is still found as "existing" instead of duplicated.
          const templateName = `${r.client_name} — Monthly Retainer${r.quote_number ? ` (${r.quote_number})` : ""}`;
          const legacyTemplateName = `${r.quote_number ?? r.client_name} — Monthly Retainer`;
          // Guard against creating a second template for the same quote --
          // a template can succeed in QBO (200) and then the id never make
          // it back to qbo_recurring_template_id if anything after the
          // create call throws (confirmed live 2026-09-01: a response-shape
          // bug did exactly this), and this row's own retry logic has no
          // other way to know one already exists. Cheap since it's the same
          // query getRecurringInvoiceTemplates() already knows how to run.
          const existingTemplates = (await qbo.getRecurringInvoiceTemplates()) as { Invoice?: { Id?: string; CustomerRef?: { value?: string }; RecurringInfo?: { Name?: string } } }[];
          const existing = existingTemplates.find((t) => t.Invoice?.CustomerRef?.value === customerId
            && (t.Invoice?.RecurringInfo?.Name === templateName || t.Invoice?.RecurringInfo?.Name === legacyTemplateName));
          const recurringId = existing?.Invoice?.Id
            ?? await qbo.createRecurringInvoiceTemplate(customerId, templateName, withCcFee(monthlyLines, accounting), startDate, endDate, {
              email: accounting.email ?? r.signed_email, ccEmails: accounting.ccEmails, allowOnlinePayment: accounting.paysByCard,
            });
          await c.query(`UPDATE pricing_quotes SET qbo_recurring_template_id=$2, qbo_synced_at=now(), qbo_sync_error=NULL WHERE id=$1`, [r.id, recurringId]);
          console.log(existing
            ? `  ✓ ${r.client_name} (${r.quote_number}) → found existing recurring template ${recurringId} (recovered from a prior run)`
            : `  ✓ ${r.client_name} (${r.quote_number}) → recurring template ${recurringId}${endDate ? ` (ends ${endDate})` : " (ongoing)"}`);
          if (r.company_id) {
            // Seed a minimal qbo_recurring_invoices row so the Company page's
            // "QuickBooks recurring line items" link resolves to a real name
            // immediately, instead of showing "Untitled" until the next
            // separate import-qbo-invoices-sync run overwrites it with QBO's
            // own interval/next-date fields.
            const monthlyTotalCents = Math.round(monthlyLines.reduce((s, l) => s + l.amount, 0) * 100);
            await c.query(
              `INSERT INTO qbo_recurring_invoices (id, customer_id, customer_name, template_name, amount_cents, active, start_date)
               VALUES ($1, $2, $3, $4, $5, true, $6)
               ON CONFLICT (id) DO NOTHING`,
              [recurringId, customerId, r.client_name, templateName, monthlyTotalCents, startDate],
            );
            await c.query(
              `INSERT INTO company_qbo_recurring_invoices (id, company_id, qbo_recurring_invoice_id) VALUES ($1, $2, $3)
               ON CONFLICT (company_id, qbo_recurring_invoice_id) DO NOTHING`,
              [randomUUID(), r.company_id, recurringId],
            );
          }
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

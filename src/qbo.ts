import "dotenv/config";
import type pg from "pg";

/**
 * Minimal QuickBooks Online client for the worker. Auth is OAuth2 with a
 * refresh token that Intuit ROTATES on use — so the latest token is persisted
 * in the shared Postgres `integration_tokens` table (seeded once from env), not
 * a static secret that would go stale.
 *
 * Env:
 *   QBO_CLIENT_ID, QBO_CLIENT_SECRET   — from the app's Keys page
 *   QBO_REALM_ID                       — the company id (sandbox or prod)
 *   QBO_REFRESH_TOKEN                  — seed refresh token (first run only)
 *   QBO_ENV                            — "sandbox" | "production"
 *   QBO_DEFAULT_ITEM_ID                — QBO Item to bill lines against (default "1")
 */
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
function apiBase(): string {
  return (process.env.QBO_ENV || "sandbox") === "production"
    ? "https://quickbooks.api.intuit.com"
    : "https://sandbox-quickbooks.api.intuit.com";
}
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

interface TokenData { refresh_token: string; realm_id?: string; }

export class QboClient {
  private accessToken: string | null = null;
  constructor(private db: pg.Client) {}

  /** Current refresh token: from the DB store, else the env seed on first run. */
  private async loadToken(): Promise<TokenData> {
    const { rows } = await this.db.query<{ data: string }>(`SELECT data FROM integration_tokens WHERE provider='qbo'`);
    if (rows[0]) {
      try { const d = JSON.parse(rows[0].data) as TokenData; if (d.refresh_token) return d; } catch { /* fall through */ }
    }
    return { refresh_token: env("QBO_REFRESH_TOKEN"), realm_id: process.env.QBO_REALM_ID?.trim() };
  }
  private async saveToken(d: TokenData): Promise<void> {
    await this.db.query(
      `INSERT INTO integration_tokens (provider, data, updated_at) VALUES ('qbo', $1, now())
         ON CONFLICT (provider) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [JSON.stringify(d)],
    );
  }
  get realmId(): string { return env("QBO_REALM_ID"); }

  /** Exchange the refresh token for an access token; persist the rotated one. */
  async connect(): Promise<void> {
    const tok = await this.loadToken();
    const basic = Buffer.from(`${env("QBO_CLIENT_ID")}:${env("QBO_CLIENT_SECRET")}`).toString("base64");
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.refresh_token }),
    });
    const text = await res.text();
    // intuit_tid is Intuit's request-trace id (response header). Capturing it in
    // logs + error records lets Intuit support pinpoint a failed call fast.
    const tid = res.headers.get("intuit_tid") ?? "";
    if (!res.ok) throw new Error(`QBO token refresh ${res.status} [intuit_tid=${tid}]: ${text}`);
    const j = JSON.parse(text) as { access_token: string; refresh_token: string };
    this.accessToken = j.access_token;
    // Persist the (possibly rotated) refresh token so the next run stays valid.
    await this.saveToken({ refresh_token: j.refresh_token, realm_id: tok.realm_id ?? this.realmId });
  }

  private async call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.accessToken) await this.connect();
    const res = await fetch(`${apiBase()}/v3/company/${this.realmId}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.accessToken}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const tid = res.headers.get("intuit_tid") ?? "";
    // Trace every call in the run log so a shared log ties back to Intuit's tid.
    console.log(`  qbo ${method} ${path.split("?")[0]} ${res.status} intuit_tid=${tid || "-"}`);
    if (!res.ok) throw new Error(`QBO ${method} ${path} ${res.status} [intuit_tid=${tid}]: ${text}`);
    return JSON.parse(text) as T;
  }

  /** Read-only connectivity check: forces an auth handshake (validates client
   *  id/secret + refresh token + realm) and reads the connected company's name.
   *  Creates nothing. Used by verify-qbo to confirm secrets before go-live. */
  async ping(): Promise<{ realmId: string; companyName: string }> {
    const info = await this.call<{ CompanyInfo?: { CompanyName?: string } }>("GET", `companyinfo/${this.realmId}`);
    return { realmId: this.realmId, companyName: info.CompanyInfo?.CompanyName ?? "(name unavailable)" };
  }

  /** Read-only. Same Accounting API scope as everything above — no separate
   *  Reports consent. Dates are YYYY-MM-DD. */
  async getProfitAndLoss(startDate: string, endDate: string): Promise<QboReport> {
    return this.call<QboReport>("GET", `reports/ProfitAndLoss?start_date=${startDate}&end_date=${endDate}&summarize_column_by=Total`);
  }
  /** Point-in-time report — QBO's BalanceSheet takes only end_date. */
  async getBalanceSheet(asOfDate: string): Promise<QboReport> {
    return this.call<QboReport>("GET", `reports/BalanceSheet?end_date=${asOfDate}&summarize_column_by=Total`);
  }
  async getCashFlow(startDate: string, endDate: string): Promise<QboReport> {
    return this.call<QboReport>("GET", `reports/CashFlow?start_date=${startDate}&end_date=${endDate}&summarize_column_by=Total`);
  }
  /** Current balance of every bank/cash account — more direct and reliable
   *  than parsing a cash line out of the BalanceSheet report's nested rows. */
  async getCashAccounts(): Promise<{ id: string; name: string; balance: number }[]> {
    const q = encodeURIComponent(`SELECT Id, Name, CurrentBalance FROM Account WHERE AccountType = 'Bank' AND Active = true`);
    const res = await this.call<{ QueryResponse?: { Account?: { Id: string; Name: string; CurrentBalance?: number }[] } }>("GET", `query?query=${q}`);
    return (res.QueryResponse?.Account ?? []).map((a) => ({ id: a.Id, name: a.Name, balance: a.CurrentBalance ?? 0 }));
  }

  /** Every active QBO customer — id, display name, fully-qualified name
   *  (QBO's own "Parent:Child" path for a sub-customer/project — what the
   *  UI's "Client/Vendor" column actually shows, distinct from DisplayName
   *  which is just the sub-customer's own short name), and parentId (the
   *  immediate parent's Customer Id, unset for a top-level customer).
   *  Paginated (QBO caps a single query at 1000 rows). Read-only; feeds the
   *  "link this CRM company to its QBO customer" picker AND lets the app
   *  walk a sub-customer up to its top-level parent without guessing from
   *  names. */
  async getCustomers(): Promise<{ id: string; name: string; fullyQualifiedName: string | null; parentId: string | null }[]> {
    const out: { id: string; name: string; fullyQualifiedName: string | null; parentId: string | null }[] = [];
    let start = 1;
    for (;;) {
      const q = encodeURIComponent(`SELECT Id, DisplayName, FullyQualifiedName, ParentRef FROM Customer WHERE Active = true STARTPOSITION ${start} MAXRESULTS 1000`);
      const res = await this.call<{ QueryResponse?: { Customer?: { Id: string; DisplayName?: string; FullyQualifiedName?: string; ParentRef?: { value?: string } }[] } }>("GET", `query?query=${q}`);
      const page = res.QueryResponse?.Customer ?? [];
      out.push(...page.map((c) => ({
        id: c.Id, name: c.DisplayName ?? "",
        fullyQualifiedName: c.FullyQualifiedName ?? null,
        parentId: c.ParentRef?.value ?? null,
      })));
      if (page.length < 1000) break;
      start += 1000;
    }
    return out;
  }

  /** Every invoice — id, doc number, date, total, and which customer it's
   *  billed to. Paginated the same way. Read-only; this is the real "has
   *  this customer actually been invoiced" signal our own quote-tracking
   *  marker can't see for anything billed outside Quote Designer. */
  async getInvoices(): Promise<{ id: string; docNumber: string | null; txnDate: string | null; dueDate: string | null; totalAmt: number; balance: number; customerId: string | null; customerName: string | null }[]> {
    const out: { id: string; docNumber: string | null; txnDate: string | null; dueDate: string | null; totalAmt: number; balance: number; customerId: string | null; customerName: string | null }[] = [];
    let start = 1;
    for (;;) {
      const q = encodeURIComponent(`SELECT Id, DocNumber, TxnDate, DueDate, TotalAmt, Balance, CustomerRef FROM Invoice STARTPOSITION ${start} MAXRESULTS 1000`);
      const res = await this.call<{ QueryResponse?: { Invoice?: { Id: string; DocNumber?: string; TxnDate?: string; DueDate?: string; TotalAmt?: number; Balance?: number; CustomerRef?: { value?: string; name?: string } }[] } }>("GET", `query?query=${q}`);
      const page = res.QueryResponse?.Invoice ?? [];
      out.push(...page.map((i) => ({
        id: i.Id, docNumber: i.DocNumber ?? null, txnDate: i.TxnDate ?? null, dueDate: i.DueDate ?? null,
        totalAmt: i.TotalAmt ?? 0, balance: i.Balance ?? 0,
        customerId: i.CustomerRef?.value ?? null, customerName: i.CustomerRef?.name ?? null,
      })));
      if (page.length < 1000) break;
      start += 1000;
    }
    return out;
  }

  /** Every payment, exploded to one row per invoice it was applied to (a
   *  single payment can cover several invoices at once) — lets us measure
   *  each customer's REAL historical days-to-pay (payment date minus the
   *  invoice's txn date) instead of assuming everyone pays on their stated
   *  terms. Line[].LinkedTxn is QBO's standard payment-application shape. */
  async getPayments(): Promise<{ paymentId: string; invoiceId: string; customerId: string | null; txnDate: string | null; amount: number }[]> {
    const out: { paymentId: string; invoiceId: string; customerId: string | null; txnDate: string | null; amount: number }[] = [];
    let start = 1;
    for (;;) {
      const q = encodeURIComponent(`SELECT Id, TxnDate, CustomerRef, Line FROM Payment STARTPOSITION ${start} MAXRESULTS 1000`);
      const res = await this.call<{ QueryResponse?: { Payment?: { Id: string; TxnDate?: string; CustomerRef?: { value?: string }; Line?: { Amount?: number; LinkedTxn?: { TxnId?: string; TxnType?: string }[] }[] }[] } }>("GET", `query?query=${q}`);
      const page = res.QueryResponse?.Payment ?? [];
      for (const p of page) {
        for (const line of p.Line ?? []) {
          for (const linked of line.LinkedTxn ?? []) {
            if (linked.TxnType !== "Invoice" || !linked.TxnId) continue;
            out.push({ paymentId: p.Id, invoiceId: linked.TxnId, customerId: p.CustomerRef?.value ?? null, txnDate: p.TxnDate ?? null, amount: line.Amount ?? 0 });
          }
        }
      }
      if (page.length < 1000) break;
      start += 1000;
    }
    return out;
  }

  /** Active recurring-invoice templates — a client with a template set up
   *  counts as "billing is arranged" even before its next line-item invoice
   *  actually generates. QBO's RecurringTransaction shape nests the template
   *  under a key named after its type ("Invoice" here) alongside a shared
   *  RecurringInfo block — logged raw on first encounter (see
   *  import-qbo-invoices-sync.ts) since Intuit's docs for this entity are
   *  thin and worth confirming against a real response once. */
  async getRecurringInvoiceTemplates(): Promise<unknown[]> {
    const q = encodeURIComponent(`SELECT * FROM RecurringTransaction`);
    const res = await this.call<{ QueryResponse?: { RecurringTransaction?: unknown[] } }>("GET", `query?query=${q}`);
    return res.QueryResponse?.RecurringTransaction ?? [];
  }

  /** Every Product/Service item — id, name, description, type, unit price,
   *  active flag, and income account name. Read-only; feeds
   *  import-qbo-items.ts's sync into qbo_catalog_items so Quote Designer can
   *  offer a live picker instead of every line silently billing against one
   *  hardcoded default item. Fetches everything (not just Active = true) so
   *  a since-deactivated item a past quote still references stays
   *  resolvable; the sync marks it inactive rather than deleting it. */
  async getItems(): Promise<{ id: string; name: string; description: string | null; type: string | null; unitPrice: number | null; active: boolean; incomeAccountName: string | null }[]> {
    const out: { id: string; name: string; description: string | null; type: string | null; unitPrice: number | null; active: boolean; incomeAccountName: string | null }[] = [];
    let start = 1;
    for (;;) {
      const q = encodeURIComponent(`SELECT Id, Name, Description, Type, UnitPrice, Active, IncomeAccountRef FROM Item STARTPOSITION ${start} MAXRESULTS 1000`);
      const res = await this.call<{ QueryResponse?: { Item?: { Id: string; Name?: string; Description?: string; Type?: string; UnitPrice?: number; Active?: boolean; IncomeAccountRef?: { name?: string } }[] } }>("GET", `query?query=${q}`);
      const page = res.QueryResponse?.Item ?? [];
      out.push(...page.map((i) => ({
        id: i.Id, name: i.Name ?? "", description: i.Description ?? null, type: i.Type ?? null,
        unitPrice: i.UnitPrice ?? null, active: i.Active !== false, incomeAccountName: i.IncomeAccountRef?.name ?? null,
      })));
      if (page.length < 1000) break;
      start += 1000;
    }
    return out;
  }

  /** Find a customer by display name, or create one. Returns the QBO Customer
   *  id. contact carries whatever real billing info we have (email, phone,
   *  address) -- on either path, an existing customer gets a sparse update
   *  with it too, so a customer created bare before a billing contact was
   *  confirmed (see resolveAccountingSetup in import-qbo-invoices.ts) gets
   *  self-healed on the next run once one shows up, without a separate
   *  one-off backfill. Deliberately does NOT touch Notes or the
   *  Given/Family name fields -- there's no clean, non-destructive place to
   *  put a contact's name on a company-type Customer record, and sparse-
   *  updating Notes risks clobbering something a human typed directly into
   *  QBO. */
  async findOrCreateCustomer(name: string, contact?: {
    email?: string | null; phone?: string | null;
    address?: { line1?: string | null; line2?: string | null; city?: string | null; state?: string | null; postalCode?: string | null; country?: string | null } | null;
  }): Promise<string> {
    const safe = name.replace(/'/g, "''");
    const q = encodeURIComponent(`SELECT * FROM Customer WHERE DisplayName = '${safe}'`);
    const found = await this.call<{ QueryResponse?: { Customer?: { Id: string; SyncToken: string }[] } }>("GET", `query?query=${q}`);
    const hit = found.QueryResponse?.Customer?.[0];
    const patch = this.buildContactPatch(contact);
    if (hit) {
      if (Object.keys(patch).length > 0) {
        await this.call("POST", "customer", { sparse: true, Id: hit.Id, SyncToken: hit.SyncToken, ...patch });
      }
      return hit.Id;
    }
    const created = await this.call<{ Customer: { Id: string } }>("POST", "customer", { DisplayName: name, ...patch });
    return created.Customer.Id;
  }

  private buildContactPatch(contact?: {
    email?: string | null; phone?: string | null;
    address?: { line1?: string | null; line2?: string | null; city?: string | null; state?: string | null; postalCode?: string | null; country?: string | null } | null;
  }): Record<string, unknown> {
    const patch: Record<string, unknown> = {};
    if (!contact) return patch;
    if (contact.email) patch.PrimaryEmailAddr = { Address: contact.email };
    if (contact.phone) patch.PrimaryPhone = { FreeFormNumber: contact.phone };
    const a = contact.address;
    if (a && (a.line1 || a.city)) {
      patch.BillAddr = {
        ...(a.line1 ? { Line1: a.line1 } : {}),
        ...(a.line2 ? { Line2: a.line2 } : {}),
        ...(a.city ? { City: a.city } : {}),
        ...(a.state ? { CountrySubDivisionCode: a.state } : {}),
        ...(a.postalCode ? { PostalCode: a.postalCode } : {}),
        ...(a.country ? { Country: a.country } : {}),
      };
    }
    return patch;
  }

  /** Sparse-update a Customer's own email address (distinct from an
   *  invoice's per-send BillEmail) -- for the case where a customer was
   *  created before a real billing contact was known (see resolveAccountingSetup
   *  in import-qbo-invoices.ts) and the real one arrives later. QBO's update
   *  API requires the entity's current SyncToken for optimistic concurrency,
   *  so this reads it fresh immediately before writing. */
  async updateCustomerEmail(customerId: string, email: string): Promise<void> {
    const cur = await this.call<{ Customer: { SyncToken: string } }>("GET", `customer/${customerId}`);
    await this.call("POST", "customer", {
      sparse: true,
      Id: customerId,
      SyncToken: cur.Customer.SyncToken,
      PrimaryEmailAddr: { Address: email },
    });
  }

  private buildLines(lines: QboLine[]) {
    const defaultItem = process.env.QBO_DEFAULT_ITEM_ID?.trim() || "1";
    return lines.filter((l) => l.amount > 0).map((l) => {
      const label = l.description ? `${l.name}: ${l.description}` : l.name;
      return {
        DetailType: "SalesItemLineDetail",
        Amount: Math.round(l.amount * 100) / 100,
        Description: l.monthly ? `${label} (monthly)` : label,
        SalesItemLineDetail: { ItemRef: { value: l.itemId || defaultItem } },
      };
    });
  }

  /** Create an invoice from line items. Amounts are dollars. Optionally link the
   *  originating estimate, set an email + due date, and turn on QBO's own
   *  hosted "Pay Now" online-payment link (AllowOnlineACHPayment /
   *  AllowOnlineCreditCardPayment — confirmed real Invoice fields; requires
   *  QuickBooks Payments enabled on the company). That hosted page is also
   *  where a client can save a card, so this is the one piece of "autopay"
   *  actually settable via the public Accounting API — see the doc comment
   *  on createRecurringInvoiceTemplate for what isn't. */
  async createInvoice(customerId: string, lines: QboLine[], opts?: { email?: string | null; dueDate?: string | null; allowOnlinePayment?: boolean }): Promise<string> {
    const body: Record<string, unknown> = {
      CustomerRef: { value: customerId },
      Line: this.buildLines(lines),
    };
    if (opts?.email) { body.BillEmail = { Address: opts.email }; body.EmailStatus = "NeedToSend"; }
    if (opts?.dueDate) body.DueDate = opts.dueDate;
    if (opts?.allowOnlinePayment) { body.AllowOnlineACHPayment = true; body.AllowOnlineCreditCardPayment = true; }
    const inv = await this.call<{ Invoice: { Id: string } }>("POST", "invoice", body);
    return inv.Invoice.Id;
  }

  /** (Re)send an existing invoice by email — QBO's own dedicated endpoint,
   *  distinct from creating one. This is also the only lever for "remind the
   *  client about an overdue invoice": QBO has no separate reminder
   *  endpoint, so sending the same invoice again IS the nudge. sendTo
   *  overrides the invoice's own BillEmail for this one send only. */
  async sendInvoice(invoiceId: string, sendTo?: string | null): Promise<void> {
    const q = sendTo ? `?sendTo=${encodeURIComponent(sendTo)}` : "";
    await this.call("POST", `invoice/${invoiceId}/send${q}`);
  }

  /** Create a QBO Recurring Invoice template — the monthly-billing
   *  counterpart to createInvoice, for a signed quote's recurring line
   *  items. Mirrors the shape import-qbo-invoices-sync.ts already reads
   *  back (RecurringTransaction → Invoice.RecurringInfo.ScheduleInfo).
   *  startDate/endDate are YYYY-MM-DD; startDate's day-of-month becomes the
   *  template's billing day. endDate omitted = ongoing/evergreen. opts sets
   *  who invoices go to/CC once the client's accounting setup confirms it —
   *  falls back to whoever signed if there's no confirmed billing contact
   *  yet, and turns on the same hosted online-payment link as createInvoice
   *  on every invoice this template generates.
   *
   *  What this does NOT do: enroll the client in QBO's actual "Autopay"
   *  (the toggle in a recurring invoice's Payment Options that auto-charges
   *  their saved card on every future due date with no click). That's a
   *  documented QBO product feature, but Intuit doesn't expose a field for
   *  it on the public v3 RecurringTransaction/Invoice resource — it's
   *  either UI-only or requires a separate Payments-specific API this
   *  integration doesn't hold credentials for. Confirmed via Intuit's own
   *  support docs; direct API-reference access was blocked from this
   *  environment, so treat "is there a field after all" as still open if
   *  revisited. Until resolved, a client who picks the lower autopay rate
   *  gets AllowOnlineCreditCardPayment (can save a card at pay time) but not
   *  true zero-click future billing — check qbo_sync_error-style follow-up
   *  or ask BS LLC's QBO rep whether Autopay can be turned on per-template
   *  from the QBO UI after this creates it. */
  async createRecurringInvoiceTemplate(
    customerId: string, name: string, lines: QboLine[], startDate: string, endDate?: string | null,
    opts?: { email?: string | null; ccEmails?: string | null; allowOnlinePayment?: boolean },
  ): Promise<string> {
    const dayOfMonth = Number(startDate.slice(8, 10)) || 1;
    const invoice: Record<string, unknown> = {
      CustomerRef: { value: customerId },
      Line: this.buildLines(lines),
      RecurringInfo: {
        Name: name,
        Active: true,
        // Required by QBO's API (confirmed live 2026-09-01: creation fails
        // with "Required param missing... RecurringInfo.RecurType" without
        // it) but undocumented as required in most third-party references.
        // "Automated" = QBO generates and sends each cycle's invoice on its
        // own; "Reminder" would only nudge a human to create it manually,
        // which defeats the point of a recurring retainer template.
        RecurType: "Automated",
        ScheduleInfo: {
          IntervalType: "Monthly",
          NumInterval: 1,
          DayOfMonth: dayOfMonth,
          StartDate: startDate,
          // Generate each cycle's invoice 3 days ahead of its bill date
          // instead of same-day, so there's a review window before it goes
          // out rather than it appearing (and, once "Automatically send
          // emails" is ever turned on, sending) with zero lead time.
          DaysInAdvance: 3,
          ...(endDate ? { EndDate: endDate } : {}),
        },
      },
    };
    if (opts?.email) invoice.BillEmail = { Address: opts.email };
    if (opts?.ccEmails) invoice.BillEmailCc = { Address: opts.ccEmails };
    if (opts?.allowOnlinePayment) { invoice.AllowOnlineACHPayment = true; invoice.AllowOnlineCreditCardPayment = true; }
    // Wrapped as RecurringTransaction.Invoice.Id, NOT flat Invoice.Id --
    // confirmed live 2026-09-01 (the flat shape threw "Cannot read
    // properties of undefined (reading 'Id')" despite QBO returning 200).
    // Matches the read-side shape getRecurringInvoiceTemplates() already
    // expects (RecurringTransaction[].Invoice), which should have been the
    // tell the first time this was written.
    const created = await this.call<{ RecurringTransaction: { Invoice: { Id: string } } }>("POST", "recurringtransaction", { Invoice: invoice });
    return created.RecurringTransaction.Invoice.Id;
  }

  /** Attach a file (e.g. the signed-quote PDF) to an Invoice record via QBO's
   *  multipart Attachable upload — a separate endpoint from the JSON
   *  Accounting API `call()` above, since it needs actual multipart/
   *  form-data, not JSON. Best-effort by design at the call site: a failed
   *  attach shouldn't fail the invoice/billing it's attached to. */
  async attachPdfToInvoice(invoiceId: string, fileName: string, pdfBytes: Buffer): Promise<void> {
    if (!this.accessToken) await this.connect();
    const metadata = {
      // IncludeOnSend: without it, QBO attaches the file to the invoice
      // record but leaves "Attach to email" unchecked, so sendInvoice()
      // wouldn't actually deliver the signed-quote PDF to the client.
      AttachableRef: [{ EntityRef: { type: "Invoice", value: invoiceId }, IncludeOnSend: true }],
      FileName: fileName,
      ContentType: "application/pdf",
    };
    const form = new FormData();
    form.append("file_metadata_01", new Blob([JSON.stringify(metadata)], { type: "application/json" }), "attachment.json");
    form.append("file_content_01", new Blob([new Uint8Array(pdfBytes)], { type: "application/pdf" }), fileName);
    const res = await fetch(`${apiBase()}/v3/company/${this.realmId}/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.accessToken}`, Accept: "application/json" },
      body: form,
    });
    const text = await res.text();
    const tid = res.headers.get("intuit_tid") ?? "";
    console.log(`  qbo POST upload(attach) ${res.status} intuit_tid=${tid || "-"}`);
    if (!res.ok) throw new Error(`QBO upload ${res.status} [intuit_tid=${tid}]: ${text}`);
  }
}

export interface QboLine { name: string; description?: string | null; amount: number; itemId?: string | null; monthly?: boolean }

// Shape of a QBO Reports API response (ProfitAndLoss/BalanceSheet/CashFlow) —
// deliberately loose since the exact nesting varies by report and by which
// rows/columns are present for a given date range. Callers should treat this
// as "search it," never assume a fixed shape.
export interface QboReportRow {
  group?: string;
  type?: string;
  ColData?: { value?: string }[];
  Rows?: { Row?: QboReportRow[] };
  Summary?: { ColData?: { value?: string }[] };
}
export interface QboReport {
  Header?: { StartPeriod?: string; EndPeriod?: string; Time?: string };
  Rows?: { Row?: QboReportRow[] };
}

/** Recursively search a QBO report for a summary row matching any of the
 *  given group names (QBO's own row-grouping key, e.g. "NetIncome",
 *  "TotalIncome", "GrossProfit" on a P&L; "TotalAssets", "TotalLiabilities",
 *  "TotalEquity" on a Balance Sheet) — case-insensitive since Intuit isn't
 *  perfectly consistent about it. Returns the last (total) column parsed as
 *  a number, or null if that row never shows up for this report/date range. */
export function findReportTotal(report: QboReport, groupNames: string[]): number | null {
  const wanted = new Set(groupNames.map((g) => g.toLowerCase()));
  let found: number | null = null;
  const parseAmount = (cols?: { value?: string }[]): number | null => {
    const raw = cols?.at(-1)?.value;
    if (raw == null || raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const walk = (rows?: QboReportRow[]) => {
    if (found != null || !rows) return;
    for (const row of rows) {
      if (found != null) return;
      if (row.group && wanted.has(row.group.toLowerCase())) {
        const n = parseAmount(row.Summary?.ColData ?? row.ColData);
        if (n != null) { found = n; return; }
      }
      walk(row.Rows?.Row);
    }
  };
  walk(report.Rows?.Row);
  return found;
}

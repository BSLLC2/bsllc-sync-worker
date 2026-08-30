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

  /** Find a customer by display name, or create one. Returns the QBO Customer id. */
  async findOrCreateCustomer(name: string, email?: string | null): Promise<string> {
    const safe = name.replace(/'/g, "''");
    const q = encodeURIComponent(`SELECT * FROM Customer WHERE DisplayName = '${safe}'`);
    const found = await this.call<{ QueryResponse?: { Customer?: { Id: string }[] } }>("GET", `query?query=${q}`);
    const hit = found.QueryResponse?.Customer?.[0];
    if (hit) return hit.Id;
    const created = await this.call<{ Customer: { Id: string } }>("POST", "customer", {
      DisplayName: name,
      ...(email ? { PrimaryEmailAddr: { Address: email } } : {}),
    });
    return created.Customer.Id;
  }

  private buildLines(lines: QboLine[]) {
    const defaultItem = process.env.QBO_DEFAULT_ITEM_ID?.trim() || "1";
    return lines.filter((l) => l.amount > 0).map((l) => ({
      DetailType: "SalesItemLineDetail",
      Amount: Math.round(l.amount * 100) / 100,
      Description: l.monthly ? `${l.name} (monthly)` : l.name,
      SalesItemLineDetail: { ItemRef: { value: l.itemId || defaultItem } },
    }));
  }

  /** Create an invoice from line items. Amounts are dollars. Optionally link the
   *  originating estimate and set an email + due date. */
  async createInvoice(customerId: string, lines: QboLine[], opts?: { email?: string | null; dueDate?: string | null }): Promise<string> {
    const body: Record<string, unknown> = {
      CustomerRef: { value: customerId },
      Line: this.buildLines(lines),
    };
    if (opts?.email) { body.BillEmail = { Address: opts.email }; body.EmailStatus = "NeedToSend"; }
    if (opts?.dueDate) body.DueDate = opts.dueDate;
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
   *  yet. */
  async createRecurringInvoiceTemplate(
    customerId: string, name: string, lines: QboLine[], startDate: string, endDate?: string | null,
    opts?: { email?: string | null; ccEmails?: string | null },
  ): Promise<string> {
    const dayOfMonth = Number(startDate.slice(8, 10)) || 1;
    const invoice: Record<string, unknown> = {
      CustomerRef: { value: customerId },
      Line: this.buildLines(lines),
      RecurringInfo: {
        Name: name,
        Active: true,
        ScheduleInfo: {
          IntervalType: "Monthly",
          NumInterval: 1,
          DayOfMonth: dayOfMonth,
          StartDate: startDate,
          ...(endDate ? { EndDate: endDate } : {}),
        },
      },
    };
    if (opts?.email) invoice.BillEmail = { Address: opts.email };
    if (opts?.ccEmails) invoice.BillEmailCc = { Address: opts.ccEmails };
    const created = await this.call<{ Invoice: { Id: string } }>("POST", "recurringtransaction", { Invoice: invoice });
    return created.Invoice.Id;
  }

  /** Attach a file (e.g. the signed-quote PDF) to an Invoice record via QBO's
   *  multipart Attachable upload — a separate endpoint from the JSON
   *  Accounting API `call()` above, since it needs actual multipart/
   *  form-data, not JSON. Best-effort by design at the call site: a failed
   *  attach shouldn't fail the invoice/billing it's attached to. */
  async attachPdfToInvoice(invoiceId: string, fileName: string, pdfBytes: Buffer): Promise<void> {
    if (!this.accessToken) await this.connect();
    const metadata = {
      AttachableRef: [{ EntityRef: { type: "Invoice", value: invoiceId } }],
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

export interface QboLine { name: string; amount: number; itemId?: string | null; monthly?: boolean }

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

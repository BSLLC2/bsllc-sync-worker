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
    if (!res.ok) throw new Error(`QBO token refresh ${res.status}: ${text}`);
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
    if (!res.ok) throw new Error(`QBO ${method} ${path} ${res.status}: ${text}`);
    return JSON.parse(text) as T;
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

  /** Create an estimate from line items. Amounts are dollars. */
  async createEstimate(customerId: string, lines: QboLine[]): Promise<string> {
    const est = await this.call<{ Estimate: { Id: string } }>("POST", "estimate", {
      CustomerRef: { value: customerId },
      Line: this.buildLines(lines),
    });
    return est.Estimate.Id;
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
}

export interface QboLine { name: string; amount: number; itemId?: string | null; monthly?: boolean }

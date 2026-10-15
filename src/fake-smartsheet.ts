/**
 * A pretend Smartsheet, for testing the tracker import end to end. List sheets,
 * get sheet (whole, or paged the several ways a real server might), list
 * columns, and every way the real one goes wrong on demand: a revoked token, a
 * sheet nobody shared, a forbidden sheet, a minute of 429s or 503s. It counts
 * every request that is not a GET, because the import is read-only and the guard
 * asserts that count is nought.
 *
 * The other half of the SMARTSHEET_FAKE_BASE seam in tracker/smartsheet.ts.
 * Nothing here is a real person: every sheet a test builds is invented.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeColumn { id: number; title: string; type?: string; hidden?: boolean; options?: string[] }
export interface FakeSheet {
  id: number;
  name: string;
  permalink: string;
  accessLevel: string;
  modifiedAt: string;
  columns: FakeColumn[];
  /** One array of cell values per row, in column order. null = no cell. */
  rows: (string | number | boolean | null)[][];
  /** The sheet exists for this token but the call is refused. */
  forbidden?: boolean;
  /** The sheet exists but was never shared with the token's user: it is not listed and is a 404. */
  hidden?: boolean;
}
/** How GET /sheets/{id} answers when no paging is asked for. */
export type PagingMode = "whole" | "paged100" | "paged100_no_total" | "last_key" | "ignores_paging_short_total";

export interface FakeState {
  token: string;
  tokenMode: "ok" | "revoked";
  sheets: FakeSheet[];
  paging: PagingMode;
  /** Answer a URL containing `match` with `status`, `times` times, then behave. */
  fail: { match: string; status: number; times: number }[];
  /** Hide totalRowCount on the sheet response. */
  noTotal: boolean;
  /** Leave rowNumber off rows. */
  noRowNumber: boolean;
}

export class FakeSmartsheet {
  state: FakeState;
  calls: { method: string; url: string }[] = [];
  writes = 0;
  authHeaders: string[] = [];
  private server: http.Server | null = null;
  constructor() { this.state = this.blank(); }
  private blank(): FakeState {
    return { token: "valid-token-invented-123", tokenMode: "ok", sheets: [], paging: "whole", fail: [], noTotal: false, noRowNumber: false };
  }
  async start(): Promise<string> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }
  async stop(): Promise<void> { await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r())); }
  reset(sheets: FakeSheet[]) { this.state = this.blank(); this.state.sheets = sheets; this.calls = []; this.writes = 0; this.authHeaders = []; }

  private send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(body === null ? "" : JSON.stringify(body));
  }
  private err(res: http.ServerResponse, status: number, errorCode: number, message: string) { this.send(res, status, { errorCode, message, refId: "invented" }); }

  private rowsOf(s: FakeSheet, colIds: number[] | null) {
    return s.rows.map((r, i) => ({
      id: 9000 + i, ...(this.state.noRowNumber ? {} : { rowNumber: i + 1 }),
      cells: s.columns.map((c, k) => ({ c, v: r[k] })).filter((x) => x.v !== null && x.v !== undefined && (!colIds || colIds.includes(x.c.id)))
        .map((x) => ({ columnId: x.c.id, value: x.v, displayValue: typeof x.v === "number" ? `$${x.v}` : String(x.v) })),
    }));
  }
  private colsOf(s: FakeSheet, colIds: number[] | null) {
    return s.columns.filter((c) => !colIds || colIds.includes(c.id)).map((c) => ({ id: c.id, index: s.columns.indexOf(c), title: c.title, type: c.type ?? "TEXT_NUMBER", hidden: c.hidden === true, ...(c.options ? { options: c.options } : {}) }));
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const method = req.method ?? "GET";
    const raw = req.url ?? "/";
    this.calls.push({ method, url: raw });
    if (method !== "GET") this.writes++;
    this.authHeaders.push(String(req.headers.authorization ?? ""));
    req.on("data", () => {});
    req.on("end", () => {
      const url = new URL(raw, "http://fake");
      const path = decodeURIComponent(url.pathname);
      for (const f of this.state.fail) {
        if (f.times > 0 && raw.includes(f.match)) {
          f.times--;
          return f.status === 429 ? this.send(res, 429, { errorCode: 4003, message: "Rate limit exceeded.", refId: "invented" }) : this.send(res, f.status, f.status === 503 ? { errorCode: 4001, message: "offline", refId: "invented" } : null);
        }
      }
      if (this.state.tokenMode === "revoked" || req.headers.authorization !== `Bearer ${this.state.token}`) return this.err(res, 401, 1002, "Your Access Token is invalid.");
      if (method !== "GET") return this.err(res, 405, 1, "no writes in this fake");

      if (path === "/sheets") {
        const visible = this.state.sheets.filter((s) => !s.hidden);
        const includeAll = url.searchParams.get("includeAll") === "true";
        const pageSize = includeAll ? visible.length || 1 : Number(url.searchParams.get("pageSize") ?? 100);
        const page = includeAll ? 1 : Number(url.searchParams.get("page") ?? 1);
        const slice = visible.slice((page - 1) * pageSize, page * pageSize);
        return this.send(res, 200, {
          pageNumber: page, pageSize, totalPages: Math.max(1, Math.ceil(visible.length / pageSize)), totalCount: visible.length,
          data: slice.map((s) => ({ id: s.id, name: s.name, accessLevel: s.accessLevel, permalink: s.permalink, createdAt: "2024-01-01T00:00:00Z", modifiedAt: s.modifiedAt })),
        });
      }
      const m = path.match(/^\/sheets\/(\d+)(\/columns)?$/);
      if (!m) return this.err(res, 404, 1006, "Not Found");
      const sheet = this.state.sheets.find((s) => String(s.id) === m[1]);
      if (!sheet || sheet.hidden) return this.err(res, 404, 1006, "Not Found");
      if (sheet.forbidden) return this.err(res, 403, 1004, "You are not authorized to perform this action.");
      const colIds = url.searchParams.get("columnIds")?.split(",").map(Number) ?? null;
      if (m[2]) return this.send(res, 200, { pageNumber: 1, pageSize: sheet.columns.length, totalPages: 1, totalCount: sheet.columns.length, data: this.colsOf(sheet, colIds) });

      const all = this.rowsOf(sheet, colIds);
      const page = url.searchParams.get("page");
      const pageSize = url.searchParams.get("pageSize");
      const lastKey = url.searchParams.get("lastKey");
      const head = { id: sheet.id, name: sheet.name, accessLevel: sheet.accessLevel, modifiedAt: sheet.modifiedAt, permalink: sheet.permalink, columns: this.colsOf(sheet, colIds) };
      const total = this.state.noTotal ? {} : { totalRowCount: sheet.rows.length };
      const mode = this.state.paging;
      if (pageSize === "1" && !page && !lastKey && mode !== "ignores_paging_short_total") return this.send(res, 200, { ...head, ...total, rows: all.slice(0, 1) });
      if (mode === "whole") return this.send(res, 200, { ...head, ...total, rows: all });
      if (mode === "ignores_paging_short_total") return this.send(res, 200, { ...head, totalRowCount: sheet.rows.length + 5, rows: all });
      if (mode === "last_key") {
        const start = lastKey ? Number(lastKey) : 0;
        const end = start + 100;
        return this.send(res, 200, { ...head, ...total, rows: all.slice(start, end), ...(end < all.length ? { lastKey: String(end) } : {}) });
      }
      // paged100 and paged100_no_total: 100 rows a page unless a page size is asked for.
      const size = pageSize ? Number(pageSize) : 100;
      const p = page ? Number(page) : 1;
      return this.send(res, 200, { ...head, ...(mode === "paged100" ? total : {}), rows: all.slice((p - 1) * size, p * size) });
    });
  }
}

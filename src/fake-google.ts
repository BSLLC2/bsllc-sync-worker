/**
 * A pretend Google, for testing the OCH sheet jobs end to end. Sheets metadata,
 * Sheets values, Drive file metadata and a token endpoint, over a local port,
 * with every way the real one goes wrong available on demand: a revoked key, a
 * sheet that is gone or no longer shared, a trashed file, a read-only share, a
 * minute of 503s, a renamed or duplicated tab.
 *
 * It is the other half of the GOOGLE_FAKE_BASE seam in och-google.ts. It counts
 * every write it receives, because the daily check and the import are read-only
 * and the guard asserts that count is nought.
 *
 * Nothing here is a real person: every board a test builds is invented.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeTab { name: string; rows: string[][] }
export interface FakeState {
  sheetId: string;
  tokenMode: "ok" | "revoked" | "down";
  /** What the sheet says to us: fine, "no access" (403) or "no such sheet" (404). */
  access: "ok" | "revoked" | "gone";
  tabs: FakeTab[];
  drive: { mode: "ok" | "off"; trashed: boolean; canEdit: boolean; modifiedTime: string };
  /** Answer a URL containing `match` with `status`, `times` times, then behave. */
  fail: { match: string; status: number; times: number }[];
}

export const blankState = (sheetId: string): FakeState => ({
  sheetId, tokenMode: "ok", access: "ok", tabs: [],
  drive: { mode: "ok", trashed: false, canEdit: true, modifiedTime: new Date().toISOString() },
  fail: [],
});

export class FakeGoogle {
  state: FakeState;
  calls: { method: string; url: string }[] = [];
  writes = 0;
  private server: http.Server | null = null;
  constructor(sheetId: string) { this.state = blankState(sheetId); }

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }
  async stop(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
  /** Back to a healthy Google with the given tabs, and a clean call log. */
  reset(tabs: FakeTab[]) {
    this.state = blankState(this.state.sheetId);
    this.state.tabs = tabs;
    this.calls = [];
    this.writes = 0;
  }

  private send(res: http.ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body === null ? "" : JSON.stringify(body));
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const method = req.method ?? "GET";
    const raw = req.url ?? "/";
    this.calls.push({ method, url: raw });
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = new URL(raw, "http://fake");
      const path = decodeURIComponent(url.pathname);
      // Injected failures come first: they model Google itself having a bad minute.
      for (const f of this.state.fail) {
        if (f.times > 0 && raw.includes(f.match)) { f.times--; return this.send(res, f.status, f.status === 503 ? { error: { message: "The service is currently unavailable." } } : null); }
      }
      if (method === "POST" && path === "/token") {
        if (this.state.tokenMode === "revoked") return this.send(res, 400, { error: "invalid_grant", error_description: "Invalid JWT Signature." });
        if (this.state.tokenMode === "down") return this.send(res, 503, null);
        return this.send(res, 200, { access_token: "fake-token", expires_in: 3600 });
      }
      const sheetPrefix = `/v4/spreadsheets/${this.state.sheetId}`;
      const drivePrefix = `/drive/v3/files/${this.state.sheetId}`;
      const asksForThisSheet = path.startsWith(sheetPrefix) || path.startsWith(drivePrefix);
      if (!asksForThisSheet) return this.send(res, 404, { error: { code: 404, message: "Requested entity was not found." } });
      if (this.state.access === "gone") return this.send(res, 404, { error: { code: 404, message: "Requested entity was not found." } });
      if (this.state.access === "revoked") return this.send(res, 403, { error: { code: 403, message: "The caller does not have permission" } });

      if (path.startsWith(drivePrefix)) {
        if (this.state.drive.mode === "off") return this.send(res, 403, { error: { message: "Google Drive API has not been used in project before or it is disabled." } });
        const d = this.state.drive;
        return this.send(res, 200, { trashed: d.trashed, modifiedTime: d.modifiedTime, capabilities: { canEdit: d.canEdit } });
      }
      if (method !== "GET") {
        this.writes++;
        if (!this.state.drive.canEdit) return this.send(res, 403, { error: { code: 403, message: "The caller does not have permission" } });
        return this.send(res, 200, {});
      }
      if (path === sheetPrefix) return this.send(res, 200, { sheets: this.state.tabs.map((t) => ({ properties: { title: t.name } })) });
      const m = path.match(new RegExp(`^${sheetPrefix}/values/(.+)$`));
      if (m) {
        const range = m[1]!;
        const name = range.split("!")[0]!.replace(/^'/, "").replace(/'$/, "").replace(/''/g, "'");
        const tab = this.state.tabs.find((t) => t.name === name);
        if (!tab) return this.send(res, 400, { error: { code: 400, message: `Unable to parse range: ${range}` } });
        return this.send(res, 200, { range, majorDimension: "ROWS", values: tab.rows });
      }
      return this.send(res, 404, { error: { message: "unhandled in the fake" } });
    });
  }
}

/**
 * The one door from the tracker jobs to Smartsheet. READ ONLY: every call here
 * is a GET. A bearer token from the worker secret SMARTSHEET_API_TOKEN (read in
 * `smartsheetToken()` and nowhere else), the base address, a fetch that retries
 * what is worth retrying, and the turn of a sheet's JSON into a Table.
 *
 * WHAT THE API IS TAKEN TO DO, and how sure we are (see docs/FRANKLIN-TRACKER.md,
 * "Not verified"). Checked against Smartsheet's published reference on
 * 2026-10-15: Bearer auth; GET /sheets/{id} returns `columns` (id, index, title,
 * type, hidden, locked ...), `rows` with `cells` (columnId, value, displayValue),
 * `modifiedAt` and `accessLevel` (ADMIN, COMMENTER, EDITOR, EDITOR_SHARE, OWNER,
 * VIEWER); `columnIds` narrows a read; a rate limit of 300 requests a minute a
 * token answered with HTTP 429 and errorCode 4003, retried after at least a
 * minute. NOT confirmed from the reference: whether GET /sheets/{id} returns every
 * row when no paging is asked for (it may page at 100), that `rowNumber` is on
 * every row, the largest `pageSize`, and whether offset paging (`page`,
 * `pageSize`) is being replaced by a `lastKey` token for this call. So the reader
 * does not trust any of them: it asks without paging first, compares what came
 * back with `totalRowCount`, keeps paging by `page` (or follows `lastKey`) when
 * rows are missing, de-duplicates by row id, and STOPS with rows_incomplete if
 * the count still does not agree.
 *
 * THE TEST SEAM. When SMARTSHEET_FAKE_BASE is set (and only then) every call goes
 * to that address. No workflow sets it; verify-tracker fails if one does.
 * SMARTSHEET_API_BASE is the legitimate override for the EU and government hosts.
 */
import type { Table } from "./table.js";

export const fakeBase = (): string | null => process.env.SMARTSHEET_FAKE_BASE?.trim() || null;
const HOSTS = /^https:\/\/api\.smartsheet(?:gov)?\.(?:com|eu|au)\/2\.0$/;
export function smartsheetBase(env: Record<string, string | undefined> = process.env): string {
  const fake = env.SMARTSHEET_FAKE_BASE?.trim();
  if (fake) return fake.replace(/\/+$/, "");
  const o = env.SMARTSHEET_API_BASE?.trim().replace(/\/+$/, "");
  return o && HOSTS.test(o) ? o : "https://api.smartsheet.com/2.0";
}
/** The only place the token is read. */
export const smartsheetToken = (env: Record<string, string | undefined> = process.env): string | null => env.SMARTSHEET_API_TOKEN?.trim() || null;

const retryMs = (n: number, retryAfter: string | null): number => {
  const t = process.env.TRACKER_RETRY_MS;
  if (t !== undefined && Number(t) >= 0) return Number(t) * (n + 1);
  const ra = Number(retryAfter);
  return Number.isFinite(ra) && ra > 0 ? ra * 1000 : 60_000 * (n + 1);
};

export type Fetched = { status: number | null; body: any; errorCode: number | null; tries: number };

/** GET with retries on a 429, a 5xx or a dropped connection. A 4xx is an answer. Never logs a body. */
export async function ssGet(path: string, token: string, tries = 4): Promise<Fetched> {
  const url = `${smartsheetBase()}${path}`;
  let last: Fetched = { status: null, body: null, errorCode: null, tries: 0 };
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const res = await fetch(url, { method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
      let body: any = null;
      try { body = await res.json(); } catch { /* an empty body is fine */ }
      last = { status: res.status, body, errorCode: typeof body?.errorCode === "number" ? body.errorCode : null, tries: attempt + 1 };
      if ((res.status === 429 || res.status >= 500) && attempt < tries - 1) {
        console.warn(`Smartsheet answered ${res.status}${last.errorCode ? ` (errorCode ${last.errorCode})` : ""}; retrying in ${Math.round(retryMs(attempt, res.headers.get("retry-after")) / 1000)}s`);
        await new Promise((r) => setTimeout(r, retryMs(attempt, res.headers.get("retry-after"))));
        continue;
      }
      return last;
    } catch {
      last = { status: null, body: null, errorCode: null, tries: attempt + 1 };
      if (attempt >= tries - 1) return last;
      console.warn("Smartsheet did not answer; retrying");
      await new Promise((r) => setTimeout(r, retryMs(attempt, null)));
    }
  }
  return last;
}

// ── Turning a sheet into a Table ─────────────────────────────────────────────

/** A cell as text. A number, a checked box and a date all read; an object (a contact list) reads as blank. */
export function cellText(c: { value?: unknown; displayValue?: unknown } | undefined): string {
  if (!c) return "";
  const v = c.value;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return v;
  const d = c.displayValue;
  return typeof d === "string" ? d : typeof d === "number" ? String(d) : "";
}

export interface SheetShape {
  name: string | null;
  accessLevel: string | null;
  modifiedAt: string | null;
  totalRowCount: number | null;
  columns: { id: number; index: number; title: string; type: string | null; hidden: boolean; options: string[] | null }[];
}

export function shapeOf(body: any): SheetShape | null {
  if (!body || !Array.isArray(body.columns)) return null;
  const columns = body.columns
    .filter((c: any) => c && typeof c.id === "number" && typeof c.title === "string")
    .map((c: any, i: number) => ({
      id: c.id as number, index: typeof c.index === "number" ? c.index : i, title: c.title as string,
      type: typeof c.type === "string" ? c.type : null, hidden: c.hidden === true,
      options: Array.isArray(c.options) ? c.options.filter((o: unknown) => typeof o === "string") : null,
    }))
    .sort((a: any, b: any) => a.index - b.index);
  const m = typeof body.modifiedAt === "string" && !isNaN(Date.parse(body.modifiedAt)) ? new Date(body.modifiedAt).toISOString() : null;
  return {
    name: typeof body.name === "string" ? body.name : null,
    accessLevel: typeof body.accessLevel === "string" ? body.accessLevel : null,
    modifiedAt: m,
    totalRowCount: typeof body.totalRowCount === "number" && body.totalRowCount >= 0 ? body.totalRowCount : null,
    columns,
  };
}

export function tableFrom(shape: SheetShape, rows: { id?: number; rowNumber?: number; cells?: any[] }[]): Table {
  const idx = new Map(shape.columns.map((c, i) => [c.id, i] as const));
  const out: string[][] = [];
  const nums: number[] = [];
  rows.forEach((r, i) => {
    const line = new Array<string>(shape.columns.length).fill("");
    for (const c of r.cells ?? []) { const k = idx.get(c?.columnId); if (k !== undefined) line[k] = cellText(c); }
    out.push(line);
    nums.push(typeof r.rowNumber === "number" ? r.rowNumber : i + 1);
  });
  return {
    headers: shape.columns.map((c) => c.title), types: shape.columns.map((c) => c.type), hidden: shape.columns.map((c) => c.hidden),
    options: shape.columns.map((c) => c.options), rows: out, rowNumbers: nums, totalRows: shape.totalRowCount,
  };
}

// ── The read ─────────────────────────────────────────────────────────────────

export type SsStop =
  | { kind: "stop"; code: "token_missing" | "token_rejected" | "access_denied" | "sheet_not_found" | "rate_limited" | "source_unavailable" | "sheet_empty" | "sheet_too_long" | "rows_incomplete"; detail?: { got: number; want: number } }
  | null;

/** Maps an HTTP answer to the one cause it means. 200 is null. */
export function stopFor(f: Fetched): SsStop {
  if (f.status === 200) return null;
  if (f.status === 401) return { kind: "stop", code: "token_rejected" };
  if (f.status === 403) return { kind: "stop", code: "access_denied" };
  if (f.status === 404 || f.status === 400) return { kind: "stop", code: "sheet_not_found" };
  if (f.status === 429) return { kind: "stop", code: "rate_limited" };
  return { kind: "stop", code: "source_unavailable" };
}

export type SmartsheetResult =
  | { kind: "stop"; code: Exclude<NonNullable<SsStop>["code"], never>; detail?: { got: number; want: number }; shape: SheetShape | null }
  | { kind: "table"; table: Table; shape: SheetShape; requests: number };

/** Row numbers are 1-based and include the header? No: Smartsheet's row 1 is the first data row. */
export async function readSmartsheet(sheetId: string, o: { rowLimit: number; token: string | null }): Promise<SmartsheetResult> {
  if (!o.token) return { kind: "stop", code: "token_missing", shape: null };
  let requests = 1;
  const first = await ssGet(`/sheets/${encodeURIComponent(sheetId)}`, o.token);
  const s0 = stopFor(first);
  if (s0) return { kind: "stop", code: s0.code, shape: null };
  const shape = shapeOf(first.body);
  if (!shape) return { kind: "stop", code: "source_unavailable", shape: null };
  const seen = new Set<number>();
  const all: { id?: number; rowNumber?: number; cells?: any[] }[] = [];
  const take = (rows: any[]): number => {
    let added = 0;
    for (const r of rows ?? []) {
      const id = typeof r?.id === "number" ? r.id : null;
      if (id !== null) { if (seen.has(id)) continue; seen.add(id); }
      all.push(r); added++;
    }
    return added;
  };
  const rows0: any[] = Array.isArray(first.body.rows) ? first.body.rows : [];
  take(rows0);
  const want = shape.totalRowCount;
  const tooLong = (n: number) => n > o.rowLimit;

  // More to fetch? When the count is known, until it is met. When it is not, only if the first answer is exactly the documented default page of 100.
  const more = () => (want != null ? all.length < want : rows0.length >= 100);
  let lastKey: string | null = typeof first.body.lastKey === "string" ? first.body.lastKey : null;
  let page = 1;
  const pageSize = Math.max(rows0.length, 100);
  while (more() && requests < 400) {
    if (tooLong(all.length)) break;
    let path: string;
    if (lastKey) path = `/sheets/${encodeURIComponent(sheetId)}?lastKey=${encodeURIComponent(lastKey)}`;
    else { page += 1; path = `/sheets/${encodeURIComponent(sheetId)}?page=${page}&pageSize=${pageSize}`; }
    const f = await ssGet(path, o.token);
    requests++;
    const s = stopFor(f);
    if (s) return { kind: "stop", code: s.code, shape };
    const added = take(Array.isArray(f.body?.rows) ? f.body.rows : []);
    lastKey = typeof f.body?.lastKey === "string" ? f.body.lastKey : null;
    // A page that adds nothing new means the server is not paging (it already gave us everything), or has run out.
    if (added === 0 && !lastKey) break;
  }
  if (tooLong(all.length) || (want != null && tooLong(want))) return { kind: "stop", code: "sheet_too_long", detail: { got: Math.max(all.length, want ?? 0), want: o.rowLimit }, shape };
  if (want != null && all.length < want) return { kind: "stop", code: "rows_incomplete", detail: { got: all.length, want }, shape };
  if (all.length === 0) return { kind: "stop", code: "sheet_empty", shape };
  return { kind: "table", table: tableFrom(shape, all), shape, requests };
}

/**
 * The counts-only read for diagnose: the columns (their titles and types are the
 * sheet's design, not its content) and how many rows there are. It asks for one
 * column's cells only, so no row content travels beyond that, and it prints none.
 */
export async function diagnoseSmartsheet(sheetId: string, token: string | null): Promise<{ stop: NonNullable<SsStop> | null; shape: SheetShape | null; requests: number }> {
  if (!token) return { stop: { kind: "stop", code: "token_missing" }, shape: null, requests: 0 };
  const cols = await ssGet(`/sheets/${encodeURIComponent(sheetId)}/columns?includeAll=true`, token);
  let shape = cols.status === 200 && Array.isArray(cols.body?.data) ? shapeOf({ columns: cols.body.data }) : null;
  let requests = 1;
  const probe = shape && shape.columns[0] ? `?columnIds=${shape.columns[0].id}&pageSize=1` : "?pageSize=1";
  const sheet = await ssGet(`/sheets/${encodeURIComponent(sheetId)}${probe}`, token);
  requests++;
  const s = stopFor(sheet);
  if (s) return { stop: s, shape: null, requests };
  const whole = shapeOf(sheet.body);
  if (!shape) shape = whole;
  if (shape && whole) { shape.name = whole.name; shape.accessLevel = whole.accessLevel; shape.modifiedAt = whole.modifiedAt; shape.totalRowCount = whole.totalRowCount ?? (Array.isArray(sheet.body?.rows) && sheet.body.rows.length > 1 ? sheet.body.rows.length : null); }
  return { stop: shape ? null : { kind: "stop", code: "source_unavailable" }, shape, requests };
}

// ── A link to a numeric id ───────────────────────────────────────────────────

/** The last path segment of a permalink, which is what a link's code is matched on. */
export function lastSegment(permalink: unknown): string | null {
  if (typeof permalink !== "string") return null;
  try {
    const parts = new URL(permalink).pathname.split("/").filter(Boolean);
    return parts.length ? parts[parts.length - 1]! : null;
  } catch { return null; }
}

export type PermalinkResult =
  | { kind: "found"; id: string; name: string | null }
  | { kind: "stop"; code: "token_rejected" | "access_denied" | "rate_limited" | "source_unavailable" | "sheet_not_shared" };

/**
 * A Smartsheet LINK ends in a code that is not the sheet's numeric id. The API
 * has no "get a sheet by permalink", so the id is found by listing the sheets the
 * token's user can see (GET /sheets: each has id, name, accessLevel, permalink,
 * modifiedAt) and matching the code on the permalink's last path segment.
 * Nothing is cached anywhere: it is one cheap call per run.
 *
 * `includeAll=true` asks for the whole list; the offset paging (`page`,
 * `pageSize`, `totalPages`) is followed as a fallback when the list comes back
 * short of `totalCount`. Both are from Smartsheet's reference (checked
 * 2026-10-15) and neither has been run against a live account.
 * A sheet nobody shared with the token's user is simply not in the list, which is
 * why "no match" is `sheet_not_shared` and not "not found".
 */
export async function resolvePermalink(token: string, code: string): Promise<PermalinkResult> {
  const seen = new Set<number>();
  let page = 1;
  for (let guard = 0; guard < 60; guard++) {
    const path = page === 1 ? "/sheets?includeAll=true" : `/sheets?page=${page}&pageSize=100`;
    const f = await ssGet(path, token);
    if (f.status === 401) return { kind: "stop", code: "token_rejected" };
    if (f.status === 403) return { kind: "stop", code: "access_denied" };
    if (f.status === 429) return { kind: "stop", code: "rate_limited" };
    if (f.status !== 200) return { kind: "stop", code: "source_unavailable" };
    const data: any[] = Array.isArray(f.body?.data) ? f.body.data : [];
    let added = 0;
    for (const s of data) {
      const id = typeof s?.id === "number" ? s.id : null;
      if (id !== null) { if (seen.has(id)) continue; seen.add(id); added++; }
      if (id !== null && lastSegment(s.permalink) === code) return { kind: "found", id: String(id), name: typeof s.name === "string" ? s.name : null };
    }
    const total = typeof f.body?.totalCount === "number" ? f.body.totalCount : null;
    const pages = typeof f.body?.totalPages === "number" ? f.body.totalPages : null;
    const more = (total != null && seen.size < total) || (pages != null && page < pages);
    if (!more || added === 0) break;
    page += 1;
  }
  return { kind: "stop", code: "sheet_not_shared" };
}

/**
 * The Google Sheets source for the tracker framework. Every Google call goes
 * through och-google.ts (the one door: token, retries on a 429 or 5xx, the
 * GOOGLE_FAKE_BASE test seam). Read-only scopes only; no write call exists here.
 *
 * It turns a tab into the framework's Table. The header row is the one in the
 * first six rows that matches the most role aliases, and the header run ends at
 * the first empty cell, so a summary block beside the table is never mapped.
 */
import { accessToken, driveBase, sheetsBase, sheetsFetch } from "../och-google.js";
import { classifyTokenError } from "../och-sheet-check.js";
import { readKey } from "../dpg-tracker-read.js";
import { normHeader, type TrackerConfig } from "./config.js";
import type { Table } from "./table.js";

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.metadata.readonly";
const down = (s: number | null) => s == null || s === 429 || s >= 500;

async function getJson(url: string, token: string): Promise<{ status: number | null; body: any }> {
  try {
    const res = await sheetsFetch(url, { headers: { Authorization: `Bearer ${token}` } }, 3);
    let body: any = null;
    try { body = await res.json(); } catch { /* empty body */ }
    return { status: res.status, body };
  } catch { return { status: null, body: null }; }
}

export type GoogleStopCode = "key_missing" | "key_unreadable" | "key_rejected" | "source_unavailable" | "sheet_not_found" | "access_removed" | "sheet_in_bin" | "tab_missing" | "sheet_empty" | "sheet_too_long";
export type GoogleResult =
  | { kind: "stop"; code: GoogleStopCode; tabs?: string[]; email?: string | null; detail?: { got: number; want: number } }
  | { kind: "table"; table: Table; tab: string; sheetName: string | null; sheetEditedAt: string | null; driveChecked: boolean };

export function headerRun(row: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const c of row) { const s = String(c ?? "").trim(); if (!s) break; out.push(s); }
  return out;
}
/** The header row among the first rows: the one matching the most aliases of any role. */
export function pickHeaderRow(rows: readonly (readonly unknown[])[], cfg: TrackerConfig): number {
  const want = new Set<string>();
  for (const spec of Object.values(cfg.roles)) for (const a of spec?.aliases ?? []) want.add(normHeader(a));
  let best = { row: 0, score: -1 };
  for (let i = 0; i < Math.min(rows.length, 6); i++) {
    const score = headerRun(rows[i] ?? []).filter((h) => want.has(normHeader(h))).length;
    if (score > best.score) best = { row: i, score };
  }
  return best.row;
}

const A1 = (tab: string, last: string) => `'${tab.replace(/'/g, "''")}'!${last}`;

export async function readGoogle(cfg: TrackerConfig, sheetId: string, o: { keyRaw: string | undefined; headersOnly: boolean }): Promise<GoogleResult> {
  const { state, json } = readKey(o.keyRaw);
  if (state === "missing") return { kind: "stop", code: "key_missing" };
  if (state !== "ok" || !json) return { kind: "stop", code: "key_unreadable" };
  let token: string | null = null;
  try { token = await accessToken(json, SHEETS_SCOPE); } catch (e) {
    return { kind: "stop", code: classifyTokenError(e) === "rejected" ? "key_rejected" : "source_unavailable" };
  }
  if (!token) return { kind: "stop", code: "source_unavailable" };
  const meta = await getJson(`${sheetsBase()}/${sheetId}?fields=properties.title,sheets.properties(sheetId,title)`, token);
  if (down(meta.status)) return { kind: "stop", code: "source_unavailable" };
  if (meta.status === 404) return { kind: "stop", code: "sheet_not_found" };
  if (meta.status === 401 || meta.status === 403) return { kind: "stop", code: "access_removed", email: json.client_email ?? null };
  if (meta.status !== 200) return { kind: "stop", code: "source_unavailable" };

  let sheetEditedAt: string | null = null, driveChecked = false;
  try {
    const dt = await accessToken(json, DRIVE_SCOPE);
    const d = dt ? await getJson(`${driveBase()}/${sheetId}?fields=trashed,modifiedTime&supportsAllDrives=true`, dt) : null;
    if (d && d.status === 200 && d.body) {
      driveChecked = true;
      if (d.body.trashed === true) return { kind: "stop", code: "sheet_in_bin" };
      sheetEditedAt = typeof d.body.modifiedTime === "string" && !isNaN(Date.parse(d.body.modifiedTime)) ? new Date(d.body.modifiedTime).toISOString() : null;
    }
  } catch { /* Drive did not answer */ }

  const tabs: { title: string }[] = (meta.body?.sheets ?? []).map((s: any) => ({ title: s?.properties?.title })).filter((t: any) => typeof t.title === "string" && t.title);
  const want = cfg.tab?.trim().toLowerCase();
  const pick = want ? tabs.find((t) => t.title.trim().toLowerCase() === want) : tabs[0];
  if (!pick) return { kind: "stop", code: "tab_missing", tabs: tabs.map((t) => t.title) };

  const range = o.headersOnly ? A1(pick.title, "A1:AZ6") : A1(pick.title, `A1:AZ${cfg.rowLimit}`);
  const vals = await getJson(`${sheetsBase()}/${sheetId}/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE`, token);
  if (down(vals.status)) return { kind: "stop", code: "source_unavailable" };
  if (vals.status === 400) return { kind: "stop", code: "tab_missing", tabs: tabs.map((t) => t.title) };
  if (vals.status === 401 || vals.status === 403) return { kind: "stop", code: "access_removed", email: json.client_email ?? null };
  if (vals.status === 404) return { kind: "stop", code: "sheet_not_found" };
  if (vals.status !== 200) return { kind: "stop", code: "source_unavailable" };
  const values: string[][] = vals.body?.values ?? [];
  if (!o.headersOnly && values.length >= cfg.rowLimit - 50) return { kind: "stop", code: "sheet_too_long", detail: { got: values.length, want: cfg.rowLimit } };
  if (!values.some((r) => r && r.some((c) => String(c ?? "").trim()))) return { kind: "stop", code: "sheet_empty" };
  const h = pickHeaderRow(values, cfg);
  const headers = headerRun(values[h] ?? []);
  const rows: string[][] = [];
  const rowNumbers: number[] = [];
  if (!o.headersOnly) for (let i = h + 1; i < values.length; i++) { rows.push((values[i] ?? []).slice(0, headers.length).map((c) => String(c ?? ""))); rowNumbers.push(i + 1); }
  return {
    kind: "table", tab: pick.title, sheetName: typeof meta.body?.properties?.title === "string" ? meta.body.properties.title : null, sheetEditedAt, driveChecked,
    table: { headers, types: headers.map(() => null), hidden: headers.map(() => false), options: headers.map(() => null), rows, rowNumbers, totalRows: o.headersOnly ? null : rows.length },
  };
}

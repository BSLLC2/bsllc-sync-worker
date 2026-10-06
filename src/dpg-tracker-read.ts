/**
 * Opens the DPG tracker sheet and hands back either a reading or the one cause
 * that stopped it. Every Google call goes through och-google.ts (the one door:
 * token, retries on a 429 or 5xx, the GOOGLE_FAKE_BASE test seam). No database,
 * no writes, no logging of a cell.
 *
 * Reads only: spreadsheets.readonly, and drive.metadata.readonly for the file's
 * last-edit time and bin flag. Drive is optional on purpose, exactly as it is
 * for the OCH check: the Drive API may not be enabled for the project, and the
 * Sheets read is what the figure depends on. When Drive does not answer the last
 * edit time is null and the dashboard says "edit time not available"; it is
 * never inferred.
 */
import { createPrivateKey } from "node:crypto";
import { accessToken, sheetsBase, driveBase, sheetsFetch, type KeyFile } from "./och-google.js";
import { classifyTokenError } from "./och-sheet-check.js";
import {
  FINDINGS, pickTrackerTab, readTracker, resolveColumns, rowsCapped, trackerRange,
  type Finding, type TabInfo, type TrackerReading,
} from "./dpg-tracker.js";

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.metadata.readonly";
const down = (s: number | null) => s == null || s === 429 || s >= 500;

export type KeyState = "ok" | "missing" | "unparseable" | "incomplete";
export function readKey(raw: string | undefined): { state: KeyState; json: KeyFile | null } {
  if (!raw || !raw.trim()) return { state: "missing", json: null };
  let json: KeyFile;
  try { json = JSON.parse(raw); } catch { return { state: "unparseable", json: null }; }
  if (!json || typeof json !== "object" || !json.client_email || !json.private_key) return { state: "incomplete", json };
  // A key file whose private key is not a key fails inside the token call with
  // an error that reads like a network fault. Say it is the file.
  try { createPrivateKey(json.private_key); } catch { return { state: "unparseable", json }; }
  return { state: "ok", json };
}

async function getJson(url: string, token: string): Promise<{ status: number | null; body: any }> {
  try {
    const res = await sheetsFetch(url, { headers: { Authorization: `Bearer ${token}` } }, 3);
    let body: any = null;
    try { body = await res.json(); } catch { /* an empty body is fine */ }
    return { status: res.status, body };
  } catch {
    return { status: null, body: null };
  }
}

export type ReadResult =
  | { kind: "stop"; finding: Finding; tab: string | null }
  | { kind: "read"; tab: string; reading: TrackerReading; sheetEditedAt: string | null; driveChecked: boolean; rowsFetched: number };

export async function readTrackerSheet(
  keyRaw: string | undefined,
  o: { sheetId: string; gid: number; tabOverride: string | null; today: string; windowStart: string },
): Promise<ReadResult> {
  const { state, json } = readKey(keyRaw);
  if (state === "missing") return { kind: "stop", finding: FINDINGS.key_missing(), tab: null };
  if (state !== "ok" || !json) return { kind: "stop", finding: FINDINGS.key_unreadable(), tab: null };

  let token: string | null = null;
  try { token = await accessToken(json, SHEETS_SCOPE); } catch (e) {
    return { kind: "stop", finding: classifyTokenError(e) === "rejected" ? FINDINGS.key_rejected() : FINDINGS.google_unavailable(), tab: null };
  }
  if (!token) return { kind: "stop", finding: FINDINGS.google_unavailable(), tab: null };

  const meta = await getJson(`${sheetsBase()}/${o.sheetId}?fields=sheets.properties(sheetId,title)`, token);
  if (down(meta.status)) return { kind: "stop", finding: FINDINGS.google_unavailable(), tab: null };
  if (meta.status === 404) return { kind: "stop", finding: FINDINGS.sheet_not_found(), tab: null };
  if (meta.status === 401 || meta.status === 403) return { kind: "stop", finding: FINDINGS.access_removed(json.client_email ?? null), tab: null };
  if (meta.status !== 200) return { kind: "stop", finding: FINDINGS.google_unavailable(), tab: null };

  // Drive: bin flag and last edit. Optional.
  let sheetEditedAt: string | null = null;
  let driveChecked = false;
  try {
    const dt = await accessToken(json, DRIVE_SCOPE);
    const d = dt ? await getJson(`${driveBase()}/${o.sheetId}?fields=trashed,modifiedTime&supportsAllDrives=true`, dt) : null;
    if (d && d.status === 200 && d.body) {
      driveChecked = true;
      if (d.body.trashed === true) return { kind: "stop", finding: FINDINGS.sheet_in_bin(), tab: null };
      sheetEditedAt = typeof d.body.modifiedTime === "string" && !isNaN(Date.parse(d.body.modifiedTime)) ? new Date(d.body.modifiedTime).toISOString() : null;
    }
  } catch { /* Drive did not answer: the edit time stays null */ }

  const tabs: TabInfo[] = (meta.body?.sheets ?? [])
    .map((s: any) => ({ gid: typeof s?.properties?.sheetId === "number" ? s.properties.sheetId : null, title: s?.properties?.title }))
    .filter((t: TabInfo) => typeof t.title === "string" && t.title);
  const pick = pickTrackerTab(tabs, o.gid, o.tabOverride);
  if (!pick.tab) return { kind: "stop", finding: FINDINGS.tab_missing(tabs.map((t) => t.title), pick.how === "override_missing" ? "override_missing" : "missing"), tab: null };

  const vals = await getJson(`${sheetsBase()}/${o.sheetId}/values/${encodeURIComponent(trackerRange(pick.tab))}?valueRenderOption=FORMATTED_VALUE`, token);
  if (down(vals.status)) return { kind: "stop", finding: FINDINGS.google_unavailable(), tab: pick.tab };
  if (vals.status === 400) return { kind: "stop", finding: FINDINGS.tab_missing(tabs.map((t) => t.title), "missing"), tab: null };
  if (vals.status === 401 || vals.status === 403) return { kind: "stop", finding: FINDINGS.access_removed(json.client_email ?? null), tab: pick.tab };
  if (vals.status === 404) return { kind: "stop", finding: FINDINGS.sheet_not_found(), tab: pick.tab };
  if (vals.status !== 200) return { kind: "stop", finding: FINDINGS.google_unavailable(), tab: pick.tab };

  const rows: string[][] = vals.body?.values ?? [];
  if (rowsCapped(rows.length)) return { kind: "stop", finding: FINDINGS.sheet_too_long(rows.length), tab: pick.tab };
  const cols = resolveColumns(rows);
  if (!cols.ok) {
    const f = cols.reason === "empty" ? FINDINGS.sheet_empty() : cols.reason === "duplicate" ? FINDINGS.headers_duplicate(cols.duplicate) : FINDINGS.headers_missing(cols.missing);
    return { kind: "stop", finding: f, tab: pick.tab };
  }
  const reading = readTracker(rows, cols.cols, cols.headerRow, { today: o.today, windowStart: o.windowStart });
  return { kind: "read", tab: pick.tab, reading, sheetEditedAt, driveChecked, rowsFetched: rows.length };
}

import { findHeaderRow, resolveAdmissionColumns } from "./och-sheet-columns.js";
import { parseSheetDate, ymd } from "./lead-keys.js";
import { pickAdmissionTab, boardRange, rowsCapped } from "./och-sheet-target.js";
import { classifyTokenError, type CheckFacts } from "./och-sheet-check.js";

/**
 * Gathers the facts och-sheet-check.ts decides on, through two injected doors:
 * one that mints a token for a scope (and THROWS when Google refuses the key),
 * one that GETs a URL and answers with a status and a body. The real job wires
 * both to Google; the guard wires both to a fake, which is the only way to test
 * the glue (which property holds the tab name, what a 404 on the values call
 * means) without a credential. No side effects at import.
 */
export interface Doors {
  token(scope: string): Promise<string | null>;
  /** `status` is null when the connection failed after retries. */
  get(url: string, token: string): Promise<{ status: number | null; body: any }>;
}

export const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
export const DRIVE = "https://www.googleapis.com/drive/v3/files";
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.metadata.readonly";
const down = (s: number | null) => s == null || s === 429 || s >= 500;

export async function gatherFacts(
  doors: Doors,
  o: { sheetId: string; preferredTab: string | null; today: string; serviceEmail: string | null },
): Promise<{ facts: CheckFacts; skipped: string[]; tab: string | null }> {
  const facts: CheckFacts = {
    today: o.today,
    key: { state: "ok", serviceEmail: o.serviceEmail },
    sheet: null,
    drive: { checked: false, trashed: null, canEdit: null, modifiedYmd: null },
    tabs: [], pick: null, columns: null, rowsRead: null, rowsCapped: false, newestAdmissionYmd: null,
  };
  const skipped: string[] = [];
  let tab: string | null = null;

  let sheetsToken: string | null = null;
  try {
    sheetsToken = await doors.token(SHEETS_SCOPE);
    if (!sheetsToken) facts.key.state = "unavailable";
  } catch (e) {
    facts.key.state = classifyTokenError(e);
  }
  if (!sheetsToken) return { facts, skipped, tab };

  const meta = await doors.get(`${SHEETS}/${o.sheetId}?fields=sheets.properties.title`, sheetsToken);
  facts.sheet = { status: meta.status, unavailable: down(meta.status) };
  if (facts.sheet.unavailable || meta.status !== 200) return { facts, skipped, tab };

  // Drive's view of the file: bin, our access level, last edit. Optional on
  // purpose: the Drive API may not be enabled for this project, and the Sheets
  // facts are what the import depends on.
  const skipMsg = "the bin, edit-access and last-edit checks (Google Drive did not answer)";
  try {
    const dt = await doors.token(DRIVE_SCOPE);
    const d = dt ? await doors.get(`${DRIVE}/${o.sheetId}?fields=trashed,modifiedTime,capabilities/canEdit&supportsAllDrives=true`, dt) : null;
    if (d && d.status === 200 && d.body) {
      facts.drive = {
        checked: true,
        trashed: typeof d.body.trashed === "boolean" ? d.body.trashed : null,
        canEdit: typeof d.body.capabilities?.canEdit === "boolean" ? d.body.capabilities.canEdit : null,
        modifiedYmd: typeof d.body.modifiedTime === "string" ? d.body.modifiedTime.slice(0, 10) : null,
      };
    } else skipped.push(skipMsg);
  } catch { skipped.push(skipMsg); }

  const tabs: string[] = (meta.body?.sheets ?? []).map((s: any) => s?.properties?.title).filter(Boolean);
  facts.tabs = tabs;
  const pick = pickAdmissionTab(tabs, o.preferredTab);
  facts.pick = pick;
  tab = pick.tab;
  if (!tab) return { facts, skipped, tab };

  const vals = await doors.get(`${SHEETS}/${o.sheetId}/values/${encodeURIComponent(boardRange(tab))}?valueRenderOption=FORMATTED_VALUE`, sheetsToken);
  if (vals.status !== 200) {
    // The tab read failing is a statement about access or Google, not about the tab.
    facts.sheet = { status: vals.status, unavailable: down(vals.status) };
    return { facts, skipped, tab };
  }
  const rows: string[][] = vals.body?.values ?? [];
  facts.rowsRead = rows.length;
  facts.rowsCapped = rowsCapped(rows.length);
  if (rows.length > 1) {
    const hIdx = findHeaderRow(rows);
    try {
      const cols = resolveAdmissionColumns(rows, { tab, headerRowIndex: hIdx }, { require: ["name", "date", "contact", "referent"] });
      facts.columns = { ok: true, detail: null };
      let newest: string | null = null;
      for (let r = hIdx + 1; r < rows.length; r++) {
        for (const dc of cols.dateCols) {
          const d = parseSheetDate(rows[r]?.[dc]);
          if (!d) continue;
          const y = ymd(d);
          if (y <= o.today && (!newest || y > newest)) newest = y;
        }
      }
      facts.newestAdmissionYmd = newest;
    } catch (e) {
      facts.columns = { ok: false, detail: (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 200) };
    }
  }
  return { facts, skipped, tab };
}

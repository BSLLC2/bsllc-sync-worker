/**
 * Opens a client's tracker sheet, whichever kind it is, and hands back a Table or
 * the one finding that stopped it. READ ONLY, and it never prints a cell.
 */
import { parseSheetRef, type TrackerConfig, type Env } from "./config.js";
import { FINDINGS, type Finding } from "./causes.js";
import { diagnoseSmartsheet, readSmartsheet, resolvePermalink, smartsheetToken, type SheetShape } from "./smartsheet.js";
import { readGoogle } from "./google-source.js";
import type { Table } from "./table.js";

export type SourceRead =
  | { kind: "stop"; finding: Finding }
  | {
      kind: "table"; table: Table; tab: string | null; sheetName: string | null; sheetEditedAt: string | null; accessLevel: string | null;
      resolvedFromLink: boolean; requests: number; shape: SheetShape | null;
    };

const stop = (finding: Finding): SourceRead => ({ kind: "stop", finding });

export async function openSource(cfg: TrackerConfig, env: Env, o: { headersOnly: boolean }): Promise<SourceRead> {
  const ref = parseSheetRef(cfg.sheetId, cfg.source);
  if (ref.kind === "none") return stop(FINDINGS.not_configured(cfg.key));
  if (ref.kind === "unusable") return stop(FINDINGS.sheet_id_unusable());

  if (cfg.source === "google_sheet") {
    if (ref.kind !== "id") return stop(FINDINGS.sheet_id_unusable());
    const g = await readGoogle(cfg, ref.id, { keyRaw: env.GOOGLE_SERVICE_ACCOUNT_JSON, headersOnly: o.headersOnly });
    if (g.kind === "table") return { kind: "table", table: g.table, tab: g.tab, sheetName: g.sheetName, sheetEditedAt: g.sheetEditedAt, accessLevel: null, resolvedFromLink: false, requests: 0, shape: null };
    switch (g.code) {
      case "key_missing": return stop(FINDINGS.key_missing());
      case "key_unreadable": return stop(FINDINGS.key_unreadable());
      case "key_rejected": return stop(FINDINGS.key_rejected());
      case "access_removed": return stop(FINDINGS.access_removed(g.email ?? null));
      case "sheet_in_bin": return stop(FINDINGS.sheet_in_bin());
      case "tab_missing": return stop(FINDINGS.tab_missing(g.tabs ?? []));
      case "sheet_not_found": return stop(FINDINGS.sheet_not_found());
      case "sheet_empty": return stop(FINDINGS.sheet_empty());
      case "sheet_too_long": return stop(FINDINGS.sheet_too_long(g.detail?.got ?? 0, cfg.rowLimit));
      default: return stop(FINDINGS.source_unavailable());
    }
  }

  // Smartsheet
  const token = smartsheetToken(env);
  if (!token) return stop(FINDINGS.token_missing());
  let id: string;
  let resolvedFromLink = false;
  if (ref.kind === "permalink") {
    const r = await resolvePermalink(token, ref.token);
    if (r.kind === "stop") return stop(r.code === "token_rejected" ? FINDINGS.token_rejected() : r.code === "access_denied" ? FINDINGS.access_denied(cfg.keptBy) : r.code === "rate_limited" ? FINDINGS.rate_limited() : r.code === "sheet_not_shared" ? FINDINGS.sheet_not_shared() : FINDINGS.source_unavailable());
    id = r.id; resolvedFromLink = true;
  } else id = ref.id;

  const fromStop = (code: string, detail?: { got: number; want: number }): Finding => {
    switch (code) {
      case "token_missing": return FINDINGS.token_missing();
      case "token_rejected": return FINDINGS.token_rejected();
      case "access_denied": return FINDINGS.access_denied(cfg.keptBy);
      case "sheet_not_found": return FINDINGS.sheet_not_found();
      case "rate_limited": return FINDINGS.rate_limited();
      case "sheet_empty": return FINDINGS.sheet_empty();
      case "sheet_too_long": return FINDINGS.sheet_too_long(detail?.got ?? 0, cfg.rowLimit);
      case "rows_incomplete": return FINDINGS.rows_incomplete(detail?.got ?? 0, detail?.want ?? 0);
      default: return FINDINGS.source_unavailable();
    }
  };

  if (o.headersOnly) {
    const d = await diagnoseSmartsheet(id, token);
    if (d.stop || !d.shape) return stop(fromStop(d.stop?.code ?? "source_unavailable"));
    const sh = d.shape;
    const table: Table = {
      headers: sh.columns.map((c) => c.title), types: sh.columns.map((c) => c.type), hidden: sh.columns.map((c) => c.hidden),
      options: sh.columns.map((c) => c.options), rows: [], rowNumbers: [], totalRows: sh.totalRowCount,
    };
    return { kind: "table", table, tab: null, sheetName: sh.name, sheetEditedAt: sh.modifiedAt, accessLevel: sh.accessLevel, resolvedFromLink, requests: d.requests, shape: sh };
  }
  const r = await readSmartsheet(id, { rowLimit: cfg.rowLimit, token });
  if (r.kind === "stop") return stop(fromStop(r.code, r.detail));
  return { kind: "table", table: r.table, tab: null, sheetName: r.shape.name, sheetEditedAt: r.shape.modifiedAt, accessLevel: r.shape.accessLevel, resolvedFromLink, requests: r.requests, shape: r.shape };
}

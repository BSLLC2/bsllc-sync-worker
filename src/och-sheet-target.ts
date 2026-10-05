/**
 * Which Google Sheet and which tab hold OCH's Admission Board. Pure: no
 * network, no database, no clock.
 *
 * WHY THIS FILE EXISTS. The sheet id was typed into six scripts and the tab was
 * chosen three different ways: import-och and import-offline-conversions took
 * the FIRST tab whose name contains "admission", publish-och-web-leads wanted a
 * tab named exactly "Admission Board", and every one of them read a different
 * number of rows (5,000 or 10,000) and stopped there without saying so. So a
 * client who renamed the tab, added a second tab with "admission" in its name,
 * or simply kept a board that grew past the row limit broke one job and not
 * another, and nothing named the cause. One rule, read by all of them.
 *
 * WHAT IT REFUSES. It never guesses between two tabs that both look like the
 * board and says so (`ambiguous`), because a board silently read from last
 * month's tab freezes every number downstream with nothing failing. It never
 * truncates a read quietly: a board longer than `ROW_LIMIT` is a stop.
 */

export const OCH_SHEET_ID_DEFAULT = "1Ls-zDrNemixH2LiMYj9Hh7VumupNufYnRD6HEWL4u-8";

/** The tab people have always called the board. Preferred when several match. */
export const BOARD_TAB_NAME = "Admission Board";

/** Rows read from the board. The old limits were 5,000 and 10,000, unannounced. */
export const ROW_LIMIT = 20_000;

/** A board this close to the limit has stopped being read in full. */
export const ROW_LIMIT_MARGIN = 100;

/** The sheet to read: an explicit override wins, then the one we know. */
export function ochSheetId(env: Record<string, string | undefined> = process.env): string {
  const v = env.OCH_SHEET_ID?.trim();
  if (!v) return OCH_SHEET_ID_DEFAULT;
  // A Sheets URL pasted whole is the likeliest mistake. Take the id out of it.
  const m = v.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/);
  return m ? m[1]! : v;
}

export type TabHow =
  /** Named by the caller (--tab, or OCH_ADMISSIONS_TAB) and found. */
  | "override"
  /** Exactly one tab looks like the board. */
  | "only_match"
  /** Several look like the board and one is named "Admission Board". Still
   *  flagged: a look-alike appearing beside the board is the first sign OCH has
   *  started a new tab, weeks before the board goes quiet. Naming the tab in
   *  OCH_ADMISSIONS_TAB is the answer, and it clears the flag. */
  | "named_board"
  /** Several look like the board, none is named that: the first, flagged. */
  | "first_match"
  /** Nothing looks like the board, so the first tab. The old behaviour. */
  | "first_tab"
  /** The caller named a tab that does not exist. */
  | "override_missing"
  /** The sheet has no tabs. */
  | "none";

export interface TabPick {
  tab: string | null;
  how: TabHow;
  /** Every tab whose name looks like the board. */
  candidates: string[];
  /** More than one tab looks like the board and nothing settled which. */
  ambiguous: boolean;
}

const looksLikeBoard = (t: string) => /admission/i.test(t);
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function pickAdmissionTab(tabs: readonly string[], preferred?: string | null): TabPick {
  const names = tabs.filter((t) => typeof t === "string" && t.trim());
  if (names.length === 0) return { tab: null, how: "none", candidates: [], ambiguous: false };
  const candidates = names.filter(looksLikeBoard);
  const want = preferred?.trim();
  if (want) {
    const hit = names.find((t) => same(t, want));
    return hit
      ? { tab: hit, how: "override", candidates, ambiguous: false }
      : { tab: null, how: "override_missing", candidates, ambiguous: false };
  }
  if (candidates.length === 1) return { tab: candidates[0]!, how: "only_match", candidates, ambiguous: false };
  if (candidates.length > 1) {
    const board = candidates.find((t) => same(t, BOARD_TAB_NAME));
    return board
      ? { tab: board, how: "named_board", candidates, ambiguous: true }
      : { tab: candidates[0]!, how: "first_match", candidates, ambiguous: true };
  }
  return { tab: names[0]!, how: "first_tab", candidates, ambiguous: false };
}

/** A read that came back this full has been cut off by the limit. */
export function rowsCapped(rowsRead: number, limit = ROW_LIMIT): boolean {
  return rowsRead >= limit - ROW_LIMIT_MARGIN;
}

/** The A1 range to read a tab in full, quoting the name the way Sheets wants. */
export function boardRange(tab: string, limit = ROW_LIMIT): string {
  return `'${tab.replace(/'/g, "''")}'!A1:Z${limit}`;
}

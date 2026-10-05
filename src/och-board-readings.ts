/**
 * What the Admission Board says, month by month, read the way the import reads it.
 * Pure: rows in, counts out. No network, no database, no names.
 *
 * WHY. The daily check can tell that the sheet opens and has the right headings.
 * It cannot tell that the numbers on it quietly changed: somebody deleted forty
 * rows, re-dated a month, or a new status word ("Admitted - Residential") made
 * admissions stop counting. Those are the failures that write a LOWER number with
 * a fresh date and exit green. This reads the board with the import's own two
 * rules (isAdmittedStatus, and the first admission-date column that parses) so a
 * month here is the same month the import will write, and compares it to what
 * was written last time.
 *
 * COUNTS ONLY. It returns how many, never who. A status word is counted, not
 * quoted: a status cell is free text and can carry a name.
 */
import { isAdmittedStatus, parseSheetDate, ym as ymOf } from "./lead-keys.js";

export interface BoardCols { dateCols: number[]; statusCol: number; hasStatusCol: boolean }

export interface BoardReading {
  /** Admissions per complete month (`YYYY-MM`), months before the current one. */
  admittedByMonth: Record<string, number>;
  currentMonthAdmitted: number;
  /** Admitted rows with no admission date. They belong to no month. */
  admittedNoDate: number;
  /** Admitted rows dated after today (a 2027 typo). */
  futureDated: number;
  /** How many DISTINCT status words were neither an admission nor a denial. */
  unrecognizedStatuses: number;
}

export function readBoard(rows: string[][], cols: BoardCols, headerRow: number, today: string): BoardReading {
  const currentYm = today.slice(0, 7);
  const unrecognized = new Set<string>();
  const out: BoardReading = { admittedByMonth: {}, currentMonthAdmitted: 0, admittedNoDate: 0, futureDated: 0, unrecognizedStatuses: 0 };
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    if (!row.some((c) => c && c.toString().trim())) continue;
    // No status column means the sheet lists admissions only, as the import reads it.
    const admitted = cols.hasStatusCol ? isAdmittedStatus(row[cols.statusCol], unrecognized) : true;
    if (!admitted) continue;
    let on: Date | null = null;
    for (const dc of cols.dateCols) { on = parseSheetDate(row[dc]); if (on) break; }
    if (!on) { out.admittedNoDate++; continue; }
    const m = ymOf(on);
    if (m > currentYm) { out.futureDated++; continue; }
    if (m === currentYm) { out.currentMonthAdmitted++; continue; }
    out.admittedByMonth[m] = (out.admittedByMonth[m] ?? 0) + 1;
  }
  out.unrecognizedStatuses = unrecognized.size;
  return out;
}

export interface Drop { ym: string; now: number; then: number }

/** Months in the window that read LOWER now than when we last stored them. */
export const COMPARE_MONTHS = 6;
export const MIN_DROP = 2;
export const MIN_DROP_SHARE = 0.1;

/**
 * Compare the board now with what was stored. Only a FALL is reported: a month
 * that rises is an admission entered late, which is ordinary, and one that
 * falls is a row deleted or re-dated. A month with nothing stored is not
 * compared (a null is unanswered, never a nought), and a small wobble is not
 * reported: both the count and the share have to be past their floors.
 */
export function droppedMonths(now: Record<string, number>, stored: Record<string, number> | null, today: string): Drop[] {
  if (!stored) return [];
  const cur = today.slice(0, 7);
  const months = Object.keys(stored).filter((m) => m < cur).sort().slice(-COMPARE_MONTHS);
  const out: Drop[] = [];
  for (const m of months) {
    const then = stored[m]!;
    const n = now[m] ?? 0;
    const drop = then - n;
    if (drop >= MIN_DROP && drop / then >= MIN_DROP_SHARE) out.push({ ym: m, now: n, then });
  }
  return out.sort((a, b) => (b.then - b.now) - (a.then - a.now));
}

/**
 * Which column is which on OCH's hand-kept "Admission Board" — pure, so the
 * guard (`npm run verify-och-import`) can prove the rules without a sheet, a
 * network call or a credential.
 *
 * It exists because a header is a CLIENT-OWNED string. OCH edit their own
 * board, and on 2026-09-14 column A's heading went from "Name" to "h". Nothing
 * here can guess which column holds people's names once the heading stops
 * saying so, and guessing is worse than stopping: import-och wrote every row
 * with an empty name for six days, and because the admissions unique index is
 * (client_slug, admitted_on, phone, name), a blank-name row does not conflict
 * with the named row already there — it inserts BESIDE it. The drill-down
 * accumulated a nameless duplicate of every admission and the job exited 0.
 *
 * So: two rules, both of which used to be assumptions.
 *
 *   1. A heading we cannot recognise FAILS, loudly and by name. The message is
 *      the one import-offline-conversions.ts already prints for this same tab:
 *      it names the tab, quotes the header row it actually found, says what is
 *      missing, and says the fix is the client restoring their own heading.
 *   2. An admission is dated by an ADMISSION date, never by the inquiry date.
 *      They are different events, often in different months, and the second
 *      one silently moves revenue between months.
 */

/** Find the first column index whose header matches any of the needles. */
export function findCol(header: string[], needles: string[]): number {
  const norm = header.map((h) => (h ?? "").toString().trim().toLowerCase());
  for (let i = 0; i < norm.length; i++) if (needles.some((n) => norm[i]!.includes(n))) return i;
  return -1;
}

/** All column indexes matching any needle, left-to-right (for date fallbacks). */
export function findCols(header: string[], needles: string[]): number[] {
  const norm = header.map((h) => (h ?? "").toString().trim().toLowerCase());
  const out: number[] = [];
  for (let i = 0; i < norm.length; i++) if (needles.some((n) => norm[i]!.includes(n))) out.push(i);
  return out;
}

/** Pick the header row: the first row (within the first few) with ≥3 non-empty cells. */
export function findHeaderRow(rows: string[][]): number {
  for (let i = 0; i < Math.min(rows.length, 8); i++) {
    const filled = (rows[i] ?? []).filter((c) => c && c.toString().trim()).length;
    if (filled >= 3) return i;
  }
  return 0;
}

/**
 * Name synonyms, tried ONE LIST AT A TIME (needle priority, not column
 * position): a board carrying both "Client ID" and "Name" must resolve to
 * "Name". Same list as import-offline-conversions.ts, deliberately — the two
 * importers read the same tab and must agree on who a row is about.
 *
 * None of these rescues a heading that has been blanked or truncated to a
 * single letter. Nothing can, and that is the point.
 */
const NAME_NEEDLE_LISTS = [["name"], ["client"], ["patient"], ["resident"], ["member"]];

/**
 * Columns that date the ADMISSION. Per row, because intake fills whichever of
 * them they have — but every one of them is an admission date.
 *
 * "Inquiry Received" is NOT here and must never be: it dates the enquiry, which
 * routinely lands in an earlier month than the admission. Using it as a
 * fallback moved a row's revenue into the month the patient first called, which
 * changes no total and quietly misstates every month. import-offline-conversions
 * refuses it for the neighbouring reason (Google rejects a conversion timed
 * before its click); the honest month is the same rule seen from the other end.
 */
const ADMISSION_DATE_NEEDLE_LISTS = [
  ["scheduled admission"],
  ["projected admission", "admission date"],
  ["admit date", "date admitted", "date of admission"],
];

/** Recognised so the log can say what was ignored and why — never used to date a row. */
const INQUIRY_DATE_NEEDLES = ["inquiry received", "inquiry date", "intake date", "date of inquiry"];

export interface AdmissionColumns {
  /** Admission-date columns, in fallback order. Never an inquiry date. */
  dateCols: number[];
  /** Inquiry-date columns present on the board. Reported, never read for a month. */
  inquiryCols: number[];
  refCol: number;
  statusCol: number;
  hasStatusCol: boolean;
  phoneCol: number;
  dobCol: number;
  nameCol: number;
}

/** What the columns resolved to, for the run log. */
export function describeColumns(header: string[], c: AdmissionColumns): string {
  const h = (i: number) => header[i] ?? "?";
  return (
    `date:${c.dateCols.map(h).join(" / ") || "?"} · name:${h(c.nameCol)}` +
    ` · phone:${c.phoneCol >= 0 ? h(c.phoneCol) : "-"} · dob:${c.dobCol >= 0 ? h(c.dobCol) : "-"}` +
    ` · referent:${c.refCol >= 0 ? h(c.refCol) : "?"}` +
    ` · status:${c.hasStatusCol ? h(c.statusCol) : "(none — counting all rows)"}` +
    (c.inquiryCols.length ? ` · ignored for dating: ${c.inquiryCols.map(h).join(" / ")}` : "")
  );
}

/**
 * Resolve every column import-och needs, or throw with the message the account
 * manager can act on. Never returns a partially-resolved shape: a -1 name
 * column is the failure this function exists to stop.
 */
export function resolveAdmissionColumns(
  header: string[],
  ctx: { tab: string; headerRowIndex: number },
): AdmissionColumns {
  const dateCols = ADMISSION_DATE_NEEDLE_LISTS.flatMap((needles) => findCols(header, needles))
    .filter((v, i, a) => a.indexOf(v) === i);
  const inquiryCols = findCols(header, INQUIRY_DATE_NEEDLES).filter((c) => !dateCols.includes(c));
  const nameCol = NAME_NEEDLE_LISTS.reduce<number>(
    (found, needles) => (found >= 0 ? found : findCol(header, needles)),
    -1,
  );
  const refCol = findCol(header, ["referent", "referral", "source", "origin", "channel", "how did", "lead"]);
  const statusCol = findCol(header, ["status", "disposition", "outcome", "admitted"]);
  const phoneCol = findCol(header, ["phone"]);
  const dobCol = findCol(header, ["dob", "birth"]);

  // The three the run cannot honestly proceed without: a month for the row, a
  // person the row is about, and at least one key the web-inquiry cross-check
  // can match on. Same condition, same sentence, as import-offline-conversions.
  if (!dateCols.length || nameCol < 0 || (phoneCol < 0 && dobCol < 0)) {
    const missing = [
      !dateCols.length && "an admission-date column (Scheduled/Projected Admission Date)",
      nameCol < 0 && "a name column",
      phoneCol < 0 && dobCol < 0 && "a phone or DOB column",
    ].filter(Boolean).join(", ");
    throw new Error(
      `Admission Board header not recognized on tab "${ctx.tab}" (header row ${ctx.headerRowIndex + 1}: ` +
        `${header.join(" | ").slice(0, 200)}). Missing ${missing}. The client renamed or cleared a heading in ` +
        `their own sheet — the account manager asks them to restore it; there is nothing to change here.`,
    );
  }

  return {
    dateCols,
    inquiryCols,
    refCol,
    statusCol,
    // A status column that is also a date column is not a status column.
    hasStatusCol: statusCol >= 0 && !dateCols.includes(statusCol),
    phoneCol,
    dobCol,
    nameCol,
  };
}

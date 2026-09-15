/**
 * Which column is which on OCH's hand-kept "Admission Board" — pure, so the
 * guard (`npm run verify-och-import`) can prove the rules on fixture rows
 * without a sheet, a network call or a credential.
 *
 * THE POINT OF THIS MODULE. We built two importers against a spreadsheet the
 * CLIENT owns. They rename a heading, reorder a column or truncate a title by
 * accident, and that is an ordinary Tuesday on their side, not a fault to be
 * escalated back to them. On 2026-09-14 column A's heading went from "Name" to
 * "h" and both importers stopped: `import-och` wrote nothing for a month of
 * admissions, `import-offline-conversions` had failed daily since 2026-09-09.
 * Stopping was right on the day — the version before it wrote a blank name
 * onto every row, and because the admissions unique index is (client_slug,
 * admitted_on, phone, name) a blank-name row does not conflict, it inserts
 * BESIDE the real one — but "wait for the client to edit a cell" is not a
 * design.
 *
 * So a heading is now ONE signal, not the only one. Every column is resolved
 * from the heading first and, when the heading says nothing usable, from the
 * DATA underneath it: what the cells look like, how often they repeat, how
 * often they are filled, where the column sits, and how it relates to the
 * other columns. Nothing is resolved from a single weak signal — a wrong guess
 * mislabels every admission, which is worse than stopping — so a content-based
 * answer has to satisfy at least two independent tests before it is trusted,
 * and an ambiguous board still fails with the message it had before.
 *
 * The rules that do not move:
 *
 *   1. An unresolvable board FAILS, loudly and by name: the tab, the header
 *      row actually found, and what is missing. Only the trigger has changed —
 *      a renamed or truncated heading alone no longer causes it.
 *   2. An admission is dated by an ADMISSION date, never by the inquiry date.
 *      They are different events, usually in different months, and the second
 *      one silently moves revenue between months. When headings cannot tell
 *      them apart, the data has to, and if it cannot, the run stops rather
 *      than guessing.
 *   3. One resolver, two callers. `import-och` and `import-offline-conversions`
 *      read the same tab and must agree about who a row is about; each
 *      declares which columns IT cannot proceed without.
 */
import { parseSheetDate, isAdmittedStatus } from "./lead-keys.js";
import { isAttributable } from "./och-attribution.js";

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
 * "Name". Same list as the other importer, deliberately.
 */
const NAME_NEEDLE_LISTS = [["name"], ["client"], ["patient"], ["resident"], ["member"]];

/**
 * Columns that date the ADMISSION. Per row, because intake fills whichever of
 * them they have — but every one of them is an admission date.
 *
 * "Inquiry Received" is NOT here and must never be: it dates the enquiry,
 * which routinely lands in an earlier month than the admission.
 */
const ADMISSION_DATE_NEEDLE_LISTS = [
  ["scheduled admission"],
  ["projected admission", "admission date"],
  ["admit date", "date admitted", "date of admission"],
];

/** Recognised so the log can say what was ignored and why — never used to date a row. */
const INQUIRY_DATE_NEEDLES = ["inquiry received", "inquiry date", "intake date", "date of inquiry"];

const REFERENT_NEEDLES = ["referent", "referral", "source", "origin", "channel", "how did", "lead"];
const STATUS_NEEDLES = ["status", "disposition", "outcome", "admitted"];
const PHONE_NEEDLES = ["phone"];
const DOB_NEEDLES = ["dob", "birth"];

export type ColumnKey = "date" | "referent" | "status" | "phone" | "dob" | "name";

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
  /** How each column was identified — printed in the run log, so a resolution
   *  that came from the data rather than the heading is visible to a person. */
  how: Record<ColumnKey, string>;
}

// ── Reading the cells ───────────────────────────────────────────────────────
// Every signal below is computed over the rows UNDER the header. They are the
// half of the sheet the client cannot rename.

/** How many data rows are sampled. Enough to be representative, bounded so a
 *  5,000-row board stays cheap. */
const SAMPLE_ROWS = 400;
/** Below this many filled cells a column says nothing; content signals abstain. */
const MIN_FILLED = 5;

const oneLine = (v: unknown): string => String(v ?? "").replace(/\s+/g, " ").trim();
const digitsOf = (v: string): string => v.replace(/[^0-9]/g, "");

/** A cell that is a phone number: ten to fifteen digits and little else. */
function looksLikePhone(v: string): boolean {
  const d = digitsOf(v);
  if (d.length < 10 || d.length > 15) return false;
  return d.length / v.replace(/\s/g, "").length >= 0.55;
}

/** A cell that is a date, in any of the shapes intake types. */
function dateOf(v: string): Date | null {
  if (!/\d\s*[-/.]\s*\d/.test(v)) return null; // "5" and "MAT" are not dates
  return parseSheetDate(v);
}

/** A cell shaped like a person's name: one to four alphabetic words, no digits. */
function looksLikePerson(v: string): boolean {
  if (v.length < 3 || v.length > 40) return false;
  if (/\d/.test(v)) return false;
  const words = v.split(/\s+/);
  if (words.length < 1 || words.length > 4) return false;
  return words.every((w) => /^[A-Za-z][A-Za-z'’.\-]*$/.test(w));
}

/** A cell the admission-status vocabulary can classify either way. */
function looksLikeStatus(v: string): boolean {
  const unknown = new Set<string>();
  isAdmittedStatus(v, unknown);
  return unknown.size === 0; // it landed as admitted or as not-admitted, not as "never seen"
}

/** Values that name where an enquiry came from — ours and everyone else's.
 *  Used only to RECOGNISE a Referent column, never to attribute a row: that is
 *  och-attribution.ts's single job. */
const REFERRAL_VOCAB = [
  "referral", "referred", "friend", "family", "mother", "alumni", "alumnus", "past client", "returning",
  "word of mouth", "walk in", "walk-in", "insurance", "hospital", "court", "probation", "parole",
  "hotline", "helpline", "psychology today", "directory", "doctor", "physician", "therapist", "counselor",
];
function looksLikeReferentValue(v: string): boolean {
  if (isAttributable(v)) return true;
  const s = v.toLowerCase();
  return REFERRAL_VOCAB.some((w) => s.includes(w));
}

interface Profile {
  index: number;
  cells: string[];      // one per sampled row, "" when empty
  filled: number;
  fillRate: number;
  distinctRatio: number; // distinct filled values ÷ filled
  distinct: number;
  phoneRatio: number;
  dateRatio: number;
  dates: Array<Date | null>;
  medianYear: number | null;
  personRatio: number;
  multiWordRatio: number;
  statusRatio: number;
  referentVocabValues: number; // distinct filled values that name an origin
}

function profileColumn(index: number, sample: string[][]): Profile {
  const cells = sample.map((r) => oneLine(r[index]));
  const filledCells = cells.filter((c) => c);
  const filled = filledCells.length;
  const ratio = (n: number) => (filled ? n / filled : 0);
  const dates = cells.map((c) => (c ? dateOf(c) : null));
  const years = dates.filter((d): d is Date => !!d).map((d) => d.getUTCFullYear()).sort((a, b) => a - b);
  const distinctValues = new Set(filledCells.map((c) => c.toLowerCase()));
  return {
    index,
    cells,
    filled,
    fillRate: sample.length ? filled / sample.length : 0,
    distinct: distinctValues.size,
    distinctRatio: ratio(distinctValues.size),
    phoneRatio: ratio(filledCells.filter(looksLikePhone).length),
    dateRatio: ratio(dates.filter(Boolean).length),
    dates,
    medianYear: years.length ? years[Math.floor(years.length / 2)]! : null,
    personRatio: ratio(filledCells.filter(looksLikePerson).length),
    multiWordRatio: ratio(filledCells.filter((c) => c.split(/\s+/).length >= 2).length),
    statusRatio: ratio(filledCells.filter(looksLikeStatus).length),
    referentVocabValues: [...distinctValues].filter(looksLikeReferentValue).length,
  };
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

// ── Resolution ──────────────────────────────────────────────────────────────

export interface ResolveOptions {
  /** Columns THIS caller cannot proceed without. `contact` means a phone or a
   *  DOB — either is enough to tie a row to a captured lead. */
  require?: Array<"name" | "date" | "contact" | "referent">;
}

/**
 * Resolve every column, from the headings and from the data under them.
 *
 * `rows` is the whole tab as the Sheets API returns it, header row included:
 * the data is half the evidence and a header-only view cannot see it.
 */
export function resolveAdmissionColumns(
  rows: string[][],
  ctx: { tab: string; headerRowIndex: number },
  opts: ResolveOptions = {},
): AdmissionColumns {
  const require = opts.require ?? ["name", "date", "contact"];
  const header = rows[ctx.headerRowIndex] ?? [];
  const sample = rows.slice(ctx.headerRowIndex + 1, ctx.headerRowIndex + 1 + SAMPLE_ROWS)
    .filter((r) => r.some((c) => c && c.toString().trim()));
  const width = Math.max(header.length, ...sample.map((r) => r.length), 0);
  const profiles: Profile[] = [];
  for (let i = 0; i < width; i++) profiles.push(profileColumn(i, sample));
  const at = (i: number): Profile | undefined => (i >= 0 ? profiles[i] : undefined);
  /** A column with too little data underneath it cannot be judged on content. */
  const speaks = (p: Profile | undefined): p is Profile => !!p && p.filled >= MIN_FILLED;

  const how: Record<ColumnKey, string> = { date: "", referent: "", status: "", phone: "", dob: "", name: "" };
  const claimed = new Set<number>();
  const claim = (i: number) => { if (i >= 0) claimed.add(i); };
  const free = (p: Profile) => !claimed.has(p.index);

  // ── Phone ────────────────────────────────────────────────────────────────
  // Heading first, but when several columns say "phone" ("Phone Number" and
  // "Referent Phone #"), the one actually holding phone numbers most often
  // wins — the heading says which columns are candidates, the data picks.
  let phoneCol = -1;
  const phoneHeadings = findCols(header, PHONE_NEEDLES);
  if (phoneHeadings.length) {
    const ranked = [...phoneHeadings].sort((a, b) =>
      ((at(b)?.phoneRatio ?? 0) - (at(a)?.phoneRatio ?? 0)) || ((at(b)?.fillRate ?? 0) - (at(a)?.fillRate ?? 0)));
    const best = ranked[0]!;
    const bestP = at(best);
    // A heading that is contradicted by its own column is not evidence: a
    // column headed "Phone" holding no phone numbers has been reordered or
    // repurposed, and the content pass below is the honest answer.
    if (!speaks(bestP) || bestP.phoneRatio >= 0.5) {
      phoneCol = phoneHeadings.length > 1 && speaks(bestP) ? best : phoneHeadings[0]!;
      how.phone = phoneHeadings.length > 1 ? "heading, and of the columns headed “phone” the one holding numbers" : "heading";
    }
  }
  if (phoneCol < 0) {
    const cands = profiles.filter((p) => speaks(p) && free(p) && p.phoneRatio >= 0.7);
    if (cands.length) {
      phoneCol = cands[0]!.index;
      how.phone = `content: ${pct(cands[0]!.phoneRatio)} of filled cells are 10-digit numbers`;
    }
  }
  claim(phoneCol);

  // ── Status ───────────────────────────────────────────────────────────────
  // Needed before the dates: which rows are admissions is what tells an
  // admission date apart from an enquiry date when the headings cannot.
  let statusCol = findCol(header, STATUS_NEEDLES);
  if (statusCol >= 0) how.status = "heading";
  const statusP = at(statusCol);
  if (statusCol >= 0 && speaks(statusP) && statusP.statusRatio < 0.4) { statusCol = -1; how.status = ""; }
  if (statusCol < 0) {
    // A short, repeating vocabulary the admission-status rules can classify.
    const cands = profiles.filter((p) => speaks(p) && free(p) && p.statusRatio >= 0.7 && p.distinct <= 12 && p.fillRate >= 0.5);
    if (cands.length === 1) {
      statusCol = cands[0]!.index;
      how.status = `content: ${cands[0]!.distinct} repeating values, ${pct(cands[0]!.statusRatio)} of them admission statuses`;
    }
  }
  claim(statusCol);
  const admittedFlags = sample.map((r) => (statusCol >= 0 ? isAdmittedStatus(r[statusCol], new Set<string>()) : true));

  // ── Dates ────────────────────────────────────────────────────────────────
  const thisYear = new Date().getUTCFullYear();
  const isRecentDateCol = (p: Profile) => speaks(p) && p.dateRatio >= 0.7 && p.medianYear != null && p.medianYear >= thisYear - 6 && p.medianYear <= thisYear + 2;
  const isBirthDateCol = (p: Profile) => speaks(p) && p.dateRatio >= 0.7 && p.medianYear != null && p.medianYear <= thisYear - 16;

  let dateCols = ADMISSION_DATE_NEEDLE_LISTS.flatMap((needles) => findCols(header, needles))
    .filter((v, i, a) => a.indexOf(v) === i)
    // A heading contradicted by its own column is dropped, as with the phone.
    .filter((c) => { const p = at(c); return !speaks(p) || p.dateRatio >= 0.5; });
  let inquiryCols = findCols(header, INQUIRY_DATE_NEEDLES).filter((c) => !dateCols.includes(c));
  if (dateCols.length) how.date = "heading";

  if (!dateCols.length) {
    // No heading names an admission date. Two questions have to be answered
    // from the data, and BOTH have to agree before a column is trusted:
    //   a. is this column filled mainly on rows that were admitted? An
    //      admission date is; an enquiry date is filled on every row.
    //   b. is this column's date at or after the other recent date column's on
    //      nearly every row where both are filled? An admission follows the
    //      enquiry that produced it.
    // One recent date column on its own cannot answer (b), so it stays
    // ambiguous and the run stops: dating an admission from the enquiry is the
    // error that moves revenue between months without changing any total.
    const recent = profiles.filter(isRecentDateCol).filter(free);
    const scored = recent.map((p) => {
      const admittedFilled = p.cells.filter((c, i) => c && admittedFlags[i]).length;
      const admittedRows = admittedFlags.filter(Boolean).length;
      const otherFilled = p.cells.filter((c, i) => c && !admittedFlags[i]).length;
      const otherRows = admittedFlags.filter((f) => !f).length;
      const fillGap = (admittedRows ? admittedFilled / admittedRows : 0) - (otherRows ? otherFilled / otherRows : 0);
      let pairs = 0, notEarlier = 0;
      for (const q of recent) {
        if (q.index === p.index) continue;
        for (let i = 0; i < p.dates.length; i++) {
          const a = p.dates[i], b = q.dates[i];
          if (!a || !b) continue;
          pairs++;
          if (a.getTime() >= b.getTime()) notEarlier++;
        }
      }
      return { p, fillGap, laterRatio: pairs ? notEarlier / pairs : 0, pairs };
    });
    const winners = scored.filter((s) => s.pairs >= MIN_FILLED && s.laterRatio >= 0.8 && s.fillGap >= 0.2);
    if (winners.length === 1) {
      const w = winners[0]!;
      dateCols = [w.p.index];
      inquiryCols = recent.filter((p) => p.index !== w.p.index).map((p) => p.index);
      how.date = `content: dates on or after the other date column on ${pct(w.laterRatio)} of rows, and filled ${pct(w.fillGap)} more often on admitted rows`;
    }
  }
  for (const c of dateCols) claim(c);
  for (const c of inquiryCols) claim(c);

  // ── Date of birth ────────────────────────────────────────────────────────
  let dobCol = findCol(header, DOB_NEEDLES);
  if (dobCol >= 0) how.dob = "heading";
  const dobP = at(dobCol);
  if (dobCol >= 0 && speaks(dobP) && dobP.dateRatio < 0.5) { dobCol = -1; how.dob = ""; }
  if (dobCol < 0) {
    const cands = profiles.filter((p) => free(p) && isBirthDateCol(p));
    if (cands.length === 1) {
      dobCol = cands[0]!.index;
      how.dob = `content: dates with a median year of ${cands[0]!.medianYear}`;
    }
  }
  claim(dobCol);

  // ── Name ─────────────────────────────────────────────────────────────────
  // The column the client broke, and the one a wrong guess hurts most: a
  // mislabelled name goes into a conversion upload to Google and into the
  // drill-down a person reads. So three signals have to agree, and two of them
  // are about the data rather than the sheet's wording:
  //   a. shape — the cells look like people's names: alphabetic, one to four
  //      words, mostly two or more.
  //   b. near-uniqueness — patients barely repeat. This is what separates a
  //      name column from "Assigned to", which holds four staff names over and
  //      over, and from "Drug of Choice" or a status. The threshold sits in the
  //      middle of a very wide gap: a name column runs near 1.0 even with
  //      re-admissions in it, a column of labels runs under 0.2.
  //   c. position — the name has been the leftmost column throughout, and a
  //      board's identifying column being at the front is a general habit, not
  //      an OCH quirk. Only the first three columns are eligible.
  // Anything less is not enough, and then the run stops.
  let nameCol = NAME_NEEDLE_LISTS.reduce<number>((found, needles) => (found >= 0 ? found : findCol(header, needles)), -1);
  if (nameCol >= 0) how.name = "heading";
  const nameP = at(nameCol);
  if (nameCol >= 0 && speaks(nameP) && (nameP.personRatio < 0.5 || nameP.phoneRatio >= 0.5 || nameP.dateRatio >= 0.5)) {
    nameCol = -1; how.name = ""; // the heading says "Name" over something that is not names
  }
  if (nameCol < 0) {
    const cands = profiles.filter((p) =>
      speaks(p) && free(p) && p.index <= 2 &&
      p.personRatio >= 0.7 && p.multiWordRatio >= 0.6 && p.distinctRatio >= 0.6 && p.fillRate >= 0.6);
    if (cands.length) {
      const c = cands[0]!;
      nameCol = c.index;
      how.name = `content: ${pct(c.personRatio)} person-shaped, ${pct(c.distinctRatio)} distinct, column ${String.fromCharCode(65 + c.index)}`;
    }
  }
  claim(nameCol);

  // ── Referent ─────────────────────────────────────────────────────────────
  // Free text, so the content test is a vocabulary one: a Referent column
  // repeats a short label, and several of its distinct values name an origin —
  // ours ("Google", "web form") or anyone else's ("referral", "alumni",
  // "court"). Two signals again: the repetition and the vocabulary.
  let refCol = findCol(header, REFERENT_NEEDLES);
  if (refCol >= 0) how.referent = "heading";
  if (refCol < 0) {
    const cands = profiles.filter((p) =>
      speaks(p) && free(p) && p.fillRate >= 0.4 && p.distinctRatio <= 0.6 &&
      p.referentVocabValues >= 2 && p.personRatio < 0.9);
    if (cands.length === 1) {
      refCol = cands[0]!.index;
      how.referent = `content: ${cands[0]!.distinct} repeating short values, ${cands[0]!.referentVocabValues} of them naming an origin`;
    }
  }
  claim(refCol);

  // ── What this caller cannot proceed without ──────────────────────────────
  const missing = [
    require.includes("date") && !dateCols.length && "an admission-date column (Scheduled/Projected Admission Date)",
    require.includes("name") && nameCol < 0 && "a name column",
    require.includes("contact") && phoneCol < 0 && dobCol < 0 && "a phone or DOB column",
    require.includes("referent") && refCol < 0 && "a Referent column",
  ].filter(Boolean).join(", ");
  if (missing) {
    throw new Error(
      `Admission Board header not recognized on tab "${ctx.tab}" (header row ${ctx.headerRowIndex + 1}: ` +
        `${header.join(" | ").slice(0, 200)}). Missing ${missing}. No heading named it and the ${sample.length} data ` +
        `row(s) underneath did not identify one either — the account manager asks the client what changed; ` +
        `guessing which column this is would mislabel every admission.`,
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
    how,
  };
}

/** What the columns resolved to, and how, for the run log. */
export function describeColumns(header: string[], c: AdmissionColumns): string {
  const h = (i: number) => oneLine(header[i]) || `column ${String.fromCharCode(65 + i)}`;
  const withHow = (i: number, key: ColumnKey) => `${h(i)}${c.how[key] && c.how[key] !== "heading" ? ` [${c.how[key]}]` : ""}`;
  return (
    `date:${c.dateCols.map((i) => withHow(i, "date")).join(" / ") || "?"} · name:${c.nameCol >= 0 ? withHow(c.nameCol, "name") : "-"}` +
    ` · phone:${c.phoneCol >= 0 ? withHow(c.phoneCol, "phone") : "-"} · dob:${c.dobCol >= 0 ? withHow(c.dobCol, "dob") : "-"}` +
    ` · referent:${c.refCol >= 0 ? withHow(c.refCol, "referent") : "-"}` +
    ` · status:${c.hasStatusCol ? withHow(c.statusCol, "status") : "(none — counting all rows)"}` +
    (c.inquiryCols.length ? ` · ignored for dating: ${c.inquiryCols.map(h).join(" / ")}` : "")
  );
}

/**
 * One line naming every column that was identified from its DATA because the
 * heading no longer said what it holds — or null when the headings carried the
 * whole run. A content-resolved column is a guess that met its tests, and the
 * first run after a client edits their sheet is the run where a person should
 * read it. Silence about it would be how a wrong column becomes normal.
 */
export function contentResolvedNote(c: AdmissionColumns): string | null {
  const fromData = (Object.entries(c.how) as Array<[ColumnKey, string]>).filter(([, v]) => v.startsWith("content:"));
  if (!fromData.length) return null;
  return (
    `Resolved from the column's own data, not its heading: ` +
    fromData.map(([k, v]) => `${k} — ${v.replace(/^content: /, "")}`).join(" · ") +
    `. The client has renamed a heading; check this run's rows read right.`
  );
}

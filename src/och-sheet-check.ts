/**
 * The daily check on OCH's Admission Board connection. Pure: facts in, a list
 * of findings out. No network, no database, no clock (today is a fact).
 *
 * WHY. The connection to the client's own Google Sheet has several independent
 * ways to stop, and until now each of them was found the same way: numbers went
 * flat, somebody noticed, and the cause was dug out of a run log under pressure.
 * Each cause is knowable on its own, hours or weeks earlier, and each one has a
 * different person who has to act. So this names the cause in one sentence, says
 * whether it is ours or the client's to fix, and prints the steps.
 *
 * THE CAUSES, in the order they can occur:
 *   our key (missing, not a key file, refused by Google), the sheet (not found,
 *   no access, in the bin, read-only for us), the tab (gone, or several that
 *   look like the board), the headings (a column nobody can read), the length
 *   (the board outgrew what we read), and the board going quiet.
 *
 * TWO LEVELS. `stop` means the numbers downstream are or will be wrong and the
 * job exits non-zero, so Data health shows it red. `warn` means the connection
 * works and something about it deserves a person's eye (a second tab that
 * looks like the board, a board nobody has dated anything on for three weeks);
 * the job still succeeds and the note carries the sentence.
 *
 * WHAT IT REFUSES. It never calls a Google outage a client problem: a 5xx, a
 * 429 or a network failure after retries is `google_unavailable`, a warn, and
 * tomorrow's run decides. It never reads an unreachable check as a pass: a
 * check that could not run is absent from the result and the summary says which
 * ones were skipped. And it never prints a name, a phone number or a date of
 * birth: it sees counts, tab names and dates only.
 */
import type { TabPick } from "./och-sheet-target.js";

export const CAUSE_CODES = [
  "key_missing", "key_unreadable", "key_rejected",
  "sheet_not_found", "access_removed", "sheet_in_bin", "read_only",
  "tab_missing", "tab_ambiguous", "headings", "board_too_long", "board_empty", "board_quiet",
  "google_unavailable", "check_crashed",
] as const;
export type CauseCode = (typeof CAUSE_CODES)[number];

export type Level = "stop" | "warn";
/** Who has to act. `either` means the first thing to do is find out. */
export type Who = "us" | "client" | "either";

/** A board with nothing dated this recently is quiet. OCH admits about a month. */
export const QUIET_AFTER_DAYS = 21;

export interface Finding {
  code: CauseCode;
  level: Level;
  who: Who;
  /** One plain sentence. Safe to show an owner. */
  line: string;
  steps: string[];
}

export interface CheckFacts {
  /** YYYY-MM-DD on the business clock. */
  today: string;
  key: {
    state: "ok" | "missing" | "unparseable" | "incomplete" | "rejected" | "unavailable";
    /** The service account's address, where the key file could be read. */
    serviceEmail: string | null;
  };
  /** The sheet-metadata call. Null when the key stopped us reaching it. */
  sheet: { status: number | null; unavailable: boolean } | null;
  /** Drive's view of the file. Absent (checked false) when Drive is not enabled. */
  drive: { checked: boolean; trashed: boolean | null; canEdit: boolean | null; modifiedYmd: string | null };
  tabs: string[];
  pick: TabPick | null;
  /** The column resolver's verdict on the chosen tab. Null when not reached. */
  columns: { ok: boolean; detail: string | null } | null;
  /** Rows the read returned, header included. Null when not reached. */
  rowsRead: number | null;
  rowsCapped: boolean;
  /** Newest admission date on the tab that is not in the future. */
  newestAdmissionYmd: string | null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const short = (ymd: string) => `${MONTHS[Number(ymd.slice(5, 7)) - 1]} ${Number(ymd.slice(8, 10))}`;
const isYmd = (v: string | null | undefined): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
export function daysBetween(fromYmd: string, toYmd: string): number {
  const t = (s: string) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  return Math.round((t(toYmd) - t(fromYmd)) / 86_400_000);
}
const tabList = (tabs: readonly string[], max = 8) =>
  tabs.length === 0 ? "none" : tabs.slice(0, max).map((t) => `"${t}"`).join(", ") + (tabs.length > max ? ` and ${tabs.length - max} more` : "");
const who = (e: string | null) => e ?? "the service account (its address is in the key file)";

const KEY_STEPS = [
  "Open Google Cloud Console, then IAM & Admin, then Service accounts, and open the dashboard sync account.",
  "Keys tab, Add key, Create new key, JSON. Download the file.",
  "On GitHub, open BSLLC2/bsllc-sync-worker, Settings, Secrets and variables, Actions. Paste the whole file into GOOGLE_SERVICE_ACCOUNT_JSON.",
  "Run the Check OCH sheet workflow by hand. It reads green when the key works.",
];

export function checkOchSheet(f: CheckFacts): Finding[] {
  const out: Finding[] = [];
  const add = (x: Finding) => out.push(x);

  // 1. Our key.
  if (f.key.state === "missing") {
    add({ code: "key_missing", level: "stop", who: "us", line: "The Google service account key is not set on the worker.", steps: KEY_STEPS.slice(2) });
    return out;
  }
  if (f.key.state === "unparseable" || f.key.state === "incomplete") {
    add({
      code: "key_unreadable", level: "stop", who: "us",
      line: f.key.state === "unparseable"
        ? "The Google service account key on the worker is not a valid key file."
        : "The Google service account key on the worker is missing its address or private key.",
      steps: ["Paste the whole downloaded JSON file into GOOGLE_SERVICE_ACCOUNT_JSON, not part of it.", ...KEY_STEPS.slice(3)],
    });
    return out;
  }
  if (f.key.state === "rejected") {
    add({
      code: "key_rejected", level: "stop", who: "us",
      line: "Google no longer accepts our service account key. It was deleted, switched off, or has expired.",
      steps: KEY_STEPS,
    });
    return out;
  }
  if (f.key.state === "unavailable") {
    add({ code: "google_unavailable", level: "warn", who: "either", line: "Google did not answer when we asked for access. Tomorrow's run decides whether it is a problem.", steps: [] });
    return out;
  }

  // 2. The sheet.
  if (!f.sheet) return out;
  if (f.sheet.unavailable) {
    add({ code: "google_unavailable", level: "warn", who: "either", line: "Google Sheets did not answer after three tries. Tomorrow's run decides whether it is a problem.", steps: [] });
    return out;
  }
  if (f.sheet.status === 404) {
    add({
      code: "sheet_not_found", level: "stop", who: "either",
      line: "Google says the Admission Board sheet does not exist, or is no longer shared with us.",
      steps: [
        "Open the sheet in a browser while signed in as digital@bsllc.biz. If it will not open, ask OCH where it went.",
        `If it opens, share it with ${who(f.key.serviceEmail)} as Editor.`,
        "If OCH moved the board to a new sheet, copy that sheet's address into the OCH_SHEET_ID variable on bsllc-sync-worker (Settings, Secrets and variables, Actions, Variables).",
      ],
    });
    return out;
  }
  if (f.sheet.status === 401 || f.sheet.status === 403) {
    add({
      code: "access_removed", level: "stop", who: "client",
      line: "Google is refusing us access to the Admission Board sheet. Sharing was removed, or the account that owned it changed.",
      steps: [
        `Ask OCH to share the sheet with ${who(f.key.serviceEmail)} as Editor.`,
        "Ask them to make a current OCH administrator the owner, so the sheet does not depend on one employee's account.",
      ],
    });
    return out;
  }
  if (f.sheet.status != null && f.sheet.status >= 400) {
    add({ code: "google_unavailable", level: "warn", who: "either", line: `Google Sheets answered with an error (${f.sheet.status}). Tomorrow's run decides whether it is a problem.`, steps: [] });
    return out;
  }

  // Drive's extra view. Only said when Drive answered.
  if (f.drive.checked && f.drive.trashed === true) {
    add({
      code: "sheet_in_bin", level: "stop", who: "client",
      line: "The Admission Board sheet is in the bin at OCH. It still reads, but Google deletes it for good after 30 days.",
      steps: ["Ask OCH to open Google Drive, then Bin, and restore the sheet.", "Ask them to make a current OCH administrator the owner."],
    });
  }
  if (f.drive.checked && f.drive.canEdit === false) {
    add({
      code: "read_only", level: "warn", who: "client",
      line: "We can read the sheet but not write to it, so our Web Leads tab on it cannot update.",
      steps: [`Ask OCH to change our access to Editor for ${who(f.key.serviceEmail)}.`],
    });
  }

  // 3. The tab.
  const pick = f.pick;
  if (!pick || pick.tab == null) {
    add({
      code: "tab_missing", level: "stop", who: "either",
      line: pick?.how === "override_missing"
        ? `The tab we were told to read is not in the sheet. Tabs now: ${tabList(f.tabs)}.`
        : `The sheet has no tab we can read. Tabs now: ${tabList(f.tabs)}.`,
      steps: [
        "Find which tab holds the Admission Board now.",
        "Put its exact name in the OCH_ADMISSIONS_TAB variable on bsllc-sync-worker, or ask OCH to restore the old name.",
      ],
    });
    return out;
  }
  if (pick.ambiguous) {
    add({
      code: "tab_ambiguous", level: "warn", who: "client",
      line: `${pick.candidates.length} tabs look like the Admission Board (${tabList(pick.candidates)}). We are reading "${pick.tab}".`,
      steps: [
        "Ask OCH whether a new tab replaced the old one.",
        "If the board is on another tab, put its exact name in the OCH_ADMISSIONS_TAB variable on bsllc-sync-worker.",
      ],
    });
  }

  // 4. The headings.
  if (f.columns && !f.columns.ok) {
    add({
      code: "headings", level: "stop", who: "client",
      line: f.columns.detail ? `A column on the board cannot be read. ${f.columns.detail}` : "A column on the board cannot be read.",
      steps: ["Ask OCH to put the column heading back, or name it in plain words (Name, Date, Phone, Status, Referent).", "The import picks it up on its next run."],
    });
    return out;
  }

  // 5. The length.
  if (f.rowsCapped) {
    add({
      code: "board_too_long", level: "stop", who: "us",
      line: `The board has reached ${(f.rowsRead ?? 0).toLocaleString("en-US")} rows, the most we read. Rows past that are not counted.`,
      steps: ["Raise ROW_LIMIT in src/och-sheet-target.ts, or ask OCH to move closed years to another tab."],
    });
  }
  if (f.rowsRead != null && f.rowsRead <= 1) {
    add({ code: "board_empty", level: "stop", who: "either", line: `The "${pick.tab}" tab has no rows under its heading.`, steps: ["Open the tab. If the board moved, name the new tab in OCH_ADMISSIONS_TAB."] });
    return out;
  }

  // 6. Going quiet.
  if (isYmd(f.newestAdmissionYmd)) {
    const age = daysBetween(f.newestAdmissionYmd, f.today);
    if (age > QUIET_AFTER_DAYS) {
      const edited = isYmd(f.drive.modifiedYmd) ? daysBetween(f.drive.modifiedYmd, f.today) : null;
      const elsewhere = edited != null && edited <= QUIET_AFTER_DAYS;
      add({
        code: "board_quiet", level: "warn", who: "client",
        line: elsewhere
          ? `Nothing on "${pick.tab}" is dated in the last ${QUIET_AFTER_DAYS} days (newest ${short(f.newestAdmissionYmd)}), but the sheet was edited ${edited} day${edited === 1 ? "" : "s"} ago. They may be working in another tab.`
          : `Nothing on "${pick.tab}" is dated in the last ${QUIET_AFTER_DAYS} days (newest ${short(f.newestAdmissionYmd)}).`,
        steps: [
          elsewhere ? "Ask OCH whether admissions moved to a new tab or sheet." : "Ask OCH whether the team has stopped updating the board.",
          "If it moved, name the new tab in OCH_ADMISSIONS_TAB, or the new sheet in OCH_SHEET_ID, on bsllc-sync-worker.",
        ],
      });
    }
  }
  return out;
}

/**
 * What a failure to mint a token means. Google answers a deleted, disabled or
 * expired key with a 400/401 (`invalid_grant`, "Invalid JWT Signature",
 * `unauthorized_client`); everything else (a timeout, a 5xx, no network) says
 * nothing about the key and must never read as a dead one.
 */
export function classifyTokenError(e: unknown): "rejected" | "unavailable" {
  const err = e as { message?: string; response?: { status?: number; data?: { error?: string } }; code?: string | number } | null;
  const status = err?.response?.status;
  const gErr = String(err?.response?.data?.error ?? "");
  const msg = String(err?.message ?? "");
  if (/invalid_grant|unauthorized_client|invalid_client|Invalid JWT|account not found|disabled/i.test(`${gErr} ${msg}`)) return "rejected";
  if (status === 400 || status === 401) return "rejected";
  return "unavailable";
}

/** The one line the heartbeat note carries. The dashboard parses it, so the shape is a contract. */
export function summaryLine(findings: readonly Finding[], ok: { tab: string | null; rows: number | null; newest: string | null }): string {
  const first = findings.find((x) => x.level === "stop") ?? findings[0];
  if (first) return `OCH-SHEET ${first.level} ${first.code}: ${first.line}`.slice(0, 295);
  const bits = [
    ok.tab ? `read "${ok.tab}"` : "read the board",
    ok.rows != null ? `${Math.max(0, ok.rows - 1).toLocaleString("en-US")} rows` : null,
    ok.newest ? `newest admission ${short(ok.newest)}` : null,
  ].filter(Boolean);
  return `OCH-SHEET ok: ${bits.join(", ")}.`.slice(0, 295);
}

export const hasStop = (findings: readonly Finding[]) => findings.some((x) => x.level === "stop");

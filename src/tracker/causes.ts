/**
 * The ways a tracker read stops or warns, each with its own cause code, whose
 * move it is and the steps. The dashboard compares CAUSE_CODES with its own list
 * both ways (`npm run verify:wiring`), and the last line a run prints is the
 * heartbeat note it parses:
 *
 *   TRACKER-FEED <client-slug> ok|warn|stop <cause>: <sentence>
 *
 * Every sentence carries counts, dates and heading names only: never a cell.
 */
import { ROLE_NAMES, type RoleName } from "./config.js";
import type { Problem, ProblemWhy } from "./reading.js";

export const CAUSE_CODES = [
  "not_configured", "sheet_id_unusable", "token_missing", "token_rejected", "access_denied", "sheet_not_found", "sheet_not_shared",
  "key_missing", "key_unreadable", "key_rejected", "access_removed", "sheet_in_bin", "tab_missing",
  "headers_missing", "headers_duplicate", "lead_list_only", "sheet_empty", "sheet_too_long", "rows_incomplete",
  "rate_limited", "source_unavailable", "rows_refused", "other_status", "access_too_wide", "check_crashed",
  "one_sheet_stopped", "sheets_disagree",
] as const;
export type CauseCode = (typeof CAUSE_CODES)[number];
export type Level = "stop" | "warn";
/** `provider`: Smartsheet or Google, not us and not the sheet. */
export type Who = "us" | "client" | "either" | "provider";
export interface Finding { code: CauseCode; level: Level; who: Who; line: string; steps: string[] }

const list = (xs: readonly string[]) => xs.map((x) => `"${x}"`).join(", ");
export const ROLE_PLAIN: Record<RoleName, string> = {
  status: "the status (Won or not)", amount: "the amount", closedDate: "the closed date", source: "the source (which rows are ours)",
  confirmFlag: "the confirmed flag", firstContact: "the first-contact date", gclid: "the click id", rowLabel: "the row reference",
  type: "the lead type", email: "the email", phone: "the phone", formId: "the form id", name: "the name",
};

export const FINDINGS = {
  not_configured: (key: string): Finding => ({
    code: "not_configured", level: "stop", who: "us",
    line: `No sheet is set for ${key} yet, so there is nothing to read.`,
    steps: [`Set the repository variable ${key.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_TRACKER_SHEET to the sheet's link or its id, then run this again with diagnose set to true.`],
  }),
  sheet_id_unusable: (): Finding => ({
    code: "sheet_id_unusable", level: "stop", who: "us",
    line: "The sheet value is not a link or an id this job can use.",
    steps: ["Paste the sheet's address from the browser (a Smartsheet link ends in /sheets/ and a long code), or the numeric Sheet ID under File, Properties."],
  }),
  sheet_not_shared: (): Finding => ({
    code: "sheet_not_shared", level: "stop", who: "us",
    line: "None of the sheets the integration user can see matches that link. The sheet is not shared with the user whose token this job holds.",
    steps: ["Share the sheet with the integration user's email as Viewer, then run this again.", "Check the token belongs to that user (Account, Personal Settings, API Access)."],
  }),
  token_missing: (): Finding => ({
    code: "token_missing", level: "stop", who: "us",
    line: "The Smartsheet access token is not set on this job, so the sheet cannot be opened.",
    steps: ["Add the secret SMARTSHEET_API_TOKEN to the worker repository (Settings, Secrets and variables, Actions)."],
  }),
  token_rejected: (): Finding => ({
    code: "token_rejected", level: "stop", who: "us",
    line: "Smartsheet refused our access token (revoked, expired or wrong).",
    steps: ["In Smartsheet, as the integration user: Account, Personal Settings, API Access, generate a new token, and replace the SMARTSHEET_API_TOKEN secret."],
  }),
  access_denied: (keptBy: "us" | "client"): Finding => ({
    code: "access_denied", level: "stop", who: keptBy === "client" ? "client" : "us",
    line: "Smartsheet says the integration user is not allowed to read this sheet.",
    steps: ["Share the sheet with the integration user's email as Viewer, then run this again."],
  }),
  sheet_not_found: (): Finding => ({
    code: "sheet_not_found", level: "stop", who: "either",
    line: "Smartsheet cannot find that sheet for the integration user. It was deleted or moved, the id is wrong, or it was never shared with that user (Smartsheet answers the same way for all three).",
    steps: ["Check the Sheet ID under File, Properties.", "Check the sheet is shared with the integration user as Viewer."],
  }),
  key_missing: (): Finding => ({ code: "key_missing", level: "stop", who: "us", line: "The Google service account key is not set on this job, so the sheet cannot be opened.", steps: ["Set the GOOGLE_SERVICE_ACCOUNT_JSON secret on the worker repository."] }),
  key_unreadable: (): Finding => ({ code: "key_unreadable", level: "stop", who: "us", line: "The Google service account key is set but is not a usable key file.", steps: ["Paste the whole JSON key file into the GOOGLE_SERVICE_ACCOUNT_JSON secret again."] }),
  key_rejected: (): Finding => ({ code: "key_rejected", level: "stop", who: "us", line: "Google refused our service account key (revoked, expired or deleted).", steps: ["Create a new key for the service account and replace the GOOGLE_SERVICE_ACCOUNT_JSON secret."] }),
  access_removed: (email: string | null): Finding => ({ code: "access_removed", level: "stop", who: "us", line: `Google says our service account${email ? ` (${email})` : ""} cannot open the sheet. It was never shared with it, or the share was removed.`, steps: ["Share the sheet with the service account's email as Viewer, then run this again."] }),
  sheet_in_bin: (): Finding => ({ code: "sheet_in_bin", level: "stop", who: "us", line: "The sheet is in the bin in Google Drive.", steps: ["Restore it from the bin, then run this again."] }),
  tab_missing: (tabs: readonly string[]): Finding => ({ code: "tab_missing", level: "stop", who: "us", line: `The tab this job was told to read is not in the sheet. Tabs now: ${tabs.join(", ") || "none"}.`, steps: ["Set the repository variable for the tab to the exact tab name, then run this again."] }),
  headers_missing: (roles: readonly RoleName[], looked: Partial<Record<RoleName, readonly string[]>>): Finding => ({
    code: "headers_missing", level: "stop", who: "us",
    line: `The sheet has no heading for ${list(roles.map((r) => ROLE_PLAIN[r]))}. Nothing was imported. Looked for: ${roles.map((r) => `${ROLE_PLAIN[r]} as ${list((looked[r] ?? []).slice(0, 4))}`).join("; ")}.`.slice(0, 600),
    steps: ["Run this with diagnose set to true to list the headings the sheet has.", "Rename the heading in the sheet, or add the new heading as an alias for that role in src/tracker/config.ts."],
  }),
  lead_list_only: (): Finding => ({
    code: "lead_list_only", level: "stop", who: "either",
    line: "This sheet lists leads (click ids, emails, phones, dates) but has no outcome columns (status, amount, closed date), so wins cannot be counted from it. Nothing was imported.",
    steps: ["Point this job at the sales log that carries the outcome, or add status, amount and closed-date columns to this sheet."],
  }),
  headers_duplicate: (dups: readonly { role: RoleName; headers: readonly string[] }[]): Finding => ({
    code: "headers_duplicate", level: "stop", who: "us",
    line: `More than one heading could be ${dups.map((d) => `${ROLE_PLAIN[d.role]} (${list(d.headers)})`).join("; ")}, so the job cannot tell which column to read. Nothing was imported.`.slice(0, 600),
    steps: ["Rename or remove the extra column, or remove the unwanted heading from the aliases in src/tracker/config.ts."],
  }),
  sheet_empty: (): Finding => ({ code: "sheet_empty", level: "stop", who: "us", line: "The sheet came back with no rows at all. Nothing was imported.", steps: ["Open the sheet and check it was not cleared. Version history can restore it."] }),
  sheet_too_long: (rows: number, limit: number): Finding => ({ code: "sheet_too_long", level: "stop", who: "us", line: `The sheet has ${rows.toLocaleString("en-US")} rows, past the ${limit.toLocaleString("en-US")} this job reads, so it may be cut off. Nothing was imported.`, steps: ["Raise rowLimit in src/tracker/config.ts, or archive old rows."] }),
  rows_incomplete: (got: number, want: number): Finding => ({ code: "rows_incomplete", level: "stop", who: "provider", line: `Smartsheet said the sheet has ${want.toLocaleString("en-US")} rows and only ${got.toLocaleString("en-US")} arrived. Nothing was imported.`, steps: ["Run this again. If it repeats, the paging in src/tracker/smartsheet.ts needs a look."] }),
  rate_limited: (): Finding => ({ code: "rate_limited", level: "stop", who: "provider", line: "The platform kept answering that we asked too often. Nothing was imported and the last good figures stand.", steps: ["Run this again in a few minutes. No action on the sheet."] }),
  source_unavailable: (): Finding => ({ code: "source_unavailable", level: "stop", who: "provider", line: "The platform did not answer after several tries. This is the platform, not the sheet. Nothing was imported and the last good figures stand.", steps: ["Run this again later. No action on the sheet."] }),
  rows_refused: (problems: readonly Problem[]): Finding => {
    const by = (w: ProblemWhy) => problems.filter((p) => p.why === w).map((p) => p.row);
    const bits = ([["won_no_amount", "no amount"], ["won_no_date", "no closed date"], ["won_before_window", "a closed date before the window"], ["won_future_date", "a closed date in the future"]] as [ProblemWhy, string][])
      .map(([w, t]) => (by(w).length ? `${by(w).length} marked Won with ${t} (row${by(w).length === 1 ? "" : "s"} ${by(w).slice(0, 6).join(", ")}${by(w).length > 6 ? ", more" : ""})` : null)).filter(Boolean);
    return { code: "rows_refused", level: "warn", who: "us", line: `${bits.join("; ")}. Not counted.`, steps: ["Fix those rows in the sheet. They count the day they are complete."] };
  },
  other_status: (n: number): Finding => ({ code: "other_status", level: "warn", who: "us", line: `${n} row${n === 1 ? " has" : "s have"} a status this job does not recognise, so ${n === 1 ? "it is" : "they are"} counted nowhere.`, steps: ["Use Won for a win, or add the new status word to the known words in src/tracker/config.ts."] }),
  access_too_wide: (level: string): Finding => ({ code: "access_too_wide", level: "warn", who: "us", line: `The integration user has ${level.toLowerCase()} access to this sheet. Viewer is enough, and this job only reads.`, steps: ["Change the share to Viewer so a mistake here could never edit the sheet."] }),
  /** Several sheets are set and some could not be read. The ones that could are counted; the others' wins are left out until they can be. */
  one_sheet_stopped: (stopped: readonly { label: string; cause: string }[], read: readonly string[]): Finding => ({
    code: "one_sheet_stopped", level: "warn", who: "us",
    line: `${stopped.map((s) => `${s.label} (${s.cause})`).join(" and ")} could not be read, so its wins are left out of this figure until it can be. ${read.join(" and ")} ${read.length === 1 ? "was" : "were"} read.`.slice(0, 400),
    steps: ["Read that sheet's own line above for the cause and its steps, fix it, then run this again.", "Run with diagnose set to true to list the headings that sheet has."],
  }),
  /** Two sheets hold rows that may be the same sale and the sheets do not prove it. */
  sheets_disagree: (conflicts: number, held: number): Finding => ({
    code: "sheets_disagree", level: "warn", who: "either",
    line: `${[conflicts ? `${conflicts} deal${conflicts === 1 ? " is" : "s are"} on both sheets with a different amount or date (counted at the lower amount and the later date)` : "", held ? `${held} row${held === 1 ? "" : "s"} could be the same deal as a row on the other sheet (held, not counted)` : ""].filter(Boolean).join("; ")}.`,
    steps: ["Put the same email or click id on both rows if they are the same deal. A held row counts the day the sheets show it is a different deal.", "Fix the amount or date on whichever sheet is wrong."],
  }),
  check_crashed: (why: string): Finding => ({ code: "check_crashed", level: "stop", who: "us", line: `The import itself failed (${why.replace(/\s+/g, " ").slice(0, 150)}).`, steps: ["Open the run log in GitHub Actions."] }),
};

export const hasStop = (fs: readonly Finding[]): boolean => fs.some((f) => f.level === "stop");
const RANK: Record<string, number> = { stop: 2, warn: 1, ok: 0 };

/** One heartbeat line for one client. */
export function lineFor(slug: string, findings: readonly Finding[], ok: { sourceKind: string; rows: number; counted: number; pending: number; sheetsRead?: number } | null): string {
  const first = findings.find((f) => f.level === "stop") ?? findings[0];
  if (first) return `TRACKER-FEED ${slug} ${first.level} ${first.code}: ${first.line}`.slice(0, 295);
  const bits = [ok && ok.sheetsRead && ok.sheetsRead > 1 ? `read ${ok.sheetsRead} sheets` : ok ? `read ${ok.sourceKind === "smartsheet" ? "Smartsheet" : "the Google sheet"}` : "read the sheet", ok ? `${ok.rows.toLocaleString("en-US")} rows` : null, ok ? `${ok.counted} won since the feed began` : null, ok ? `${ok.pending} pending` : null].filter(Boolean);
  return `TRACKER-FEED ${slug} ok: ${bits.join(", ")}.`.slice(0, 295);
}

/** The worst of several clients' lines is the heartbeat's note. Ties keep the first. */
export function worstLine(lines: readonly string[]): string {
  const level = (l: string) => l.match(/^TRACKER-FEED \S+ (ok|warn|stop)/)?.[1] ?? "ok";
  return [...lines].sort((a, b) => RANK[level(b)]! - RANK[level(a)]!)[0] ?? "";
}
export { ROLE_NAMES };

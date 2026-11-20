/**
 * Fathom's list-meetings API: the request, the page parser, and the one function
 * that turns a listed meeting into the body the dashboard's webhook already takes.
 *
 * WHY THE BODY IS BUILT HERE AND NOT IN THE APP. The dashboard's POST
 * /api/fathom-webhook is the one door every call goes through (matching, the
 * 45-minute fold, the intake items, the CRM link). Fathom's list answer carries the
 * same fields its webhook sends, so this file only chooses which of them cross and
 * drops the rest. NOTHING ELSE IS READ: not the transcript, not a share of the video,
 * nothing a person did not already see in the webhook.
 *
 * EVERY ADDRESS, PARAMETER AND FIELD NAME BELOW IS WRITTEN FROM FATHOM'S PUBLISHED
 * API REFERENCE AS REMEMBERED AND HAS NEVER BEEN RUN AGAINST A LIVE ACCOUNT. Each is
 * marked UNVERIFIED. The first run is a dry run, and `docs/FATHOM-PULL.md` lists what
 * to read in its output to confirm or refute each one.
 *
 * Pure: no I/O, no clock, no secret.
 */

/** UNVERIFIED: the API's base address. */
export const FATHOM_API_BASE = "https://api.fathom.ai/external/v1";
/** UNVERIFIED: the header Fathom reads the key from. */
export const FATHOM_KEY_HEADER = "X-Api-Key";
/** UNVERIFIED: the published limit is 60 requests a minute; we stay under it on purpose. */
export const FATHOM_MIN_GAP_MS = 1100;
/** Our own line: pages are only ever followed this far in one run. */
export const MAX_PAGES = 400;

/** What the test seam changes. No workflow sets it; the guard fails if one does. */
export const FAKE_BASE_ENV = "FATHOM_FAKE_BASE";

export interface ListArgs { base: string; createdAfter: string; cursor: string | null }

/** UNVERIFIED parameters: created_after (ISO), cursor, include_summary, include_action_items, include_crm_matches. */
export function listUrl(a: ListArgs): string {
  const q = new URLSearchParams();
  q.set("created_after", a.createdAfter);
  q.set("include_summary", "true");
  q.set("include_action_items", "true");
  q.set("include_crm_matches", "true");
  if (a.cursor) q.set("cursor", a.cursor);
  return `${a.base.replace(/\/+$/, "")}/meetings?${q.toString()}`;
}

export interface ListedMeeting {
  /** The id the webhook would have used (recording_id), always a string of digits. */
  recordingId: string;
  /** The listed object, untouched, for `buildWebhookBody` to choose from. */
  raw: Record<string, unknown>;
  startedAt: string | null;
  recordedByEmail: string | null;
}

export interface ListPage {
  items: ListedMeeting[];
  /** Items on the page that carried no usable recording id. Counted, never shown. */
  unreadable: number;
  nextCursor: string | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : null);

export class ShapeChanged extends Error {
  constructor(message: string) { super(message); this.name = "ShapeChanged"; }
}

/**
 * One answer → one page. UNVERIFIED shape: `{ items: [...], next_cursor: string|null }`.
 * A body that is not an object with an `items` array, or a page of items none of
 * which carries a recording id, is a SHAPE CHANGE and stops the run: reading it as
 * "no meetings" would turn a changed API into a quiet pull of nothing.
 */
export function parseListPage(body: unknown): ListPage {
  if (!isObj(body) || !Array.isArray(body.items)) throw new ShapeChanged("the answer has no items list");
  const items: ListedMeeting[] = [];
  let unreadable = 0;
  for (const it of body.items) {
    if (!isObj(it)) { unreadable += 1; continue; }
    const id = str(it.recording_id) ?? str(it.id);
    if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) { unreadable += 1; continue; }
    const rb = isObj(it.recorded_by) ? it.recorded_by : null;
    items.push({
      recordingId: id,
      raw: it,
      startedAt: str(it.scheduled_start_time) ?? str(it.recording_start_time) ?? str(it.created_at),
      recordedByEmail: rb ? (str(rb.email)?.toLowerCase() ?? null) : null,
    });
  }
  if (body.items.length > 0 && items.length === 0) throw new ShapeChanged("none of the listed meetings carries a recording id");
  const next = str(body.next_cursor);
  return { items, unreadable, nextCursor: next };
}

const pick = (o: Record<string, unknown>, keys: string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) out[k] = o[k];
  return out;
};

/**
 * The webhook body for one listed meeting. Allowlisted: a field this build does not
 * name is never forwarded, so a transcript (or anything Fathom adds later) cannot
 * ride along by accident.
 */
export function buildWebhookBody(m: ListedMeeting): Record<string, unknown> {
  const r = m.raw;
  const body: Record<string, unknown> = {
    recording_id: Number.isFinite(Number(m.recordingId)) && /^\d+$/.test(m.recordingId) ? Number(m.recordingId) : m.recordingId,
    ...pick(r, [
      "meeting_title", "title", "scheduled_start_time", "scheduled_end_time", "recording_start_time", "recording_end_time",
      "created_at", "url", "share_url", "calendar_invitees_domains_type", "meeting_type",
    ]),
  };
  if (isObj(r.recorded_by)) body.recorded_by = pick(r.recorded_by, ["name", "email", "email_domain", "team"]);
  if (Array.isArray(r.calendar_invitees)) {
    body.calendar_invitees = r.calendar_invitees.filter(isObj).map((i) => pick(i, ["name", "email", "email_domain", "is_external"]));
  }
  if (isObj(r.default_summary)) body.default_summary = pick(r.default_summary, ["template_name", "markdown_formatted"]);
  if (Array.isArray(r.action_items)) {
    body.action_items = r.action_items.filter(isObj).map((a) => {
      const out = pick(a, ["description", "user_generated", "completed", "recording_timestamp", "recording_playback_url"]);
      if (isObj(a.assignee)) out.assignee = pick(a.assignee, ["name", "email", "team"]);
      return out;
    });
  }
  if (r.crm_matches !== undefined && r.crm_matches !== null) body.crm_matches = r.crm_matches;
  if (body.meeting_title === undefined && typeof body.title === "string") body.meeting_title = body.title;
  return body;
}

export type FailCause =
  | "no_fathom_key" | "no_webhook_key" | "bad_since" | "bad_app_address"
  | "fathom_401" | "fathom_403" | "fathom_429" | "fathom_5xx" | "fathom_other" | "fathom_unreachable"
  | "shape_changed" | "app_401" | "app_503" | "app_unreachable" | "posts_failed" | "too_many_pages";

export const CAUSE_SENTENCE: Record<FailCause, string> = {
  no_fathom_key: "FATHOM_API_KEY is not set on the worker, so no call was read. Add the key as a repository secret by that name.",
  no_webhook_key: "FATHOM_WEBHOOK_KEY is not set on the worker, so no call can be sent to the dashboard. Add the dashboard's Fathom webhook secret as a repository secret by that name.",
  bad_since: "The since date is not a real day in the form YYYY-MM-DD, so nothing was read.",
  bad_app_address: "DASHBOARD_URL is not an https address, so nothing was sent.",
  fathom_401: "Fathom refused the key (401). Make a new key in Fathom and replace FATHOM_API_KEY.",
  fathom_403: "Fathom refused access with this key (403). The key's account may not have the API on its plan.",
  fathom_429: "Fathom is limiting requests (429) and kept doing so after several waits. The next run reads again from the same window.",
  fathom_5xx: "Fathom's service failed (a 5xx answer) after several tries. The next run reads again from the same window.",
  fathom_other: "Fathom answered with an error this worker does not know.",
  fathom_unreachable: "Fathom could not be reached.",
  shape_changed: "Fathom's list no longer looks the way this reader expects, so nothing more was read.",
  app_401: "The dashboard refused the webhook key (401). FATHOM_WEBHOOK_KEY must equal the dashboard's FATHOM_SECRET.",
  app_503: "The dashboard's Fathom webhook is not configured (503), so no call was posted.",
  app_unreachable: "The dashboard could not be reached.",
  posts_failed: "Some calls could not be posted to the dashboard. The next run tries them again.",
  too_many_pages: "The list ran past the page limit for one run, so the rest was not read. Narrow the since date.",
};

/** An answer status from Fathom → the cause it ends the run as (or null if it is fine / retryable). */
export function causeForFathomStatus(status: number): FailCause {
  if (status === 401) return "fathom_401";
  if (status === 403) return "fathom_403";
  if (status === 429) return "fathom_429";
  if (status >= 500) return "fathom_5xx";
  return "fathom_other";
}

/** What a one-client run needs to decide "this call is about that client". */
export interface ClientHints { names: string[]; domains: string[] }

const fold = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * A one-client run posts only calls that name the client: an invitee address at the
 * client's own site, or the client's name or an alias inside the title (letters and
 * digits only, whole name). It is a way to test one account, not the dashboard's
 * matcher: the dashboard still decides which client a posted call belongs to.
 */
export function matchesClient(m: ListedMeeting, h: ClientHints): boolean {
  const r = m.raw;
  const invitees = Array.isArray(r.calendar_invitees) ? r.calendar_invitees : [];
  for (const i of invitees) {
    const e = isObj(i) ? (str(i.email) ?? "").toLowerCase() : "";
    const dom = e.includes("@") ? e.split("@")[1]! : "";
    if (dom && h.domains.some((d) => dom === d || dom.endsWith(`.${d}`))) return true;
  }
  const title = fold(str(r.meeting_title) ?? str(r.title) ?? "");
  return Boolean(title) && h.names.some((n) => { const f = fold(n); return f.length >= 3 && title.includes(f); });
}

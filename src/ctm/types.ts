/**
 * CallTrackingMetrics call log: what is asked, what is kept, our own limits.
 *
 * NOTHING HERE HAS BEEN RUN AGAINST CALLTRACKINGMETRICS. No API keys exist to this
 * build. The address, the authentication, the date parameters, the paging fields and
 * every field name in `CTM_FIELDS` are written from CTM's public API reference as I
 * know it; `docs/INTEGRATIONS-SETUP.md` in the dashboard repository lists what is
 * unverified, and the reader parses defensively and says so in its status.
 *
 * WHAT IS NEVER KEPT: the caller's number (only a salted hash), the caller-ID text or
 * name, the recording or any audio link, the transcript, the summary, notes, the message
 * body, keyword spotting, and the visitor's IP. They are not in the allowlist, so they
 * cannot be copied by accident; `buildCall` returns exactly the allowlisted keys.
 */

export const CTM_BASE = "https://api.calltrackingmetrics.com/api/v1";

/** Days read on an ordinary run; a call's status can still change for a while after it, so a re-read overwrites. Ours. */
export const CTM_WINDOW_DAYS = 45;
/** The most a first run (a backfill) may ask for. */
export const CTM_MAX_DAYS = 400;
export const CTM_PER_PAGE = 100;
export const CTM_MAX_PAGES = 60;
export const CTM_PAUSE_MS = 600;
/** Rows are kept this long. */
export const CTM_KEEP_DAYS = 400;
export const CTM_STRING_MAX = 120;

/** The dashboard has the same list (`CTM_STATUSES` in shared/schema.ts); `verify:wiring` compares the two. */
export const CTM_STATUS_VALUES = ["answered", "hangup", "no_answer"] as const;
export type CtmStatus = (typeof CTM_STATUS_VALUES)[number];
export type CtmDirection = "inbound" | "outbound";

/** The only things a stored call can say. Anything else CTM sends is dropped at the door. */
export interface CtmCallRow {
  ctmCallId: string;
  calledAt: string;
  trackingSource: string | null;
  trackingLabel: string | null;
  status: CtmStatus | null;
  talkSeconds: number | null;
  ringSeconds: number | null;
  durationSeconds: number | null;
  direction: CtmDirection | null;
  city: string | null;
  state: string | null;
  gclid: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  device: string | null;
  tagsGoogleAdsConversion: boolean | null;
  tagsRepeat: boolean | null;
  callerHash: string | null;
}
export const CTM_ROW_KEYS = [
  "ctmCallId", "calledAt", "trackingSource", "trackingLabel", "status", "talkSeconds", "ringSeconds", "durationSeconds", "direction", "city", "state",
  "gclid", "utmSource", "utmMedium", "utmCampaign", "device", "tagsGoogleAdsConversion", "tagsRepeat", "callerHash",
] as const satisfies ReadonlyArray<keyof CtmCallRow>;

/**
 * The names a field may arrive under. A key is matched with case, spaces and punctuation
 * ignored, so "Call ID", "call_id" and "callid" are one name. `json` are the probable
 * names in CTM's API answer; `csv` are the probable headings of CTM's own call-log
 * export. BOTH LISTS ARE GUESSES, written from memory of CTM's documentation and its
 * export screen. Each entry says so with `verified: false`; flip it only after a real
 * answer has been seen. A field with no alias present in a record is simply unanswered.
 */
export interface FieldAlias { json: string[]; csv: string[]; verified: boolean }
export const CTM_FIELDS: Record<"id" | "calledAt" | "unixTime" | "trackingSource" | "trackingLabel" | "status" | "talk" | "ring" | "duration" | "direction" | "city" | "state" | "gclid" | "utmSource" | "utmMedium" | "utmCampaign" | "device" | "tags" | "callerNumber", FieldAlias> = {
  id: { json: ["id", "call_id", "sid"], csv: ["Call ID", "ID"], verified: false },
  calledAt: { json: ["called_at", "start_time", "date"], csv: ["Date", "Call Date", "Date/Time", "Start Time"], verified: false },
  unixTime: { json: ["unix_time", "timestamp"], csv: ["Unix Time"], verified: false },
  trackingSource: { json: ["tracking_source", "source"], csv: ["Source", "Tracking Source"], verified: false },
  trackingLabel: { json: ["tracking_label", "tracking_number_label", "number_label"], csv: ["Tracking Label", "Tracking Number Label", "Number Label"], verified: false },
  status: { json: ["call_status", "status"], csv: ["Call Status", "Status"], verified: false },
  talk: { json: ["talk_time", "talk_seconds"], csv: ["Talk Time", "Talk Seconds"], verified: false },
  ring: { json: ["ring_time", "ring_seconds"], csv: ["Ring Time", "Ring Seconds"], verified: false },
  duration: { json: ["duration", "call_duration", "total_duration"], csv: ["Duration", "Call Duration", "Total Duration"], verified: false },
  direction: { json: ["direction", "call_direction"], csv: ["Direction", "Call Direction"], verified: false },
  city: { json: ["city", "caller_city"], csv: ["City", "Caller City"], verified: false },
  state: { json: ["state", "caller_state"], csv: ["State", "Caller State"], verified: false },
  gclid: { json: ["gclid"], csv: ["GCLID", "Google Click ID"], verified: false },
  utmSource: { json: ["utm_source"], csv: ["UTM Source"], verified: false },
  utmMedium: { json: ["utm_medium"], csv: ["UTM Medium"], verified: false },
  utmCampaign: { json: ["utm_campaign"], csv: ["UTM Campaign"], verified: false },
  device: { json: ["device", "device_type"], csv: ["Device", "Device Type"], verified: false },
  tags: { json: ["tag_list", "tags", "call_tags"], csv: ["Tags", "Tag List"], verified: false },
  callerNumber: { json: ["caller_number", "caller_number_bare", "from", "ani"], csv: ["Caller Number", "Caller", "Caller Phone"], verified: false },
};

/** Tag names compared after lower-casing and collapsing spaces. Ours; CTM's own tag text is whatever the account named it. */
export const TAG_GOOGLE_ADS_CONVERSION = /^google ads conversion/;
export const TAG_REPEAT = /^repeat( caller)?$/;

/**
 * Google Ads change history — capture and store.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * The company owner asked whether this system retains enough about what has
 * changed over time that, when a subcontractor makes moves directly in an ad
 * account, it stays intelligent about it and can advise them so they are "not
 * moving out of step with our intelligence layer."
 *
 * It did not. Every record of change in the dashboard covered changes made
 * through its own approve queue — ads_findings.approved_at, ads_finding_events,
 * the prior values the apply path captures, the 14- and 28-day after-checks.
 * A vendor logging into Google Ads and raising a budget by hand was invisible,
 * so the settle-window guard read a campaign somebody moved on Tuesday as quiet
 * on Friday, and the after-check credited us with somebody else's work.
 *
 * ── THE THIRTY-DAY CAP IS THE WHOLE URGENCY ────────────────────────────────
 *
 * `change_event` is capped at 30 days by the API. Older than that is DELETED,
 * not slow to fetch, so every day this is not captured is account history lost
 * for good. That is why this stores rather than reads on demand, and why the
 * job re-reads the WHOLE window every run instead of a delta: re-reading is
 * free because the rows are keyed on the platform's own identity for the event,
 * and it means nothing is lost until every run inside a thirty-day stretch has
 * failed.
 *
 * ── READ-ONLY ──────────────────────────────────────────────────────────────
 *
 * `change_event` is a SELECT. Nothing in this file writes to an ad account,
 * proposes anything or applies anything. The propose/approve split is
 * untouched: this feeds a guard that REFUSES, and refusing is not applying.
 *
 * ── user_email is personal data ────────────────────────────────────────────
 *
 * It is stored because it is the only thing that tells one person working
 * steadily apart from two people working past each other, which is what the
 * cadence sentence is made of. It stays inside the company: the app's vendor
 * brief says "somebody", and nothing here prints an address to a log.
 */
import type pg from "pg";
import { createHash, randomUUID } from "node:crypto";

/** The platform's own cap. Anything older is gone permanently. */
export const CHANGE_LOOKBACK_DAYS = 30;

/**
 * Days per GAQL window.
 *
 * `change_event` requires a LIMIT and caps a single response at 10,000 rows, so
 * a busy account read in one request would silently return a truncated page and
 * we would store a hole without knowing. Eight days per window puts a normal
 * account in the low hundreds and a very busy one well inside the cap; the job
 * reports any window that comes back AT the cap rather than assuming it did not.
 */
export const CHANGE_WINDOW_DAYS = 8;
export const CHANGE_ROW_LIMIT = 10_000;

/**
 * The API returns enums as integers over REST rather than their names, so a
 * `=== "CAMPAIGN_BUDGET"` comparison silently never matches. Same indignity the
 * google-ads-adapter already documents. An integer these maps do not know
 * passes through as its own digits rather than being guessed at.
 */
const RESOURCE_TYPE: Record<string, string> = {
  "2": "AD", "3": "AD_GROUP", "4": "AD_GROUP_CRITERION", "5": "CAMPAIGN", "6": "CAMPAIGN_BUDGET",
  "7": "AD_GROUP_BID_MODIFIER", "8": "CAMPAIGN_CRITERION", "9": "FEED", "10": "FEED_ITEM",
  "11": "CAMPAIGN_FEED", "12": "AD_GROUP_FEED", "13": "AD_GROUP_AD", "14": "ASSET",
  "15": "CUSTOMER_ASSET", "16": "CAMPAIGN_ASSET", "17": "AD_GROUP_ASSET", "18": "ASSET_SET",
  "19": "ASSET_SET_ASSET", "20": "CAMPAIGN_ASSET_SET",
};
const OPERATION: Record<string, string> = { "2": "CREATE", "3": "UPDATE", "4": "REMOVE" };
/** ChangeClientType. 2 is the web interface, 6 is the API — the two that
 *  decide whether a change was a person or a machine. */
const CLIENT_TYPE: Record<string, string> = {
  "1": "UNKNOWN", "2": "GOOGLE_ADS_WEB_CLIENT", "3": "GOOGLE_ADS_AUTOMATED_RULE",
  "4": "GOOGLE_ADS_SCRIPTS", "5": "GOOGLE_ADS_BULK_UPLOAD", "6": "GOOGLE_ADS_API",
  "7": "GOOGLE_ADS_EDITOR", "8": "GOOGLE_ADS_MOBILE_APP", "9": "GOOGLE_ADS_RECOMMENDATIONS",
  "10": "SEARCH_ADS_360_SYNC", "11": "SEARCH_ADS_360_POST", "12": "INTERNAL_TOOL", "13": "OTHER",
  "14": "GOOGLE_ADS_RECOMMENDATIONS_SUBSCRIPTION",
};
const decode = (map: Record<string, string>, v: unknown): string | null => {
  const raw = String(v ?? "").trim();
  if (!raw || raw === "0") return null;
  return map[raw] ?? raw;
};

/** Client types that mean a machine made the change. Everything else is read
 *  as a person; an absent value is read as neither. Mirrors
 *  actorKindFromClientType in the dashboard's shared/ads-change-history.ts —
 *  keep the two in step. */
const API_CLIENT_TYPES = new Set([
  "GOOGLE_ADS_API", "GOOGLE_ADS_BULK_UPLOAD", "GOOGLE_ADS_SCRIPTS", "GOOGLE_ADS_AUTOMATED_RULE",
]);
export function actorKind(clientType: string | null): "person" | "api" | "unknown" {
  if (!clientType || clientType === "UNKNOWN" || clientType === "OTHER") return "unknown";
  return API_CLIENT_TYPES.has(clientType) ? "api" : "person";
}

/** Whose people are ours. Overridable so this does not have to be edited when
 *  a second domain appears. An address at neither is somebody else's; an
 *  ABSENT address is nobody having said, and stays null. */
function internalDomains(): string[] {
  const raw = (process.env.TEAM_EMAIL_DOMAINS ?? "bsllc.biz").trim();
  return raw.split(",").map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
}
export function isInternalAddress(email: string | null): boolean | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const domain = email.slice(at + 1).toLowerCase();
  return internalDomains().some((d) => domain === d || domain.endsWith(`.${d}`));
}

/** Digits at the tail of a resource name — `customers/1/campaigns/222` → 222. */
const tailId = (resourceName: unknown): string | null => {
  const s = String(resourceName ?? "").trim();
  if (!s) return null;
  const last = s.split("/").pop() ?? "";
  return /^\d+$/.test(last) ? last : null;
};

export interface CapturedChange {
  eventKey: string;
  /** True when the key came from the platform's own resource name rather than
   *  from a digest of the event's fields. Reported per run. */
  keyFromPlatform: boolean;
  changedAt: string;
  actorEmail: string | null;
  actorKind: "person" | "api" | "unknown";
  actorInternal: boolean | null;
  clientType: string | null;
  resourceType: string | null;
  operation: string | null;
  changedFields: string | null;
  campaignId: string | null;
  adGroupId: string | null;
  oldResourceJson: string | null;
  newResourceJson: string | null;
}

/**
 * One API row, normalized.
 *
 * THE NATURAL KEY. Google's change_event resource name is
 * `customers/<cid>/changeEvents/<micros>~<command>~<mutate>` — the event's own
 * identity, so re-reading the same thirty days writes nothing. Where the API
 * returns no resource name, the key is a digest of the event's OWN FIELDS,
 * which is still its identity rather than a position in a result set: the same
 * event digests the same way on every run.
 *
 * Returns null for a row carrying no timestamp at all. A change with no date
 * cannot be placed in a settle window, and storing it would put a row in the
 * table that no reading can use.
 */
export function normalizeChangeEvent(row: any): CapturedChange | null {
  const e = row?.change_event ?? row?.changeEvent ?? {};
  const changedAtRaw = String(e.change_date_time ?? e.changeDateTime ?? "").trim();
  if (!changedAtRaw) return null;

  const cf = e.changed_fields?.paths ?? e.changedFields?.paths ?? e.changed_fields ?? e.changedFields ?? [];
  const changedFields = Array.isArray(cf) ? cf.join(",") : (String(cf ?? "").trim() || null);

  const clientType = decode(CLIENT_TYPE, e.client_type ?? e.clientType);
  const actorEmail = (String(e.user_email ?? e.userEmail ?? "").trim() || null);
  const oldResource = e.old_resource ?? e.oldResource ?? null;
  const newResource = e.new_resource ?? e.newResource ?? null;

  const platformKey = String(e.resource_name ?? e.resourceName ?? "").trim();
  const fields: CapturedChange = {
    eventKey: platformKey,
    keyFromPlatform: Boolean(platformKey),
    changedAt: changedAtRaw,
    actorEmail,
    actorKind: actorKind(clientType),
    actorInternal: isInternalAddress(actorEmail),
    clientType,
    resourceType: decode(RESOURCE_TYPE, e.change_resource_type ?? e.changeResourceType),
    operation: decode(OPERATION, e.resource_change_operation ?? e.resourceChangeOperation),
    changedFields: changedFields || null,
    campaignId: tailId(e.campaign),
    adGroupId: tailId(e.ad_group ?? e.adGroup),
    oldResourceJson: oldResource ? JSON.stringify(oldResource) : null,
    newResourceJson: newResource ? JSON.stringify(newResource) : null,
  };
  if (!platformKey) {
    // The digest is over the event's own identity, never over a counter. The
    // email is deliberately hashed in rather than stored in the key, so no key
    // printed in a log carries an address.
    fields.eventKey = "digest:" + createHash("sha256").update([
      fields.changedAt, fields.actorEmail ?? "", fields.clientType ?? "", fields.resourceType ?? "",
      fields.operation ?? "", fields.changedFields ?? "", fields.campaignId ?? "", fields.adGroupId ?? "",
      fields.oldResourceJson ?? "", fields.newResourceJson ?? "",
    ].join("|")).digest("hex").slice(0, 32);
  }
  return fields;
}

/** Inclusive YYYY-MM-DD windows covering the lookback, oldest first. */
export function captureWindows(now: Date, lookbackDays = CHANGE_LOOKBACK_DAYS, windowDays = CHANGE_WINDOW_DAYS): Array<[string, string]> {
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  const out: Array<[string, string]> = [];
  // One day inside the cap on purpose: a request sitting exactly on the
  // boundary is refused by the API for asking beyond it.
  for (let start = lookbackDays - 1; start > 0; start -= windowDays) {
    const from = new Date(now.getTime() - start * 86_400_000);
    const toOffset = Math.max(0, start - windowDays + 1);
    const to = new Date(now.getTime() - toOffset * 86_400_000);
    out.push([ymd(from), ymd(to)]);
  }
  return out;
}

export const CHANGE_GAQL_FIELDS = [
  "change_event.resource_name",
  "change_event.change_date_time",
  "change_event.user_email",
  "change_event.change_resource_type",
  "change_event.resource_change_operation",
  "change_event.changed_fields",
  "change_event.old_resource",
  "change_event.new_resource",
  "change_event.client_type",
  "change_event.campaign",
  "change_event.ad_group",
].join(", ");

export function changeGaql(from: string, to: string, limit = CHANGE_ROW_LIMIT): string {
  return `SELECT ${CHANGE_GAQL_FIELDS}
     FROM change_event
    WHERE change_event.change_date_time >= '${from}'
      AND change_event.change_date_time <= '${to} 23:59:59'
    ORDER BY change_event.change_date_time ASC
    LIMIT ${limit}`;
}

/**
 * Store what was captured.
 *
 * ON CONFLICT DO NOTHING on (platform, account_id, event_key). A change event
 * is immutable once it has happened, so the second read of the same event has
 * nothing new to say, and DO NOTHING means a re-run costs nothing and changes
 * nothing. `inserted` is what the run reports: on an ordinary second run it is
 * nought, and that is the idempotence being demonstrated rather than asserted.
 */
export async function storeChangeEvents(
  c: pg.Client,
  clientId: string,
  platform: string,
  accountId: string,
  events: CapturedChange[],
): Promise<{ inserted: number }> {
  let inserted = 0;
  for (const e of events) {
    const r = await c.query(
      `INSERT INTO ads_change_events (
         id, client_id, platform, account_id, event_key, changed_at, actor_email, actor_kind,
         actor_internal, client_type, resource_type, operation, changed_fields,
         campaign_id, ad_group_id, old_resource_json, new_resource_json, captured_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now())
       ON CONFLICT (platform, account_id, event_key) DO NOTHING`,
      [
        randomUUID(), clientId, platform, accountId, e.eventKey, e.changedAt, e.actorEmail,
        e.actorKind, e.actorInternal, e.clientType, e.resourceType, e.operation, e.changedFields,
        e.campaignId, e.adGroupId, e.oldResourceJson, e.newResourceJson,
      ],
    );
    inserted += r.rowCount ?? 0;
  }
  return { inserted };
}

/**
 * Record what we actually looked at.
 *
 * A NULL IS UNANSWERED. Without this row, no events for a window is
 * indistinguishable from "nothing changed", and the two lead to opposite
 * decisions — one says the campaign is settled, the other says we cannot tell.
 *
 * `covered_from` only moves BACKWARD, and only while coverage is continuous.
 * A previous scan older than the platform's own cap means whatever happened in
 * the gap is deleted and unrecoverable, so coverage restarts at this run's own
 * window rather than claiming a history that no longer exists.
 */
export async function recordScan(
  c: pg.Client,
  clientId: string,
  platform: string,
  accountId: string,
  windowFrom: string,
  windowTo: string,
  note: string,
): Promise<{ coveredFrom: string; restarted: boolean }> {
  const { rows } = await c.query<{ covered_from: string; covered_to: string }>(
    `SELECT covered_from, covered_to FROM ads_change_scans WHERE platform = $1 AND account_id = $2`,
    [platform, accountId],
  );
  const prev = rows[0];
  const gapDays = prev
    ? Math.round((Date.parse(`${windowTo}T00:00:00Z`) - Date.parse(`${prev.covered_to}T00:00:00Z`)) / 86_400_000)
    : null;
  const continuous = prev != null && gapDays != null && gapDays <= CHANGE_LOOKBACK_DAYS;
  const coveredFrom = continuous && prev.covered_from < windowFrom ? prev.covered_from : windowFrom;
  const restarted = prev != null && !continuous;

  await c.query(
    `INSERT INTO ads_change_scans (id, client_id, platform, account_id, covered_from, covered_to, last_scan_at, ok, note)
     VALUES ($1,$2,$3,$4,$5,$6, now(), true, $7)
     ON CONFLICT (platform, account_id) DO UPDATE SET
       client_id = EXCLUDED.client_id,
       covered_from = EXCLUDED.covered_from,
       covered_to = EXCLUDED.covered_to,
       last_scan_at = now(), ok = true, note = EXCLUDED.note`,
    [randomUUID(), clientId, platform, accountId, coveredFrom, windowTo, note],
  );
  return { coveredFrom, restarted };
}

/**
 * Mark an account's scan failed without moving its coverage.
 *
 * The window stays where the last successful run left it, so every reading
 * built on these events keeps telling the truth about how far back it can see
 * while the failure is being fixed.
 */
export async function recordScanFailure(
  c: pg.Client,
  platform: string,
  accountId: string,
  note: string,
): Promise<void> {
  await c.query(
    `UPDATE ads_change_scans SET ok = false, last_scan_at = now(), note = $3
      WHERE platform = $1 AND account_id = $2`,
    [platform, accountId, note.slice(0, 300)],
  );
}

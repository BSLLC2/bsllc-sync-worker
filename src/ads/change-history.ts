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
  /**
   * The resource this event is ABOUT, as the platform names it:
   * `customers/1/campaignBudgets/12345` for a budget change. This is where a
   * budget's id lives; the event's `campaign` field is empty on a budget change
   * and the changed resource's body does not reliably carry its own name, so a
   * budget raise reached the audit as a change nobody could tie to any campaign
   * (2026-10-12). NULL = the event did not say, never "none".
   */
  changeResourceName: string | null;
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
    changeResourceName: (String(e.change_resource_name ?? e.changeResourceName ?? "").trim() || null),
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
  "change_event.change_resource_name",
].join(", ");

/**
 * The digits of the budget an event is about, or null.
 *
 * From the event's own `change_resource_name` first, which is the platform
 * saying what changed. Failing that, any `campaignBudgets/<id>` inside the
 * resource body, which is what the dashboard reads for events captured before
 * the name was kept. Null when neither names one: unanswered, never a guess.
 */
export function budgetIdOfEvent(e: Pick<CapturedChange, "changeResourceName" | "newResourceJson" | "oldResourceJson">): string | null {
  const m = /campaignBudgets\/(\d+)/;
  return m.exec(e.changeResourceName ?? "")?.[1]
    ?? m.exec(e.newResourceJson ?? "")?.[1]
    ?? m.exec(e.oldResourceJson ?? "")?.[1]
    ?? null;
}

/** Which campaigns use each budget: `budget id → campaign ids`. */
export const CAMPAIGN_BUDGET_GAQL = `SELECT campaign.id, campaign.campaign_budget FROM campaign WHERE campaign.status != 'REMOVED'`;
export function budgetCampaignMap(rows: readonly any[] | null | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of rows ?? []) {
    const budget = tailId(r?.campaign?.campaign_budget ?? r?.campaign?.campaignBudget);
    const campaign = r?.campaign?.id != null ? String(r.campaign.id) : null;
    if (!budget || !campaign) continue;
    const list = out.get(budget) ?? [];
    if (!list.includes(campaign)) list.push(campaign);
    out.set(budget, list);
  }
  return out;
}

/**
 * Put a campaign on a budget change that names none.
 *
 * Google's event leaves `campaign` empty on a CAMPAIGN_BUDGET change, so a
 * budget raise on a campaign was invisible to every reading that asks "what
 * changed on this campaign" — the settle window on Approve, the window-against-
 * change sentence, the weekly timeline. When exactly ONE live campaign uses the
 * budget the event is that campaign's and is stamped with it. A budget SHARED by
 * several campaigns is left unstamped, because naming one of them would be a
 * guess; the dashboard matches those on the budget id. Nothing already named is
 * touched. Returns what it did, so the run can say.
 */
export function attachBudgetCampaigns(
  events: CapturedChange[],
  budgets: ReadonlyMap<string, readonly string[]>,
): { resolved: number; shared: number; unresolved: number } {
  let resolved = 0, shared = 0, unresolved = 0;
  for (const e of events) {
    if (e.resourceType !== "CAMPAIGN_BUDGET" || e.campaignId) continue;
    const id = budgetIdOfEvent(e);
    const campaigns = id ? budgets.get(id) : undefined;
    if (campaigns && campaigns.length === 1) { e.campaignId = campaigns[0]!; resolved += 1; }
    else if (campaigns && campaigns.length > 1) shared += 1;
    else unresolved += 1;
  }
  return { resolved, shared, unresolved };
}

/**
 * Read one window, and split it when it comes back full.
 *
 * `change_event` returns at most 10,000 rows and is read OLDEST FIRST, so a full
 * page loses the NEWEST changes — exactly the ones that matter. Before this a
 * full window was only named in the run's output and stored as though it were
 * whole. A window at the cap is now halved by date and each half read again, down
 * to a single day; a single day still at the cap is the one thing that stays
 * reported, and it is returned so the caller can say so.
 */
export async function readChangeWindow(
  read: (from: string, to: string) => Promise<any[] | null | undefined>,
  from: string,
  to: string,
  limit = CHANGE_ROW_LIMIT,
): Promise<{ rows: any[]; capped: string[] }> {
  const rows = (await read(from, to)) ?? [];
  if (!Array.isArray(rows) || rows.length < limit) return { rows: Array.isArray(rows) ? rows : [], capped: [] };
  if (from >= to) return { rows, capped: [`${from}..${to}`] };
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  const midMs = a + Math.floor((b - a) / 2 / 86_400_000) * 86_400_000;
  const mid = new Date(midMs).toISOString().slice(0, 10);
  const next = new Date(midMs + 86_400_000).toISOString().slice(0, 10);
  const left = await readChangeWindow(read, from, mid, limit);
  const right = await readChangeWindow(read, next, to, limit);
  return { rows: [...left.rows, ...right.rows], capped: [...left.capped, ...right.capped] };
}

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
 * Keyed on (platform, account_id, event_key). A change event is immutable once
 * it has happened, so the second read of the same event has nothing new to say
 * EXCEPT the campaign a budget event could not name and the resource name an
 * earlier build did not read; those two are filled in when blank and nothing
 * else is ever rewritten. A re-run costs nothing and changes nothing. `inserted` is what the run reports: on an ordinary second run it is
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
  // The column is the app's (schema v241) but a capture run can land before the
  // app deploys, so the worker provisions it the way every other worker-side
  // addition does. Idempotent.
  await c.query(`ALTER TABLE ads_change_events ADD COLUMN IF NOT EXISTS change_resource_name TEXT`);
  for (const e of events) {
    // An existing row is only ever FILLED, never rewritten: a change event is
    // immutable once it happened, so the one thing a second read may add is the
    // campaign a budget event could not name and the resource name an earlier
    // build did not ask for. `xmax = 0` is true only for a row this statement
    // inserted, so a back-fill is not counted as a new event.
    const r = await c.query<{ inserted: boolean }>(
      `INSERT INTO ads_change_events (
         id, client_id, platform, account_id, event_key, changed_at, actor_email, actor_kind,
         actor_internal, client_type, resource_type, operation, changed_fields,
         campaign_id, ad_group_id, old_resource_json, new_resource_json, change_resource_name, captured_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, now())
       ON CONFLICT (platform, account_id, event_key) DO UPDATE SET
         campaign_id = COALESCE(ads_change_events.campaign_id, EXCLUDED.campaign_id),
         change_resource_name = COALESCE(ads_change_events.change_resource_name, EXCLUDED.change_resource_name)
       WHERE (ads_change_events.campaign_id IS NULL AND EXCLUDED.campaign_id IS NOT NULL)
          OR (ads_change_events.change_resource_name IS NULL AND EXCLUDED.change_resource_name IS NOT NULL)
       RETURNING (xmax = 0) AS inserted`,
      [
        randomUUID(), clientId, platform, accountId, e.eventKey, e.changedAt, e.actorEmail,
        e.actorKind, e.actorInternal, e.clientType, e.resourceType, e.operation, e.changedFields,
        e.campaignId, e.adGroupId, e.oldResourceJson, e.newResourceJson, e.changeResourceName,
      ],
    );
    if (r.rows[0]?.inserted) inserted += 1;
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

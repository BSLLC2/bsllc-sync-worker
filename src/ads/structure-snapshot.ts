/**
 * A STRUCTURAL SNAPSHOT of an ad account: every campaign, ad group, keyword,
 * budget and bid strategy as it stood on a date, so any two dates can be
 * diffed.
 *
 * ── WHY STATE AS WELL AS CHANGES ───────────────────────────────────────────
 *
 * `ads_change_events` (v194) already captures every CHANGE to an account every
 * six hours, a vendor's manual edits included, because Google deletes
 * `change_event` after 30 days. `ads_change_outcomes` (v196) joins a change to
 * what happened after it. Neither is a record of STATE, and a change log
 * cannot become one:
 *
 *   • It says what somebody did. It cannot say what the account looks like
 *     now — that needs every change since the account was opened, and the
 *     platform deleted most of them.
 *   • It cannot survive a gap in capture. Six hours of failed runs inside the
 *     thirty-day cap and the replay is wrong from then on, silently, for good.
 *   • It cannot answer "what was live on 1 September" if the six-hourly job was
 *     down that week. A snapshot taken on 1 September answers it whatever
 *     happened afterwards.
 *   • It cannot be reconciled against itself. A snapshot and a change log that
 *     disagree — a budget at $150 today with no change event moving it there —
 *     is itself a finding, and one neither source can produce alone.
 *
 * ── READ-ONLY ──────────────────────────────────────────────────────────────
 *
 * Every query here is a SELECT. Nothing in this file writes to an ad account,
 * proposes anything or applies anything.
 *
 * ── THE GRAIN ─────────────────────────────────────────────────────────────
 *
 * The first five kinds are the account's skeleton and what this system already
 * reasons about: campaign, ad group, keyword, budget, bid strategy. Keywords
 * cover every level the platform keeps a keyword at AND that this job reads:
 * the positive and NEGATIVE criteria on an ad group (the `negative` attribute
 * says which, so ad-group negatives were always in here), and the negative
 * keyword list on a campaign. Campaign negatives are one of the operations we
 * ourselves write, and a snapshot that cannot diff our own writes is missing
 * the half we are answerable for.
 *
 * SIX MORE KINDS WERE ADDED (2026-11-04), each a separate `entity_kind` so that
 * every reader that asks for `keyword` or `campaign` is byte-for-byte what it
 * was (the dashboard reads `keyword` by its `ag:` / `camp:` id prefix, and a
 * new level under that name would have been read as one of those):
 *
 *   ad                    a responsive search ad: its headlines, descriptions,
 *                         final URLs, display path, labels, strength and
 *                         approval status. REVERSES the earlier decision to
 *                         leave ads out — see below for what that costs.
 *   account_negative      a negative keyword at the ACCOUNT level
 *                         (customer_negative_criterion).
 *   shared_set            a shared negative keyword LIST, and which campaigns it
 *                         is attached to.
 *   shared_negative       one keyword in such a list.
 *   conversion_action     an account's conversion action and how it counts.
 *   campaign_conversion_goal  which conversion goal a campaign optimises
 *                         towards (category + origin, biddable or not).
 *
 * ADS ARE IN NOW, AND THIS IS WHAT THAT CHANGES. The earlier version of this
 * header kept ads out for three reasons, and each is answered rather than
 * dropped. (1) Ad copy is out of our CHANGE scope by policy (OCH runs under
 * LegitScript). It still is: nothing in this file writes an ad, proposes one
 * or applies one, and the dashboard's guarded apply path is unchanged. READING
 * the copy that is live is not changing it, and "what did the ad say on
 * 1 September" is exactly what a before-and-after reading of a copy change
 * needs. (2) A served ad is effectively immutable, so "an ad changed" is a
 * create and a remove that `change_event` already timestamps. True, and a
 * snapshot is how the NEW ad's words are known on the day it appeared. (3) The
 * biggest row by an order of magnitude. It is bounded: an RSA carries at most
 * fifteen headlines of thirty characters and four descriptions of ninety, and
 * the normalizer caps what it keeps (MAX_ASSETS_PER_AD, MAX_ASSET_CHARS) so a
 * malformed response cannot make a row unbounded.
 *
 * WHAT IS STORED OF AN AD, AND WHAT IS NOT. The text of each headline and
 * description (with the position it is pinned to, where it is), the final URLs,
 * the two display-path fragments, label names, the ad strength and the policy
 * approval status. NOT stored: Google's per-asset performance rating (it moves
 * on its own schedule, so keeping it would write a new interval for every ad
 * most days and the table would grow with TIME again), the ad's own name, any
 * tracking template, and anything about who saw it. There is no person's data
 * in an ad; the one thing worth a thought is a final URL carrying a query
 * string, which is kept verbatim because the destination is the point.
 *
 * ── HOW OFTEN: DAILY, AND WHAT THAT COSTS ─────────────────────────────────
 *
 * The grain of the question is a DATE — "what was live on 1 September" — and a
 * date has one answer a day. Running this beside the six-hourly change job
 * would write four readings of one date and answer nothing the change log does
 * not already answer with a timestamp on it.
 *
 * THE COST: a change made and reverted inside one day is invisible here. The
 * change log has it, with the hour, which is precisely the division of labour
 * this design is built on — changes are an event stream, state is a daily
 * reading, and the two reconcile.
 *
 * ── STORAGE: A FULL SNAPSHOT, RECONCILED THROUGH A CONTENT HASH ───────────
 *
 * A row per entity per run is simple and grows with TIME: ~450 entities on an
 * ordinary account here is ~164,000 rows a year, per account, almost all of
 * them byte-identical to the row above.
 *
 * A row only when something changed is small and is a change log again, with
 * every one of the four failures at the top of this file.
 *
 * So: the job reads the WHOLE account every run, and each entity is stored as
 * an INTERVAL — `valid_from`, `valid_to`, with a null `valid_to` meaning still
 * live. A run that finds an entity unchanged writes no new row and only moves
 * `last_seen_on`. A run that finds it changed closes the open interval and
 * opens a new one. So the snapshot is complete on every date it covers, and
 * the table grows with CHANGES rather than with time.
 *
 * WHAT IT COSTS, APPROXIMATELY, and it is approximate because there is no
 * production database in this sandbox and none of it was measured against one:
 * an account with ~8 campaigns, ~25 ad groups, ~400 keywords, ~8 budgets and
 * ~5 bid strategies is ~450 entities. The first run writes ~450 rows. After
 * that, if 5% of entities change in a month, it writes ~23 rows a month —
 * about 700 rows in year one and ~280 a year after it. Five accounts is under
 * 5,000 rows a year. `npm run db:report -- --report=ads-structure-volume` in
 * the dashboard is what would settle the real figure.
 *
 * ── RETENTION: NOTHING IS PRUNED, AND THAT IS A DECISION ──────────────────
 *
 * Google keeps `change_event` for 30 days. These rows are kept INDEFINITELY,
 * for two reasons. They are the only record of an account's structure that
 * survives the platform's own deletion, so pruning them deletes the thing the
 * table exists for. And a closed interval is ONE row however long it stood, so
 * five years of a stable account costs about what one year costs — the volume
 * is a function of how much the account changes, not of how long we keep it.
 *
 * The one thing that would make this wrong is named so nobody has to work it
 * out later: if the cadence ever goes sub-daily on a large account, or an
 * attribute that moves on its own schedule is added to an entity's attrs (the
 * reason an ad's per-asset performance rating is NOT stored), rows start
 * growing with TIME again and this decision has to be taken a second time.
 *
 * ── ENUMS ARE INTEGERS, AND MONEY IS MICROS ───────────────────────────────
 *
 * The REST transport returns enums as integers, and storing one verbatim has
 * already shipped here once: `advertising_channel_type` was kept as "2" and
 * printed as "a 2 campaign", which also switched a coverage check off on every
 * Search campaign in the book, silently. Every enum below goes through
 * `snapshotEnum`, and an integer no map knows is stored as UNRECOGNISED and
 * NAMED in the run output rather than kept as its digits.
 *
 * Money is MICROS, 1,000,000 to the dollar, exactly as the platform returns
 * it. Every attribute key ending `_micros` in `attrs_json` is micros; the
 * column comment in the dashboard's `shared/schema.ts` says so, because a
 * reader guessing a unit off a column name is how a cost per conversion of
 * millions of dollars reached a client's screen.
 */
import type pg from "pg";
import { createHash, randomUUID } from "node:crypto";

/** The kinds this snapshot covers. The first five are the skeleton; the rest were added 2026-11-04 (see the header). */
export const ENTITY_KINDS = [
  "campaign", "ad_group", "keyword", "budget", "bid_strategy",
  "ad", "account_negative", "shared_set", "shared_negative", "conversion_action", "campaign_conversion_goal",
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

/**
 * What an enum integer this build does not recognise is stored as.
 *
 * NOT the word "UNKNOWN", and the difference matters: Google's own enums carry
 * an UNKNOWN member (1) meaning THE PLATFORM does not know. Storing both as
 * one string would collapse "the platform said it could not tell us" into "we
 * could not decode what it told us", which are different facts with different
 * fixes. Every occurrence is also named in the run output with its field and
 * the raw value, so a new platform enum surfaces as a line somebody reads
 * rather than as a value nobody notices.
 */
export const UNRECOGNISED_ENUM = "UNRECOGNISED";

/**
 * The ceiling above which this job stops claiming to have read a kind in full.
 *
 * The client library pages a GAQL search on its own, so a response at this
 * size is more likely a very large account than a truncated page — and that is
 * the point. The job cannot tell the two apart from the response, so it takes
 * the safe reading: a kind at the ceiling is one whose list has not been
 * verified, and an unverified list must never CLOSE the entities missing from
 * it. Closing on a partial list would report most of a live account as removed
 * on one morning, and the interval table would then answer "what was live on
 * that date" with a lie that survives every later run.
 *
 * So reconciliation refuses to close anything for that kind, the run names it,
 * and somebody raises this number having read the line.
 */
export const MAX_ENTITIES_PER_KIND = 20_000;

// ── The enums ────────────────────────────────────────────────────────────────
// Only the ones this snapshot stores. Each is the platform's own numbering.
export const CAMPAIGN_STATUS: Record<string, string> = {
  "0": "UNSPECIFIED", "1": "UNKNOWN", "2": "ENABLED", "3": "PAUSED", "4": "REMOVED",
};
export const AD_GROUP_STATUS: Record<string, string> = {
  "0": "UNSPECIFIED", "1": "UNKNOWN", "2": "ENABLED", "3": "PAUSED", "4": "REMOVED",
};
export const AD_GROUP_TYPE: Record<string, string> = {
  "0": "UNSPECIFIED", "1": "UNKNOWN", "2": "SEARCH_STANDARD", "3": "DISPLAY_STANDARD",
  "4": "SHOPPING_PRODUCT_ADS", "6": "HOTEL_ADS", "7": "SHOPPING_SMART_ADS",
  "8": "VIDEO_BUMPER", "9": "VIDEO_TRUE_VIEW_IN_STREAM", "10": "VIDEO_TRUE_VIEW_IN_DISPLAY",
  "11": "VIDEO_NON_SKIPPABLE_IN_STREAM", "12": "VIDEO_OUTSTREAM", "13": "SEARCH_DYNAMIC_ADS",
  "14": "SHOPPING_COMPARISON_LISTING_ADS", "15": "PROMOTED_HOTEL_ADS",
  "16": "VIDEO_RESPONSIVE", "17": "VIDEO_EFFICIENT_REACH", "18": "SMART_CAMPAIGN_ADS",
  "19": "TRAVEL_ADS",
};
export const CRITERION_STATUS: Record<string, string> = {
  "0": "UNSPECIFIED", "1": "UNKNOWN", "2": "ENABLED", "3": "PAUSED", "4": "REMOVED",
};
/** Shared with the adapter's own map, repeated rather than imported: this
 *  module is pure and the adapter opens a Google client at import time. */
export const KEYWORD_MATCH_TYPE: Record<string, string> = {
  "0": "UNSPECIFIED", "1": "UNKNOWN", "2": "EXACT", "3": "PHRASE", "4": "BROAD",
};
export const BUDGET_DELIVERY_METHOD: Record<string, string> = {
  "0": "UNSPECIFIED", "1": "UNKNOWN", "2": "STANDARD", "3": "ACCELERATED",
};
export const BUDGET_PERIOD: Record<string, string> = {
  "0": "UNSPECIFIED", "1": "UNKNOWN", "2": "DAILY", "3": "CUSTOM_PERIOD", "4": "FIXED_DAILY",
};
export const BUDGET_STATUS: Record<string, string> = {
  "0": "UNSPECIFIED", "1": "UNKNOWN", "2": "ENABLED", "3": "REMOVED",
};
export const BIDDING_STRATEGY_STATUS: Record<string, string> = {
  "0": "UNSPECIFIED", "1": "UNKNOWN", "2": "ENABLED", "4": "REMOVED",
};
/** The strategy itself. Kept in step with the adapter's BIDDING_STRATEGY_TYPE;
 *  a value in one and not the other shows up as UNRECOGNISED and is named. */
export const BID_STRATEGY_TYPE: Record<string, string> = {
  "0": "UNSPECIFIED", "1": "UNKNOWN", "2": "ENHANCED_CPC", "3": "MANUAL_CPC", "4": "MANUAL_CPM",
  "5": "PAGE_ONE_PROMOTED", "6": "TARGET_CPA", "7": "TARGET_OUTRANK_SHARE", "8": "TARGET_ROAS",
  "9": "TARGET_SPEND", "10": "MAXIMIZE_CONVERSIONS", "11": "MAXIMIZE_CONVERSION_VALUE",
  "12": "PERCENT_CPC", "13": "MANUAL_CPV", "14": "TARGET_CPM", "15": "TARGET_IMPRESSION_SHARE",
  "16": "COMMISSION", "17": "INVALID", "18": "MANUAL_CPA", "19": "FIXED_CPM",
  "20": "TARGET_CPV", "21": "TARGET_CPC", "22": "FIXED_SHARE_OF_VOICE",
};
export const ADVERTISING_CHANNEL_TYPE: Record<string, string> = {
  "0": "UNSPECIFIED", "1": "UNKNOWN", "2": "SEARCH", "3": "DISPLAY", "4": "SHOPPING",
  "5": "HOTEL", "6": "VIDEO", "7": "MULTI_CHANNEL", "8": "LOCAL", "9": "SMART",
  "10": "PERFORMANCE_MAX", "11": "LOCAL_SERVICES", "12": "DISCOVERY", "13": "TRAVEL",
  "14": "DEMAND_GEN",
};

/** One enum integer this build could not decode, for the run output. */
export interface UnrecognisedEnum {
  /** The field it arrived on — `campaign.status`, never a bare name. */
  field: string;
  /** What the platform sent, verbatim. Never a customer id or an address. */
  raw: string;
}

/**
 * Decode one enum, or say so.
 *
 * A value already in Google's own words passes through untouched, so this is
 * safe whichever shape a future client library returns. NULL IN IS NULL OUT —
 * an absent field is unanswered, never a nought and never UNRECOGNISED.
 */
export function snapshotEnum(
  map: Record<string, string>,
  value: unknown,
  field: string,
  report?: UnrecognisedEnum[],
): string | null {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (map[raw]) return map[raw];
  const upper = raw.toUpperCase();
  if (Object.values(map).includes(upper)) return upper;
  report?.push({ field, raw });
  return UNRECOGNISED_ENUM;
}

// ── What a snapshot row is ───────────────────────────────────────────────────
/**
 * One entity as it stands right now.
 *
 * `attrs` holds everything the hash is taken over beyond the four first-class
 * fields. Every key ending `_micros` is MICROS, verbatim from the platform.
 */
export interface SnapshotEntity {
  kind: EntityKind;
  /**
   * Stable identity. A platform id where one exists; otherwise a natural key
   * scoped to its parent, because an ad group criterion id and a campaign
   * criterion id can collide and a keyword has to land on the same row next
   * week or the interval is meaningless.
   */
  entityId: string;
  /** The campaign or ad group this hangs off, where it hangs off one. */
  parentId: string | null;
  /** Denormalised so "everything in this campaign on this date" is one query. */
  campaignId: string | null;
  name: string | null;
  /** The decoded status. Null where the platform reported none. */
  status: string | null;
  attrs: Record<string, string | number | boolean | null>;
}

/** An open interval already in the table, as reconciliation needs it. */
export interface OpenInterval {
  id: string;
  kind: EntityKind;
  entityId: string;
  contentHash: string;
  /** YYYY-MM-DD. */
  validFrom: string;
  /** YYYY-MM-DD. The last date a run confirmed this row. */
  lastSeenOn: string;
}

/**
 * A stable fingerprint of one entity's settings.
 *
 * Over the decoded values rather than the raw payload, so a client library
 * that starts returning enum NAMES instead of integers does not rewrite every
 * interval in the table on one morning. Keys are sorted, so key order in the
 * API response cannot move the hash either.
 */
export function entityHash(e: SnapshotEntity): string {
  const parts = [
    e.kind, e.entityId, e.parentId ?? "", e.campaignId ?? "", e.name ?? "", e.status ?? "",
    ...Object.keys(e.attrs).sort().map((k) => `${k}=${e.attrs[k] ?? ""}`),
  ];
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32);
}

// ── Reconciling a reading against what is stored ─────────────────────────────
export interface ReconcilePlan {
  /** New intervals to open, each with the hash already computed. */
  opens: { entity: SnapshotEntity; hash: string }[];
  /** Intervals to close, with the date they were last confirmed live. */
  closes: { id: string; kind: EntityKind; entityId: string; validTo: string }[];
  /** Intervals whose settings did not move: only `last_seen_on` advances. */
  touches: { id: string }[];
  /**
   * An interval opened EARLIER TODAY that this reading replaces in place.
   *
   * The grain is a date, so a second run on one date is the same snapshot
   * taken again rather than a second snapshot. Closing the earlier row would
   * need a `valid_to` before its own `valid_from`, which is not an interval.
   */
  replaces: { id: string; entity: SnapshotEntity; hash: string }[];
  /** Kinds that were NOT read in full, so nothing of theirs may be closed. */
  incompleteKinds: EntityKind[];
}

/**
 * Pure. What is stored, what was read, one date — one plan.
 *
 * ── A KIND THIS RUN COULD NOT READ IN FULL CLOSES NOTHING ────────────────
 *
 * `completeKinds` is the whole safety of this function. A query that failed, or
 * one that came back at the row ceiling, gives a list this run cannot say it read in full — and an entity
 * missing from a partial list is missing from the LIST, never from the
 * account. Closing on that would mark most of a live account removed on one
 * morning, and the interval table would then answer "what was live on that
 * date" with a lie that survives every later run.
 *
 * ── A CLOSED INTERVAL ENDS ON THE DATE IT WAS LAST SEEN, NOT YESTERDAY ────
 *
 * With the job running daily those are the same date and the timeline is
 * contiguous. After an outage they are not, and the honest statement is the
 * one the data supports: it was live on the date we last confirmed it and gone
 * on this one. The days between are covered by no row, which is a gap a reader
 * can see — better than a date we invented.
 */
export function reconcile(opts: {
  open: OpenInterval[];
  read: SnapshotEntity[];
  /** YYYY-MM-DD this snapshot is for. */
  on: string;
  /** Kinds this run read in full. Only these may close anything. */
  completeKinds: EntityKind[];
}): ReconcilePlan {
  const complete = new Set<EntityKind>(opts.completeKinds);
  const key = (kind: string, id: string) => `${kind}\u0000${id}`;
  const openByKey = new Map(opts.open.map((o) => [key(o.kind, o.entityId), o]));
  const seen = new Set<string>();

  const plan: ReconcilePlan = {
    opens: [], closes: [], touches: [], replaces: [],
    incompleteKinds: ENTITY_KINDS.filter((k) => !complete.has(k)),
  };

  for (const e of opts.read) {
    const k = key(e.kind, e.entityId);
    seen.add(k);
    const hash = entityHash(e);
    const prev = openByKey.get(k);
    if (!prev) { plan.opens.push({ entity: e, hash }); continue; }
    if (prev.contentHash === hash) { plan.touches.push({ id: prev.id }); continue; }
    if (prev.validFrom === opts.on) { plan.replaces.push({ id: prev.id, entity: e, hash }); continue; }
    plan.closes.push({ id: prev.id, kind: prev.kind, entityId: prev.entityId, validTo: prev.lastSeenOn });
    plan.opens.push({ entity: e, hash });
  }

  for (const o of opts.open) {
    if (seen.has(key(o.kind, o.entityId))) continue;
    if (!complete.has(o.kind)) continue;
    plan.closes.push({ id: o.id, kind: o.kind, entityId: o.entityId, validTo: o.lastSeenOn });
  }
  return plan;
}

// ── What the run says ────────────────────────────────────────────────────────
export interface AccountSnapshotCounts {
  read: number;
  opened: number;
  changed: number;
  closed: number;
  unchanged: number;
}

export function planCounts(plan: ReconcilePlan): AccountSnapshotCounts {
  // A CHANGE is a close paired with an open on the same entity, plus a
  // same-date replacement. Counting the two halves separately would report one
  // edited keyword as one new keyword and one removed one, which reads as
  // churn nobody did.
  const closedKeys = new Set(plan.closes.map((c) => `${c.kind}\u0000${c.entityId}`));
  const paired = plan.opens.filter((o) => closedKeys.has(`${o.entity.kind}\u0000${o.entity.entityId}`)).length;
  return {
    read: plan.opens.length + plan.touches.length + plan.replaces.length,
    opened: plan.opens.length - paired,
    changed: paired + plan.replaces.length,
    closed: plan.closes.length - paired,
    unchanged: plan.touches.length,
  };
}

/**
 * One line a person can act on.
 *
 * NO ACCOUNT NUMBER. A run's output names the client, never the ad account it
 * belongs to — an account id in a log is a credential-adjacent identifier with
 * no reason to be there.
 */
export function accountLine(clientName: string, c: AccountSnapshotCounts, notes: string[]): string {
  const bits = [
    `${c.read} entit${c.read === 1 ? "y" : "ies"}`,
    `${c.changed} changed`,
    `${c.opened} new`,
    `${c.closed} gone`,
  ];
  return `  ${clientName}: ${bits.join(" · ")}${notes.length ? ` · ${notes.join(" · ")}` : ""}`;
}

/** The sentence a run with nothing to compare against should say. */
export const FIRST_SNAPSHOT_NOTE =
  "first snapshot for this account — everything reads as new, and the next run is the first that can diff";

/** The sentence a run that read no account at all should say. */
export const NO_ACCOUNTS_NOTE =
  "no mapped ad account to read — an empty structure table says nothing about anyone's account";

// ── GAQL ─────────────────────────────────────────────────────────────────────
// Every one of these is a SELECT. REMOVED rows are left out: a removed entity
// is one the account no longer holds, and reconciliation closes its interval
// on the date it was last seen, which is the same statement in the right place.

export const CAMPAIGN_GAQL = `
  SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
         campaign.bidding_strategy_type, campaign.bidding_strategy,
         campaign.start_date, campaign.end_date,
         campaign.target_cpa.target_cpa_micros, campaign.target_roas.target_roas,
         campaign.maximize_conversions.target_cpa_micros,
         campaign.maximize_conversion_value.target_roas,
         campaign_budget.id, campaign_budget.amount_micros
    FROM campaign
   WHERE campaign.status != 'REMOVED'`;

export const AD_GROUP_GAQL = `
  SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.type,
         ad_group.cpc_bid_micros, ad_group.target_cpa_micros, campaign.id
    FROM ad_group
   WHERE ad_group.status != 'REMOVED' AND campaign.status != 'REMOVED'`;

export const AD_GROUP_KEYWORD_GAQL = `
  SELECT ad_group_criterion.criterion_id, ad_group_criterion.keyword.text,
         ad_group_criterion.keyword.match_type, ad_group_criterion.status,
         ad_group_criterion.negative, ad_group_criterion.cpc_bid_micros,
         ad_group.id, campaign.id
    FROM ad_group_criterion
   WHERE ad_group_criterion.type = 'KEYWORD'
     AND ad_group_criterion.status != 'REMOVED'
     AND ad_group.status != 'REMOVED' AND campaign.status != 'REMOVED'`;

export const CAMPAIGN_KEYWORD_GAQL = `
  SELECT campaign_criterion.criterion_id, campaign_criterion.keyword.text,
         campaign_criterion.keyword.match_type, campaign_criterion.status,
         campaign_criterion.negative, campaign.id
    FROM campaign_criterion
   WHERE campaign_criterion.type = 'KEYWORD'
     AND campaign_criterion.status != 'REMOVED'
     AND campaign.status != 'REMOVED'`;

export const BUDGET_GAQL = `
  SELECT campaign_budget.id, campaign_budget.name, campaign_budget.amount_micros,
         campaign_budget.delivery_method, campaign_budget.period,
         campaign_budget.explicitly_shared, campaign_budget.status
    FROM campaign_budget
   WHERE campaign_budget.status != 'REMOVED'`;

export const BID_STRATEGY_GAQL = `
  SELECT bidding_strategy.id, bidding_strategy.name, bidding_strategy.type,
         bidding_strategy.status,
         bidding_strategy.target_cpa.target_cpa_micros,
         bidding_strategy.target_roas.target_roas,
         bidding_strategy.maximize_conversions.target_cpa_micros,
         bidding_strategy.maximize_conversion_value.target_roas
    FROM bidding_strategy
   WHERE bidding_strategy.status != 'REMOVED'`;

// ── Normalizers ──────────────────────────────────────────────────────────────
const str = (v: unknown): string | null => {
  const s = String(v ?? "").trim();
  return s ? s : null;
};
/** A money field, verbatim in MICROS. Absent stays null — a budget nobody
 *  reported is not a budget of nought. */
const micros = (v: unknown): number | null => (v == null || v === "" ? null : Number(v));
/** The digits at the tail of a resource name. */
const tailId = (v: unknown): string | null => {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const last = s.split("/").pop() ?? "";
  return /^\d+$/.test(last) ? last : null;
};

export function normalizeCampaign(row: any, report?: UnrecognisedEnum[]): SnapshotEntity | null {
  const c = row?.campaign ?? {};
  const id = str(c.id);
  if (!id) return null;
  return {
    kind: "campaign",
    entityId: id,
    parentId: null,
    campaignId: id,
    name: str(c.name),
    status: snapshotEnum(CAMPAIGN_STATUS, c.status, "campaign.status", report),
    attrs: {
      channel_type: snapshotEnum(ADVERTISING_CHANNEL_TYPE, c.advertising_channel_type, "campaign.advertising_channel_type", report),
      bid_strategy_type: snapshotEnum(BID_STRATEGY_TYPE, c.bidding_strategy_type, "campaign.bidding_strategy_type", report),
      /** The PORTFOLIO strategy this campaign is on, where it is on one. */
      portfolio_strategy_id: tailId(c.bidding_strategy),
      start_date: str(c.start_date),
      end_date: str(c.end_date),
      target_cpa_micros: micros(c.target_cpa?.target_cpa_micros),
      maximize_conversions_target_cpa_micros: micros(c.maximize_conversions?.target_cpa_micros),
      target_roas: micros(c.target_roas?.target_roas),
      maximize_conversion_value_target_roas: micros(c.maximize_conversion_value?.target_roas),
      budget_id: str(row?.campaign_budget?.id),
      budget_amount_micros: micros(row?.campaign_budget?.amount_micros),
    },
  };
}

export function normalizeAdGroup(row: any, report?: UnrecognisedEnum[]): SnapshotEntity | null {
  const g = row?.ad_group ?? {};
  const id = str(g.id);
  if (!id) return null;
  const campaignId = str(row?.campaign?.id);
  return {
    kind: "ad_group",
    entityId: id,
    parentId: campaignId,
    campaignId,
    name: str(g.name),
    status: snapshotEnum(AD_GROUP_STATUS, g.status, "ad_group.status", report),
    attrs: {
      ad_group_type: snapshotEnum(AD_GROUP_TYPE, g.type, "ad_group.type", report),
      cpc_bid_micros: micros(g.cpc_bid_micros),
      target_cpa_micros: micros(g.target_cpa_micros),
    },
  };
}

/**
 * A keyword on an ad group, or a negative on a campaign.
 *
 * ONE KIND, TWO PARENTS, and the entity id says which. Criterion ids are
 * unique within their parent and not across parents, so a bare id would let an
 * ad group criterion and a campaign criterion share an interval — which is the
 * one thing an interval table must never do.
 */
export function normalizeAdGroupKeyword(row: any, report?: UnrecognisedEnum[]): SnapshotEntity | null {
  const k = row?.ad_group_criterion ?? {};
  const criterionId = str(k.criterion_id);
  const adGroupId = str(row?.ad_group?.id);
  if (!criterionId || !adGroupId) return null;
  return {
    kind: "keyword",
    entityId: `ag:${adGroupId}:${criterionId}`,
    parentId: adGroupId,
    campaignId: str(row?.campaign?.id),
    name: str(k.keyword?.text),
    status: snapshotEnum(CRITERION_STATUS, k.status, "ad_group_criterion.status", report),
    attrs: {
      match_type: snapshotEnum(KEYWORD_MATCH_TYPE, k.keyword?.match_type, "ad_group_criterion.keyword.match_type", report),
      negative: k.negative == null ? null : Boolean(k.negative),
      level: "ad_group",
      cpc_bid_micros: micros(k.cpc_bid_micros),
    },
  };
}

export function normalizeCampaignKeyword(row: any, report?: UnrecognisedEnum[]): SnapshotEntity | null {
  const k = row?.campaign_criterion ?? {};
  const criterionId = str(k.criterion_id);
  const campaignId = str(row?.campaign?.id);
  if (!criterionId || !campaignId) return null;
  return {
    kind: "keyword",
    entityId: `camp:${campaignId}:${criterionId}`,
    parentId: campaignId,
    campaignId,
    name: str(k.keyword?.text),
    status: snapshotEnum(CRITERION_STATUS, k.status, "campaign_criterion.status", report),
    attrs: {
      match_type: snapshotEnum(KEYWORD_MATCH_TYPE, k.keyword?.match_type, "campaign_criterion.keyword.match_type", report),
      negative: k.negative == null ? null : Boolean(k.negative),
      level: "campaign",
      cpc_bid_micros: null,
    },
  };
}

export function normalizeBudget(row: any, report?: UnrecognisedEnum[]): SnapshotEntity | null {
  const b = row?.campaign_budget ?? {};
  const id = str(b.id);
  if (!id) return null;
  return {
    kind: "budget",
    entityId: id,
    parentId: null,
    campaignId: null,
    name: str(b.name),
    status: snapshotEnum(BUDGET_STATUS, b.status, "campaign_budget.status", report),
    attrs: {
      amount_micros: micros(b.amount_micros),
      delivery_method: snapshotEnum(BUDGET_DELIVERY_METHOD, b.delivery_method, "campaign_budget.delivery_method", report),
      period: snapshotEnum(BUDGET_PERIOD, b.period, "campaign_budget.period", report),
      explicitly_shared: b.explicitly_shared == null ? null : Boolean(b.explicitly_shared),
    },
  };
}

export function normalizeBidStrategy(row: any, report?: UnrecognisedEnum[]): SnapshotEntity | null {
  const s = row?.bidding_strategy ?? {};
  const id = str(s.id);
  if (!id) return null;
  return {
    kind: "bid_strategy",
    entityId: id,
    parentId: null,
    campaignId: null,
    name: str(s.name),
    status: snapshotEnum(BIDDING_STRATEGY_STATUS, s.status, "bidding_strategy.status", report),
    attrs: {
      strategy_type: snapshotEnum(BID_STRATEGY_TYPE, s.type, "bidding_strategy.type", report),
      target_cpa_micros: micros(s.target_cpa?.target_cpa_micros),
      maximize_conversions_target_cpa_micros: micros(s.maximize_conversions?.target_cpa_micros),
      target_roas: micros(s.target_roas?.target_roas),
      maximize_conversion_value_target_roas: micros(s.maximize_conversion_value?.target_roas),
    },
  };
}

// ── The newer kinds: ads, account negatives, shared lists, conversions ──────
export const AD_GROUP_AD_STATUS: Record<string, string> = {
  "0": "UNSPECIFIED", "1": "UNKNOWN", "2": "ENABLED", "3": "PAUSED", "4": "REMOVED",
};
export const SHARED_SET_STATUS: Record<string, string> = {
  "0": "UNSPECIFIED", "1": "UNKNOWN", "2": "ENABLED", "3": "REMOVED",
};
export const CONVERSION_ACTION_STATUS: Record<string, string> = {
  "0": "UNSPECIFIED", "1": "UNKNOWN", "2": "ENABLED", "3": "REMOVED", "4": "HIDDEN",
};
export const CONVERSION_ACTION_TYPE: Record<string, string> = {
  "0": "UNSPECIFIED", "1": "UNKNOWN", "2": "AD_CALL", "3": "CLICK_TO_CALL", "4": "GOOGLE_PLAY_DOWNLOAD",
  "5": "GOOGLE_PLAY_IN_APP_PURCHASE", "6": "UPLOAD_CALLS", "7": "UPLOAD_CLICKS", "8": "WEBPAGE",
  "9": "WEBSITE_CALL", "10": "STORE_SALES_DIRECT_UPLOAD", "11": "STORE_SALES", "12": "FIREBASE_ANDROID_FIRST_OPEN",
  "13": "FIREBASE_ANDROID_IN_APP_PURCHASE", "14": "FIREBASE_ANDROID_CUSTOM", "15": "FIREBASE_IOS_FIRST_OPEN",
  "16": "FIREBASE_IOS_IN_APP_PURCHASE", "17": "FIREBASE_IOS_CUSTOM", "18": "THIRD_PARTY_APP_ANALYTICS_ANDROID_FIRST_OPEN",
  "19": "THIRD_PARTY_APP_ANALYTICS_ANDROID_IN_APP_PURCHASE", "20": "THIRD_PARTY_APP_ANALYTICS_ANDROID_CUSTOM",
  "21": "THIRD_PARTY_APP_ANALYTICS_IOS_FIRST_OPEN", "22": "THIRD_PARTY_APP_ANALYTICS_IOS_IN_APP_PURCHASE",
  "23": "THIRD_PARTY_APP_ANALYTICS_IOS_CUSTOM", "24": "ANDROID_APP_PRE_REGISTRATION", "25": "ANDROID_INSTALLS_ALL_OTHER_APPS",
  "26": "FLOODLIGHT_ACTION", "27": "FLOODLIGHT_TRANSACTION", "28": "GOOGLE_HOSTED", "29": "LEAD_FORM_SUBMIT",
  "30": "SALESFORCE", "31": "SEARCH_ADS_360", "32": "SMART_CAMPAIGN_AD_CLICKS_TO_CALL", "33": "SMART_CAMPAIGN_MAP_CLICKS_TO_CALL",
  "34": "SMART_CAMPAIGN_MAP_DIRECTIONS", "35": "SMART_CAMPAIGN_TRACKED_CALLS", "36": "STORE_VISITS", "37": "WEBPAGE_CODELESS",
  "38": "UNIVERSAL_ANALYTICS_GOAL", "39": "UNIVERSAL_ANALYTICS_TRANSACTION", "40": "GOOGLE_ANALYTICS_4_CUSTOM",
  "41": "GOOGLE_ANALYTICS_4_PURCHASE",
};
export const CONVERSION_ORIGIN: Record<string, string> = {
  "0": "UNSPECIFIED", "1": "UNKNOWN", "2": "WEBSITE", "3": "GOOGLE_HOSTED", "4": "APP", "5": "CALL_FROM_ADS", "6": "STORE", "7": "YOUTUBE_HOSTED",
};
export const CONVERSION_GOAL_CATEGORY: Record<string, string> = {
  "0": "UNSPECIFIED", "1": "UNKNOWN", "2": "DEFAULT", "3": "PAGE_VIEW", "4": "PURCHASE", "5": "SIGNUP", "6": "LEAD",
  "7": "DOWNLOAD", "8": "ADD_TO_CART", "9": "BEGIN_CHECKOUT", "10": "SUBSCRIBE_PAID", "11": "PHONE_CALL_LEAD",
  "12": "IMPORTED_LEAD", "13": "SUBMIT_LEAD_FORM", "14": "BOOK_APPOINTMENT", "15": "REQUEST_QUOTE", "16": "GET_DIRECTIONS",
  "17": "OUTBOUND_CLICK", "18": "CONTACT", "19": "ENGAGEMENT", "20": "STORE_VISIT", "21": "STORE_SALE",
  "22": "QUALIFIED_LEAD", "23": "CONVERTED_LEAD",
};

/** A responsive search ad carries up to 15 headlines and 4 descriptions. */
export const MAX_ASSETS_PER_AD = 15;
/** An asset is 30 or 90 characters on the platform; this is the safety ceiling
 *  on what is kept, not a rule about ad copy. */
export const MAX_ASSET_CHARS = 120;

/**
 * Ads: RESPONSIVE SEARCH ADS ONLY, and only the wording the account holds.
 * Per-asset performance ratings are not selected: they change as Google
 * re-rates and would open a new interval every week for no change anybody made.
 * No tracking template, no URL parameters, no customer data.
 */
export const AD_GAQL = `
  SELECT ad_group_ad.ad.id, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines,
         ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.ad.responsive_search_ad.path1,
         ad_group_ad.ad.responsive_search_ad.path2, ad_group_ad.status, ad_group.id, campaign.id
    FROM ad_group_ad
   WHERE ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD' AND ad_group_ad.status != 'REMOVED'`;

/** Labels on those ads. A label is a word the account manager typed; its text is
 *  kept. If this query fails the ad kind is dropped for the run (see assembleAds). */
export const AD_LABEL_GAQL = `
  SELECT ad_group_ad.resource_name, label.name
    FROM ad_group_ad_label
   WHERE ad_group_ad.status != 'REMOVED'`;

/** Negatives set on the account as a whole. */
export const ACCOUNT_NEGATIVE_GAQL = `
  SELECT customer_negative_criterion.id, customer_negative_criterion.type,
         customer_negative_criterion.keyword.text, customer_negative_criterion.keyword.match_type
    FROM customer_negative_criterion
   WHERE customer_negative_criterion.type = 'KEYWORD'`;

export const SHARED_SET_GAQL = `
  SELECT shared_set.id, shared_set.name, shared_set.type, shared_set.status
    FROM shared_set
   WHERE shared_set.type = 'NEGATIVE_KEYWORDS' AND shared_set.status != 'REMOVED'`;

export const CAMPAIGN_SHARED_SET_GAQL = `
  SELECT campaign.id, shared_set.id
    FROM campaign_shared_set
   WHERE shared_set.type = 'NEGATIVE_KEYWORDS' AND campaign_shared_set.status = 'ENABLED'`;

export const SHARED_CRITERION_GAQL = `
  SELECT shared_set.id, shared_criterion.criterion_id, shared_criterion.keyword.text,
         shared_criterion.keyword.match_type
    FROM shared_criterion
   WHERE shared_set.type = 'NEGATIVE_KEYWORDS' AND shared_criterion.type = 'KEYWORD'`;

export const CONVERSION_ACTION_GAQL = `
  SELECT conversion_action.id, conversion_action.name, conversion_action.status, conversion_action.type,
         conversion_action.category, conversion_action.origin, conversion_action.primary_for_goal,
         conversion_action.include_in_conversions_metric, conversion_action.counting_type,
         conversion_action.value_settings.default_value, conversion_action.value_settings.always_use_default_value
    FROM conversion_action
   WHERE conversion_action.status != 'REMOVED'`;

export const CAMPAIGN_CONVERSION_GOAL_GAQL = `
  SELECT campaign.id, campaign_conversion_goal.category, campaign_conversion_goal.origin,
         campaign_conversion_goal.biddable
    FROM campaign_conversion_goal`;

const cut = (v: unknown): string | null => {
  const s = String(v ?? "").trim().slice(0, MAX_ASSET_CHARS);
  return s ? s : null;
};
const assetTexts = (list: unknown): string[] =>
  (Array.isArray(list) ? list : [])
    .map((a: any) => cut(a?.text))
    .filter((t): t is string => t !== null)
    .slice(0, MAX_ASSETS_PER_AD);
const sortedJoin = (xs: string[]): string | null => (xs.length ? JSON.stringify(xs) : null);
/** `customers/1/adGroupAds/2~3` -> `2~3`. */
export function parseAdGroupAdResource(v: unknown): string | null {
  const s = String(v ?? "").trim();
  const m = s.match(/adGroupAds\/(\d+~\d+)$/);
  return m ? (m[1] ?? null) : null;
}

/** One ad, without its labels yet. Headlines and descriptions keep their order:
 *  an order change is an edit somebody made. */
export function normalizeAd(row: any, report?: UnrecognisedEnum[]): SnapshotEntity | null {
  const a = row?.ad_group_ad?.ad ?? {};
  const adId = str(a.id);
  const adGroupId = str(row?.ad_group?.id);
  if (!adId || !adGroupId) return null;
  const rsa = a.responsive_search_ad ?? {};
  const urlList: unknown[] = Array.isArray(a.final_urls) ? a.final_urls : [];
  const urls = urlList.map((u: unknown) => str(u)).filter((u): u is string => u !== null);
  return {
    kind: "ad",
    entityId: `${adGroupId}~${adId}`,
    parentId: adGroupId,
    campaignId: str(row?.campaign?.id),
    name: null,
    status: snapshotEnum(AD_GROUP_AD_STATUS, row?.ad_group_ad?.status, "ad_group_ad.status", report),
    attrs: {
      ad_type: "RESPONSIVE_SEARCH_AD",
      headlines: sortedJoin(assetTexts(rsa.headlines)),
      descriptions: sortedJoin(assetTexts(rsa.descriptions)),
      final_urls: sortedJoin(urls),
      path1: str(rsa.path1),
      path2: str(rsa.path2),
      labels: null,
    },
  };
}

/**
 * Attach labels. `labelRows === null` means the label query FAILED, and then NO
 * ad is returned at all: an ad stored with null labels this week and real
 * labels next week is a change nobody made. `[]` is a real answer (no labels).
 */
export function assembleAds(ads: SnapshotEntity[], labelRows: any[] | null): SnapshotEntity[] {
  if (labelRows === null) return [];
  const byAd = new Map<string, string[]>();
  for (const r of labelRows) {
    const key = parseAdGroupAdResource(r?.ad_group_ad?.resource_name);
    const name = str(r?.label?.name);
    if (!key || !name) continue;
    const list = byAd.get(key) ?? [];
    list.push(name);
    byAd.set(key, list);
  }
  return ads.map((a) => {
    const labels = (byAd.get(a.entityId) ?? []).sort();
    return { ...a, attrs: { ...a.attrs, labels: labels.length ? JSON.stringify(labels) : null } };
  });
}

export function normalizeAccountNegative(row: any, report?: UnrecognisedEnum[]): SnapshotEntity | null {
  const n = row?.customer_negative_criterion ?? {};
  const id = str(n.id);
  if (!id) return null;
  return {
    kind: "account_negative",
    entityId: id,
    parentId: null,
    campaignId: null,
    name: str(n.keyword?.text),
    status: "ENABLED",
    attrs: {
      match_type: snapshotEnum(KEYWORD_MATCH_TYPE, n.keyword?.match_type, "customer_negative_criterion.keyword.match_type", report),
      negative: true,
      level: "account",
    },
  };
}

/** A shared negative list, with the campaigns it is attached to. A failed
 *  attachment query (`attach === null`) drops the kind: attachments are part of
 *  what the list is. */
export function assembleSharedSets(setRows: any[], attach: any[] | null, report?: UnrecognisedEnum[]): SnapshotEntity[] {
  if (attach === null) return [];
  const byset = new Map<string, string[]>();
  for (const r of attach) {
    const sid = str(r?.shared_set?.id);
    const cid = str(r?.campaign?.id);
    if (!sid || !cid) continue;
    const list = byset.get(sid) ?? [];
    list.push(cid);
    byset.set(sid, list);
  }
  const out: SnapshotEntity[] = [];
  for (const r of setRows) {
    const s = r?.shared_set ?? {};
    const id = str(s.id);
    if (!id) continue;
    const campaigns = (byset.get(id) ?? []).sort((a, b) => Number(a) - Number(b));
    out.push({
      kind: "shared_set",
      entityId: id,
      parentId: null,
      campaignId: null,
      name: str(s.name),
      status: snapshotEnum(SHARED_SET_STATUS, s.status, "shared_set.status", report),
      attrs: { list_type: "NEGATIVE_KEYWORDS", campaign_ids: campaigns.length ? JSON.stringify(campaigns) : null },
    });
  }
  return out;
}

export function normalizeSharedNegative(row: any, report?: UnrecognisedEnum[]): SnapshotEntity | null {
  const k = row?.shared_criterion ?? {};
  const setId = str(row?.shared_set?.id);
  const criterionId = str(k.criterion_id);
  if (!setId || !criterionId) return null;
  return {
    kind: "shared_negative",
    entityId: `ss:${setId}:${criterionId}`,
    parentId: setId,
    campaignId: null,
    name: str(k.keyword?.text),
    status: "ENABLED",
    attrs: {
      match_type: snapshotEnum(KEYWORD_MATCH_TYPE, k.keyword?.match_type, "shared_criterion.keyword.match_type", report),
      negative: true,
      level: "shared_list",
    },
  };
}

/** `default_value` is in the ACCOUNT'S currency units, NOT micros; it is stored
 *  verbatim under a name that says so. */
export function normalizeConversionAction(row: any, report?: UnrecognisedEnum[]): SnapshotEntity | null {
  const a = row?.conversion_action ?? {};
  const id = str(a.id);
  if (!id) return null;
  return {
    kind: "conversion_action",
    entityId: id,
    parentId: null,
    campaignId: null,
    name: str(a.name),
    status: snapshotEnum(CONVERSION_ACTION_STATUS, a.status, "conversion_action.status", report),
    attrs: {
      action_type: snapshotEnum(CONVERSION_ACTION_TYPE, a.type, "conversion_action.type", report),
      category: snapshotEnum(CONVERSION_GOAL_CATEGORY, a.category, "conversion_action.category", report),
      origin: snapshotEnum(CONVERSION_ORIGIN, a.origin, "conversion_action.origin", report),
      primary_for_goal: a.primary_for_goal == null ? null : Boolean(a.primary_for_goal),
      include_in_conversions_metric: a.include_in_conversions_metric == null ? null : Boolean(a.include_in_conversions_metric),
      counting_type: a.counting_type == null ? null : String(a.counting_type),
      default_value_account_currency: a.value_settings?.default_value == null ? null : Number(a.value_settings.default_value),
      always_use_default_value: a.value_settings?.always_use_default_value == null ? null : Boolean(a.value_settings.always_use_default_value),
    },
  };
}

export function normalizeCampaignConversionGoal(row: any, report?: UnrecognisedEnum[]): SnapshotEntity | null {
  const g = row?.campaign_conversion_goal ?? {};
  const campaignId = str(row?.campaign?.id);
  const category = snapshotEnum(CONVERSION_GOAL_CATEGORY, g.category, "campaign_conversion_goal.category", report);
  const origin = snapshotEnum(CONVERSION_ORIGIN, g.origin, "campaign_conversion_goal.origin", report);
  if (!campaignId || !category || !origin) return null;
  return {
    kind: "campaign_conversion_goal",
    entityId: `${campaignId}:${category}:${origin}`,
    parentId: campaignId,
    campaignId,
    name: null,
    status: "ENABLED",
    attrs: { category, origin, biddable: g.biddable == null ? null : Boolean(g.biddable) },
  };
}

// ── Storage ──────────────────────────────────────────────────────────────────
// Everything above this line is pure. Everything below it talks to Postgres and
// to nothing else — no ad platform, no network.

export async function loadOpenIntervals(
  c: pg.Client, platform: string, accountId: string,
): Promise<OpenInterval[]> {
  const { rows } = await c.query<{
    id: string; entity_kind: string; entity_id: string; content_hash: string;
    valid_from: string; last_seen_on: string;
  }>(
    `SELECT id, entity_kind, entity_id, content_hash, valid_from, last_seen_on
       FROM ads_structure_entities
      WHERE platform = $1 AND account_id = $2 AND valid_to IS NULL`,
    [platform, accountId],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.entity_kind as EntityKind,
    entityId: r.entity_id,
    contentHash: r.content_hash,
    validFrom: r.valid_from,
    lastSeenOn: r.last_seen_on,
  }));
}

/** Apply a plan. One statement per row; a snapshot is small and a batch that
 *  half-applies is worse than one that is slow. */
export async function applySnapshotPlan(
  c: pg.Client, clientId: string, platform: string, accountId: string, plan: ReconcilePlan, on: string,
): Promise<void> {
  for (const t of plan.touches) {
    await c.query(`UPDATE ads_structure_entities SET last_seen_on = $2, updated_at = now() WHERE id = $1`, [t.id, on]);
  }
  for (const cl of plan.closes) {
    await c.query(`UPDATE ads_structure_entities SET valid_to = $2, updated_at = now() WHERE id = $1 AND valid_to IS NULL`, [cl.id, cl.validTo]);
  }
  for (const r of plan.replaces) {
    const e = r.entity;
    await c.query(
      `UPDATE ads_structure_entities
          SET parent_id = $2, campaign_id = $3, name = $4, status = $5,
              content_hash = $6, attrs_json = $7, last_seen_on = $8, updated_at = now()
        WHERE id = $1`,
      [r.id, e.parentId, e.campaignId, e.name, e.status, r.hash, JSON.stringify(e.attrs), on],
    );
  }
  for (const o of plan.opens) {
    const e = o.entity;
    await c.query(
      `INSERT INTO ads_structure_entities (
         id, client_id, platform, account_id, entity_kind, entity_id, parent_id, campaign_id,
         name, status, content_hash, attrs_json, valid_from, valid_to, last_seen_on)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NULL,$14)
       ON CONFLICT (platform, account_id, entity_kind, entity_id, valid_from) DO NOTHING`,
      [
        randomUUID(), clientId, platform, accountId, e.kind, e.entityId, e.parentId, e.campaignId,
        e.name, e.status, o.hash, JSON.stringify(e.attrs), on, on,
      ],
    );
  }
}

/**
 * Record that this account was snapshotted on this date, and what was read.
 *
 * A NULL IS UNANSWERED. With no row for a date, "nothing changed" and "we were
 * not looking" are the same absence and they lead to opposite decisions — the
 * point `ads_change_scans` already makes one table along. A second run on one
 * date overwrites the row, because the grain is a date.
 */
export async function recordSnapshotScan(
  c: pg.Client, clientId: string, platform: string, accountId: string, on: string,
  counts: AccountSnapshotCounts, unrecognised: number, ok: boolean, note: string,
): Promise<void> {
  await c.query(
    `INSERT INTO ads_structure_scans (
       id, client_id, platform, account_id, snapshot_on, taken_at,
       entities_read, entities_opened, entities_changed, entities_closed, entities_unchanged,
       unrecognised_enums, ok, note)
     VALUES ($1,$2,$3,$4,$5, now(), $6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (platform, account_id, snapshot_on) DO UPDATE SET
       taken_at = now(), entities_read = EXCLUDED.entities_read,
       entities_opened = EXCLUDED.entities_opened, entities_changed = EXCLUDED.entities_changed,
       entities_closed = EXCLUDED.entities_closed, entities_unchanged = EXCLUDED.entities_unchanged,
       unrecognised_enums = EXCLUDED.unrecognised_enums, ok = EXCLUDED.ok, note = EXCLUDED.note`,
    [
      randomUUID(), clientId, platform, accountId, on,
      counts.read, counts.opened, counts.changed, counts.closed, counts.unchanged,
      unrecognised, ok, note.slice(0, 500),
    ],
  );
}

/** A run that could not read an account at all. The scan row says so rather
 *  than being left absent, so the gap is dated rather than inferred. */
export async function recordSnapshotFailure(
  c: pg.Client, clientId: string, platform: string, accountId: string, on: string, why: string,
): Promise<void> {
  await recordSnapshotScan(
    c, clientId, platform, accountId, on,
    { read: 0, opened: 0, changed: 0, closed: 0, unchanged: 0 },
    0, false, `read failed: ${why}`,
  );
}

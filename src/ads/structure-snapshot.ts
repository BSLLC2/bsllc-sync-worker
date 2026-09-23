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
 * ── THE GRAIN: CAMPAIGN, AD GROUP, KEYWORD, BUDGET, BID STRATEGY ───────────
 *
 * Those five are the account's skeleton and they are what this system already
 * reasons about: the rules engine judges campaigns, the guarded apply path
 * writes budgets and campaign negatives, and the bid-target reading next door
 * turns on the strategy. Keywords cover both levels — the positive and
 * negative criteria on an ad group, and the negative keyword list on a
 * campaign — because campaign negatives are one of the operations we ourselves
 * write, and a snapshot that cannot diff our own writes is missing the half we
 * are answerable for.
 *
 * ADS AND RESPONSIVE SEARCH ADS ARE OUT OF SCOPE, deliberately, and this is
 * what it costs. An RSA carries up to fifteen headlines and four descriptions;
 * that is CONTENT, it is the biggest row by an order of magnitude, and it
 * moves on its own schedule. Three things make it the wrong thing to store
 * here. Ad copy is out of our change scope by policy rather than by API limit
 * (the adapter's capability block says so — OCH runs under LegitScript). A
 * served Google ad is effectively immutable, so "an ad changed" is really a
 * new ad created and the old one paused, which is a CREATE and a REMOVE that
 * `change_event` already records with its own timestamps. And the diff a
 * person actually wants over ad text is a diff of words, which is a different
 * reading from a diff of settings. THE COST, stated rather than hidden: this
 * table cannot answer "which ads were live on 1 September", and the copy work
 * in a vendor brief is not measured by it. Adding ads later is one more entry
 * in ENTITY_KINDS and one more normalizer; nothing here is shaped against it.
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
 * out later: if ads are ever added at the grain above, or the cadence ever
 * goes sub-daily on a large account, rows start growing with TIME again and
 * this decision has to be taken a second time.
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

/** The five kinds this snapshot covers. See the header for what is not here. */
export const ENTITY_KINDS = ["campaign", "ad_group", "keyword", "budget", "bid_strategy"] as const;
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

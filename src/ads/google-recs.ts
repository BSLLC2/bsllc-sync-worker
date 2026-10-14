/**
 * GOOGLE'S OWN RECOMMENDATIONS, read and stored. Never applied.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * Google Ads shows each account a list of "recommendations" (raise this budget,
 * add this keyword, opt in to that bidding strategy, turn on auto-applied
 * assets). The company owner asked whether the system reads them and works out
 * "which ones should be implemented based on client". It did not read them at
 * all, so a person opening the platform saw a list this system knew nothing
 * about, and a recommendation that contradicted what the audit had already said
 * (a budget raise on a campaign whose conversion column has stopped counting)
 * looked as authoritative as any other.
 *
 * This file only READS and STORES them. Deciding which fit a client is the
 * dashboard's job (shared/ads-google-recs.ts), because that decision rests on
 * things only the dashboard holds: the client's approved budget, their
 * protected terms, their services, and what the audit has already raised.
 *
 * ── READ-ONLY, AND THAT IS THE WHOLE POINT ─────────────────────────────────
 *
 * `recommendation` is a SELECT. The API also has an `ApplyRecommendation` and a
 * `DismissRecommendation` call; NEITHER IS CALLED FROM HERE OR FROM ANYWHERE IN
 * THIS REPOSITORY, and `verify-ads-google-recs` fails if the words appear in
 * these two files. The propose/approve split is untouched: nothing here changes
 * an ad account, dismisses anything in it or applies anything to it. Dismissing
 * a suggestion in this app is a record on OUR side and is never sent to Google.
 *
 * ── WHAT IS READ ───────────────────────────────────────────────────────────
 *
 * Two queries per account, so one wrong field name cannot cost the other:
 *
 *   1. the base: type, which campaign / ad group / budget, Google's own
 *      "dismissed" flag and the impact figures Google states for it.
 *   2. a detail pass for the two types the dashboard needs content for to judge
 *      a fit: the budget it proposes (current and recommended, in micros) and
 *      the keyword it proposes (text, match type, bid). If this pass fails the
 *      recommendations are still stored, with no detail, and the run says so. A
 *      NULL detail is unanswered, never a nought.
 *
 * ── IDENTITY: THE CONTENT, NOT THE RESOURCE NAME ───────────────────────────
 *
 * Google re-issues a recommendation under a new resource name when it
 * regenerates it, which would make every re-issue a stranger to whatever a
 * person had decided about the old one. The row's id is therefore a digest of
 * what the recommendation IS (account, type, campaign, ad group, and the one
 * thing that distinguishes two of a kind: the keyword text, or the budget), so
 * a decision made on Tuesday still belongs to the same suggestion on Thursday.
 * The latest resource name rides on the row for reference.
 *
 * ── CLOSED WHEN GONE, ONLY ON A WHOLE READ ─────────────────────────────────
 *
 * A recommendation Google stops returning is closed with a dated reason. A read
 * that failed, or that came back at the cap, closes NOTHING: an absence from a
 * partial list is an absence from the list, not from the platform. A closed row
 * that Google returns again is re-opened, with its first-seen date intact.
 *
 * Pure down to the line that says where it stops.
 */
import type pg from "pg";
import { createHash } from "node:crypto";

/** A read this long may have been cut, and a cut read closes nothing. */
export const RECS_READ_CAP = 5000;

/**
 * Every RecommendationType Google's API names (v24), by NAME.
 *
 * Listed here so the dashboard can be compared against it by `verify:wiring`
 * and so a type this build has never heard of is COUNTED rather than guessed.
 * `verify-ads-google-recs` checks the list against the installed client
 * library's own enum, both ways.
 */
export const REC_TYPE_NAMES = [
  "CAMPAIGN_BUDGET", "KEYWORD", "TEXT_AD", "TARGET_CPA_OPT_IN", "MAXIMIZE_CONVERSIONS_OPT_IN",
  "ENHANCED_CPC_OPT_IN", "SEARCH_PARTNERS_OPT_IN", "MAXIMIZE_CLICKS_OPT_IN", "OPTIMIZE_AD_ROTATION",
  "KEYWORD_MATCH_TYPE", "MOVE_UNUSED_BUDGET", "FORECASTING_CAMPAIGN_BUDGET", "TARGET_ROAS_OPT_IN",
  "RESPONSIVE_SEARCH_AD", "MARGINAL_ROI_CAMPAIGN_BUDGET", "USE_BROAD_MATCH_KEYWORD",
  "RESPONSIVE_SEARCH_AD_ASSET", "UPGRADE_SMART_SHOPPING_CAMPAIGN_TO_PERFORMANCE_MAX",
  "RESPONSIVE_SEARCH_AD_IMPROVE_AD_STRENGTH", "DISPLAY_EXPANSION_OPT_IN",
  "UPGRADE_LOCAL_CAMPAIGN_TO_PERFORMANCE_MAX", "RAISE_TARGET_CPA_BID_TOO_LOW",
  "FORECASTING_SET_TARGET_ROAS", "CALLOUT_ASSET", "SITELINK_ASSET", "CALL_ASSET",
  "SHOPPING_ADD_AGE_GROUP", "SHOPPING_ADD_COLOR", "SHOPPING_ADD_GENDER", "SHOPPING_ADD_SIZE",
  "SHOPPING_ADD_GTIN", "SHOPPING_ADD_MORE_IDENTIFIERS", "SHOPPING_ADD_PRODUCTS_TO_CAMPAIGN",
  "SHOPPING_FIX_DISAPPROVED_PRODUCTS", "SHOPPING_TARGET_ALL_OFFERS",
  "SHOPPING_FIX_SUSPENDED_MERCHANT_CENTER_ACCOUNT",
  "SHOPPING_FIX_MERCHANT_CENTER_ACCOUNT_SUSPENSION_WARNING",
  "SHOPPING_MIGRATE_REGULAR_SHOPPING_CAMPAIGN_OFFERS_TO_PERFORMANCE_MAX",
  "DYNAMIC_IMAGE_EXTENSION_OPT_IN", "RAISE_TARGET_CPA", "LOWER_TARGET_ROAS", "PERFORMANCE_MAX_OPT_IN",
  "IMPROVE_PERFORMANCE_MAX_AD_STRENGTH", "MIGRATE_DYNAMIC_SEARCH_ADS_CAMPAIGN_TO_PERFORMANCE_MAX",
  "FORECASTING_SET_TARGET_CPA", "SET_TARGET_CPA", "SET_TARGET_ROAS", "MAXIMIZE_CONVERSION_VALUE_OPT_IN",
  "IMPROVE_GOOGLE_TAG_COVERAGE", "PERFORMANCE_MAX_FINAL_URL_OPT_IN", "REFRESH_CUSTOMER_MATCH_LIST",
  "CUSTOM_AUDIENCE_OPT_IN", "LEAD_FORM_ASSET", "IMPROVE_DEMAND_GEN_AD_STRENGTH",
] as const;

// ── The queries ──────────────────────────────────────────────────────────────
const METRICS = ["impressions", "clicks", "cost_micros", "conversions", "conversions_value"] as const;
export const GOOGLE_RECS_GAQL = `SELECT recommendation.resource_name, recommendation.type,
       recommendation.campaign, recommendation.ad_group, recommendation.campaign_budget,
       recommendation.dismissed,
       ${METRICS.map((m) => `recommendation.impact.base_metrics.${m}`).join(", ")},
       ${METRICS.map((m) => `recommendation.impact.potential_metrics.${m}`).join(", ")}
  FROM recommendation`;

export const GOOGLE_RECS_DETAIL_GAQL = `SELECT recommendation.resource_name,
       recommendation.campaign_budget_recommendation.current_budget_amount_micros,
       recommendation.campaign_budget_recommendation.recommended_budget_amount_micros,
       recommendation.keyword_recommendation.keyword.text,
       recommendation.keyword_recommendation.keyword.match_type,
       recommendation.keyword_recommendation.recommended_cpc_bid_micros
  FROM recommendation
 WHERE recommendation.type IN ('CAMPAIGN_BUDGET', 'KEYWORD')`;

// ── Reading a row ────────────────────────────────────────────────────────────
export interface RecMetrics {
  impressions: number | null; clicks: number | null; costMicros: number | null;
  conversions: number | null; conversionsValue: number | null;
}
export interface RecImpact { base: RecMetrics | null; potential: RecMetrics | null }
export interface RecDetail {
  budget: { currentMicros: number | null; recommendedMicros: number | null } | null;
  keyword: { text: string | null; matchType: string | null; cpcBidMicros: number | null } | null;
}
export interface NormalRec {
  /** Digest of what the recommendation IS. See the header. */
  id: string;
  resourceName: string;
  recType: string;
  campaignId: string | null;
  adGroupId: string | null;
  budgetId: string | null;
  /** Google's own flag. NULL = the row did not say, never "not dismissed". */
  dismissedInGoogle: boolean | null;
  impact: RecImpact | null;
  detail: RecDetail | null;
}

const tailId = (rn: unknown): string | null => {
  const last = String(rn ?? "").trim().split("/").pop() ?? "";
  return /^\d+$/.test(last) ? last : null;
};
const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const pick = (o: any, snake: string): unknown => {
  if (!o || typeof o !== "object") return undefined;
  const camel = snake.replace(/_([a-z])/g, (_m, c) => c.toUpperCase());
  return o[snake] ?? o[camel];
};

function metricsOf(m: any): RecMetrics | null {
  if (!m || typeof m !== "object") return null;
  const out: RecMetrics = {
    impressions: num(pick(m, "impressions")), clicks: num(pick(m, "clicks")), costMicros: num(pick(m, "cost_micros")),
    conversions: num(pick(m, "conversions")), conversionsValue: num(pick(m, "conversions_value")),
  };
  // An object with no figure in it is "Google stated none", not a row of noughts.
  return Object.values(out).every((v) => v == null) ? null : out;
}

/**
 * The type's NAME. Enums arrive as integers from the client library; `byNumber`
 * is built from the library's own enum so there is no number typed in this
 * repository. A value this build cannot decode comes back as `UNRECOGNISED:<raw>`,
 * which is counted and shown, never folded into the nearest known type.
 */
export function decodeRecType(raw: unknown, byNumber: Readonly<Record<string, string>>): string {
  const s = String(raw ?? "").trim();
  if (!s) return "UNRECOGNISED:";
  if (/^\d+$/.test(s)) return byNumber[s] ?? `UNRECOGNISED:${s}`;
  const up = s.toUpperCase();
  return (REC_TYPE_NAMES as readonly string[]).includes(up) ? up : `UNRECOGNISED:${s}`;
}

/** The one thing that tells two recommendations of one type apart. */
function distinguisher(recType: string, detail: RecDetail | null, budgetId: string | null): string {
  if (recType === "KEYWORD" && detail?.keyword?.text) {
    return `${detail.keyword.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()}|${(detail.keyword.matchType ?? "").toLowerCase()}`;
  }
  return budgetId ?? "";
}

export function recId(accountId: string, r: Pick<NormalRec, "recType" | "campaignId" | "adGroupId" | "budgetId" | "detail">): string {
  return createHash("sha256")
    .update([accountId.replace(/\D/g, ""), r.recType, r.campaignId ?? "", r.adGroupId ?? "", distinguisher(r.recType, r.detail, r.budgetId)].join("|"))
    .digest("hex").slice(0, 32);
}

/** One API row to one recommendation, or null for a row with no resource name. */
export function normalizeRecommendation(
  row: any,
  accountId: string,
  byNumber: Readonly<Record<string, string>>,
): NormalRec | null {
  const r = row?.recommendation ?? row ?? {};
  const resourceName = String(pick(r, "resource_name") ?? "").trim();
  if (!resourceName) return null;
  const impact = pick(r, "impact") as any;
  const base = metricsOf(pick(impact, "base_metrics"));
  const potential = metricsOf(pick(impact, "potential_metrics"));
  const dismissed = pick(r, "dismissed");
  const rec: NormalRec = {
    id: "", resourceName,
    recType: decodeRecType(pick(r, "type"), byNumber),
    campaignId: tailId(pick(r, "campaign")),
    adGroupId: tailId(pick(r, "ad_group")),
    budgetId: tailId(pick(r, "campaign_budget")),
    dismissedInGoogle: typeof dismissed === "boolean" ? dismissed : null,
    impact: base || potential ? { base, potential } : null,
    detail: null,
  };
  rec.id = recId(accountId, rec);
  return rec;
}

/** The detail pass, keyed by resource name. A row it did not return keeps null. */
export function parseRecDetails(rows: readonly any[]): Map<string, RecDetail> {
  const out = new Map<string, RecDetail>();
  for (const row of rows ?? []) {
    const r = row?.recommendation ?? row ?? {};
    const rn = String(pick(r, "resource_name") ?? "").trim();
    if (!rn) continue;
    const b = pick(r, "campaign_budget_recommendation") as any;
    const k = pick(r, "keyword_recommendation") as any;
    const kw = pick(k, "keyword") as any;
    const budget = b && (num(pick(b, "current_budget_amount_micros")) != null || num(pick(b, "recommended_budget_amount_micros")) != null)
      ? { currentMicros: num(pick(b, "current_budget_amount_micros")), recommendedMicros: num(pick(b, "recommended_budget_amount_micros")) }
      : null;
    const MATCH: Record<string, string> = { "2": "EXACT", "3": "PHRASE", "4": "BROAD" };
    const mt = pick(kw, "match_type");
    const keyword = kw && typeof pick(kw, "text") === "string" && String(pick(kw, "text")).trim()
      ? {
        text: String(pick(kw, "text")).trim(),
        matchType: mt == null ? null : (MATCH[String(mt)] ?? String(mt).toUpperCase()),
        cpcBidMicros: num(pick(k, "recommended_cpc_bid_micros")),
      }
      : null;
    if (budget || keyword) out.set(rn, { budget, keyword });
  }
  return out;
}

/**
 * Put the detail on its recommendation and (re)compute the id, since a keyword
 * recommendation's identity includes its text. Pure; returns new objects.
 */
export function withDetails(recs: readonly NormalRec[], details: ReadonlyMap<string, RecDetail>, accountId: string): NormalRec[] {
  return recs.map((r) => {
    const d = details.get(r.resourceName) ?? null;
    const next = { ...r, detail: d };
    next.id = recId(accountId, next);
    return next;
  });
}

// ── What a run does to what is stored ────────────────────────────────────────
export interface StoredRec { id: string; closedAt: string | null }
export interface RecSyncPlan {
  /** Insert-or-refresh, in read order, one per id. */
  upsert: NormalRec[];
  /** Ids Google returned twice under one content id; the second is dropped. */
  duplicates: number;
  /** Open ids Google no longer returns, closed only on a whole read. */
  close: string[];
  /** Closed ids Google returned again. */
  reopen: string[];
  /** Why nothing was closed, when something would otherwise have been. */
  closeHeld: string | null;
}

export function planRecSync(stored: readonly StoredRec[], read: readonly NormalRec[], complete: boolean): RecSyncPlan {
  const seen = new Set<string>();
  const upsert: NormalRec[] = [];
  let duplicates = 0;
  for (const r of read) {
    if (seen.has(r.id)) { duplicates += 1; continue; }
    seen.add(r.id);
    upsert.push(r);
  }
  const reopen = stored.filter((s) => s.closedAt && seen.has(s.id)).map((s) => s.id);
  const gone = stored.filter((s) => !s.closedAt && !seen.has(s.id)).map((s) => s.id);
  if (!complete) {
    return { upsert, duplicates, close: [], reopen, closeHeld: gone.length ? "the read was not whole, so nothing was closed" : null };
  }
  return { upsert, duplicates, close: gone, reopen, closeHeld: null };
}

export const CLOSED_GONE_REASON = "Google no longer returns this suggestion.";

/** A read that hit the cap may have been cut. */
export const readIsWhole = (rows: number, cap: number = RECS_READ_CAP): boolean => rows < cap;

// ═══ Storage. Everything above is pure. ══════════════════════════════════════
/**
 * The tables are the dashboard's (schema v251) and `ensureSchema()` creates
 * them on boot. A run can land before that deploy, so the worker provisions the
 * same shape idempotently, the way the change capture provisions its column.
 * `verify:wiring` compares these column names with the app's declaration.
 */
export const ENSURE_RECS_DDL = [
  `CREATE TABLE IF NOT EXISTS ads_google_recs (
     id               TEXT PRIMARY KEY,
     client_id        TEXT NOT NULL,
     platform         TEXT NOT NULL,
     account_id       TEXT NOT NULL,
     rec_type         TEXT NOT NULL,
     resource_name    TEXT NOT NULL,
     campaign_id      TEXT,
     campaign_name    TEXT,
     ad_group_id      TEXT,
     budget_id        TEXT,
     dismissed_in_google BOOLEAN,
     impact_json      TEXT,
     detail_json      TEXT,
     first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
     last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
     closed_at        TIMESTAMPTZ,
     closed_why       TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_ads_google_recs_account ON ads_google_recs (platform, account_id, closed_at)`,
  `CREATE INDEX IF NOT EXISTS idx_ads_google_recs_client ON ads_google_recs (client_id, closed_at)`,
  `CREATE TABLE IF NOT EXISTS ads_google_rec_scans (
     platform      TEXT NOT NULL,
     account_id    TEXT NOT NULL,
     client_id     TEXT NOT NULL,
     last_scan_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
     ok            BOOLEAN NOT NULL,
     live_count    INTEGER,
     whole         BOOLEAN,
     detail_ok     BOOLEAN,
     note          TEXT,
     PRIMARY KEY (platform, account_id)
   )`,
];

export async function ensureRecTables(c: pg.Client): Promise<void> {
  for (const ddl of ENSURE_RECS_DDL) await c.query(ddl);
}

export async function storedRecs(c: pg.Client, platform: string, accountId: string): Promise<StoredRec[]> {
  const { rows } = await c.query<{ id: string; closed_at: Date | string | null }>(
    `SELECT id, closed_at FROM ads_google_recs WHERE platform = $1 AND account_id = $2`, [platform, accountId]);
  return rows.map((r) => ({ id: r.id, closedAt: r.closed_at ? new Date(r.closed_at).toISOString() : null }));
}

/** Insert-or-refresh. A returning closed row is re-opened; first_seen_at is never rewritten. */
export async function upsertRecs(
  c: pg.Client, clientId: string, platform: string, accountId: string,
  recs: readonly NormalRec[], campaignNames: ReadonlyMap<string, string>,
): Promise<void> {
  for (const r of recs) {
    await c.query(
      `INSERT INTO ads_google_recs (id, client_id, platform, account_id, rec_type, resource_name, campaign_id, campaign_name,
         ad_group_id, budget_id, dismissed_in_google, impact_json, detail_json, first_seen_at, last_seen_at, closed_at, closed_why)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now(), now(), NULL, NULL)
       ON CONFLICT (id) DO UPDATE SET
         client_id = EXCLUDED.client_id, resource_name = EXCLUDED.resource_name,
         campaign_name = COALESCE(EXCLUDED.campaign_name, ads_google_recs.campaign_name),
         dismissed_in_google = EXCLUDED.dismissed_in_google,
         impact_json = EXCLUDED.impact_json,
         detail_json = COALESCE(EXCLUDED.detail_json, ads_google_recs.detail_json),
         last_seen_at = now(), closed_at = NULL, closed_why = NULL`,
      [
        r.id, clientId, platform, accountId, r.recType, r.resourceName, r.campaignId,
        r.campaignId ? campaignNames.get(r.campaignId) ?? null : null, r.adGroupId, r.budgetId,
        r.dismissedInGoogle, r.impact ? JSON.stringify(r.impact) : null, r.detail ? JSON.stringify(r.detail) : null,
      ],
    );
  }
}

export async function closeRecs(c: pg.Client, ids: readonly string[], why: string = CLOSED_GONE_REASON): Promise<void> {
  if (!ids.length) return;
  await c.query(`UPDATE ads_google_recs SET closed_at = now(), closed_why = $2 WHERE id = ANY($1::text[]) AND closed_at IS NULL`, [ids, why]);
}

export async function recordRecScan(
  c: pg.Client, clientId: string, platform: string, accountId: string,
  s: { ok: boolean; liveCount: number | null; whole: boolean | null; detailOk: boolean | null; note: string },
): Promise<void> {
  await c.query(
    `INSERT INTO ads_google_rec_scans (platform, account_id, client_id, last_scan_at, ok, live_count, whole, detail_ok, note)
     VALUES ($1,$2,$3, now(), $4,$5,$6,$7,$8)
     ON CONFLICT (platform, account_id) DO UPDATE SET
       client_id = EXCLUDED.client_id, last_scan_at = now(), ok = EXCLUDED.ok,
       live_count = EXCLUDED.live_count, whole = EXCLUDED.whole, detail_ok = EXCLUDED.detail_ok, note = EXCLUDED.note`,
    [platform, accountId, clientId, s.ok, s.liveCount, s.whole, s.detailOk, s.note.slice(0, 300)],
  );
}

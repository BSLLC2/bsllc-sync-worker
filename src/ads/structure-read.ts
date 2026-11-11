/**
 * Reading one ad account's structure: the queries, and what a refusal of any one of them costs.
 *
 * Split out of the job (src/ads-structure-snapshot.ts) so the verifier can drive it with a fake customer. The job is a
 * script that runs on import; this is not.
 */
import {
  AD_GROUP_GAQL, AD_GROUP_KEYWORD_GAQL, BID_STRATEGY_GAQL, BUDGET_GAQL,
  CAMPAIGN_BIDDING_GAQL, CAMPAIGN_DATES_GAQL, CAMPAIGN_GAQL, CAMPAIGN_KEYWORD_GAQL,
  MAX_ENTITIES_PER_KIND,
  AD_GAQL, AD_LABEL_GAQL, ACCOUNT_NEGATIVE_GAQL, SHARED_SET_GAQL, CAMPAIGN_SHARED_SET_GAQL,
  SHARED_CRITERION_GAQL, CONVERSION_ACTION_GAQL, CAMPAIGN_CONVERSION_GOAL_GAQL,
  assembleAds, assembleSharedSets, normalizeAccountNegative, normalizeAd,
  normalizeCampaignConversionGoal, normalizeConversionAction, normalizeSharedNegative,
  normalizeAdGroup,
  applyCampaignBidding, applyCampaignDates, normalizeAdGroupKeyword, normalizeBidStrategy, normalizeBudget, normalizeCampaign,
  normalizeCampaignKeyword,
  type EntityKind, type SnapshotEntity, type UnrecognisedEnum,
} from "./structure-snapshot.js";

export interface KindRead {
  entities: SnapshotEntity[];
  /** True only where the whole list came back: not a failed query, not a
   *  response sitting at the row cap. Only a complete kind may close. */
  complete: boolean;
  problem: string | null;
}

/**
 * One kind, read and normalized.
 *
 * A QUERY THAT THREW RETURNS `complete: false` AND AN EMPTY LIST, which is not
 * the same as an account with none of that kind — the difference is the whole
 * point, and it is what stops a permissions hiccup closing every keyword on a
 * live account.
 */
export async function readKind(
  customer: any,
  label: string,
  gaql: string,
  normalize: (row: any, report?: UnrecognisedEnum[]) => SnapshotEntity | null,
  report: UnrecognisedEnum[],
): Promise<KindRead> {
  let rows: any[];
  try {
    rows = await customer.query(gaql);
  } catch (e: any) {
    const msg = e?.errors?.map((x: any) => x.message).join("; ") || e?.message || String(e);
    return { entities: [], complete: false, problem: `${label} could not be read (${msg.slice(0, 160)}) — nothing of that kind was closed` };
  }
  const list = Array.isArray(rows) ? rows : [];
  const capped = list.length >= MAX_ENTITIES_PER_KIND;
  const entities = list.map((r) => normalize(r, report)).filter((e): e is SnapshotEntity => e !== null);
  return {
    entities,
    complete: !capped,
    problem: capped
      ? `${label} came back at the ${MAX_ENTITIES_PER_KIND}-row ceiling, so this run cannot say it read them all — nothing of that kind was closed. Raise MAX_ENTITIES_PER_KIND once somebody has read this line.`
      : null,
  };
}

/**
 * Raw rows for a DEPENDENT query (ad labels, shared-list attachments). Null on
 * a failure or a response at the row ceiling: the caller then drops the kind it
 * feeds rather than storing it half-described.
 */
export async function readRaw(customer: any, label: string, gaql: string): Promise<{ rows: any[] | null; problem: string | null }> {
  try {
    const rows = await customer.query(gaql);
    const list = Array.isArray(rows) ? rows : [];
    if (list.length >= MAX_ENTITIES_PER_KIND) {
      return { rows: null, problem: `${label} came back at the ${MAX_ENTITIES_PER_KIND}-row ceiling — the kind it feeds was not read this run` };
    }
    return { rows: list, problem: null };
  } catch (e: any) {
    const msg = e?.errors?.map((x: any) => x.message).join("; ") || e?.message || String(e);
    return { rows: null, problem: `${label} could not be read (${msg.slice(0, 160)}) — the kind it feeds was not read or closed this run` };
  }
}

/** Kinds the dashboard cannot draw an account without. */
export const CORE_KINDS: EntityKind[] = ["campaign", "budget"];

export async function readAccount(customer: any): Promise<{
  entities: SnapshotEntity[];
  completeKinds: EntityKind[];
  problems: string[];
  unrecognised: UnrecognisedEnum[];
}> {
  const report: UnrecognisedEnum[] = [];
  const campaigns = await readKind(customer, "campaigns", CAMPAIGN_GAQL, normalizeCampaign, report);
  // Bidding settings and dates are read by queries of their own and merged on. One of them being refused costs those
  // columns, named in the run's problems, and never the campaigns (see CAMPAIGN_GAQL).
  const bidding = await readRaw(customer, "campaign bidding settings", CAMPAIGN_BIDDING_GAQL);
  const dates = await readRaw(customer, "campaign dates", CAMPAIGN_DATES_GAQL);
  const rowsById = (rows: any[] | null): Map<string, any> => new Map((rows ?? []).map((r) => [String(r?.campaign?.id ?? ""), r] as const));
  const biddingBy = rowsById(bidding.rows), datesBy = rowsById(dates.rows);
  for (const e of campaigns.entities) {
    const b = biddingBy.get(e.entityId); if (b) applyCampaignBidding(e, b, report);
    const d = datesBy.get(e.entityId); if (d) applyCampaignDates(e, d);
  }
  const campaignExtraProblems = [bidding.problem, dates.problem].filter((p): p is string => p !== null);
  const adGroups = await readKind(customer, "ad groups", AD_GROUP_GAQL, normalizeAdGroup, report);
  const agKeywords = await readKind(customer, "ad group keywords", AD_GROUP_KEYWORD_GAQL, normalizeAdGroupKeyword, report);
  const campKeywords = await readKind(customer, "campaign negative keywords", CAMPAIGN_KEYWORD_GAQL, normalizeCampaignKeyword, report);
  const budgets = await readKind(customer, "budgets", BUDGET_GAQL, normalizeBudget, report);
  const strategies = await readKind(customer, "bid strategies", BID_STRATEGY_GAQL, normalizeBidStrategy, report);

  const completeKinds: EntityKind[] = [];
  if (campaigns.complete) completeKinds.push("campaign");
  if (adGroups.complete) completeKinds.push("ad_group");
  // ONE KIND, TWO QUERIES. `keyword` covers ad group criteria and campaign
  // negatives, so it is complete only where BOTH came back in full — a
  // half-read kind that closed on the half it did read would remove every
  // campaign negative in the account on a morning the second query failed.
  if (agKeywords.complete && campKeywords.complete) completeKinds.push("keyword");
  if (budgets.complete) completeKinds.push("budget");
  if (strategies.complete) completeKinds.push("bid_strategy");

  // ── Newer kinds. Each dependent query that fails drops its kind ENTIRELY.
  const extraProblems: string[] = [...campaignExtraProblems];
  const extraEntities: SnapshotEntity[] = [];

  const adsMain = await readKind(customer, "responsive search ads", AD_GAQL, normalizeAd, report);
  const adLabels = await readRaw(customer, "ad labels", AD_LABEL_GAQL);
  if (adLabels.problem) extraProblems.push(adLabels.problem);
  if (adsMain.complete && adLabels.rows !== null) {
    extraEntities.push(...assembleAds(adsMain.entities, adLabels.rows));
    completeKinds.push("ad");
  }

  const acctNeg = await readKind(customer, "account negative keywords", ACCOUNT_NEGATIVE_GAQL, normalizeAccountNegative, report);
  extraEntities.push(...acctNeg.entities);
  if (acctNeg.complete) completeKinds.push("account_negative");

  const sets = await readRaw(customer, "shared negative lists", SHARED_SET_GAQL);
  const attach = await readRaw(customer, "shared list attachments", CAMPAIGN_SHARED_SET_GAQL);
  const sharedCrit = await readKind(customer, "shared list negatives", SHARED_CRITERION_GAQL, normalizeSharedNegative, report);
  for (const p of [sets.problem, attach.problem]) if (p) extraProblems.push(p);
  if (sets.rows !== null && attach.rows !== null) {
    extraEntities.push(...assembleSharedSets(sets.rows, attach.rows, report));
    completeKinds.push("shared_set");
  }
  extraEntities.push(...sharedCrit.entities);
  if (sharedCrit.complete) completeKinds.push("shared_negative");

  const convActions = await readKind(customer, "conversion actions", CONVERSION_ACTION_GAQL, normalizeConversionAction, report);
  extraEntities.push(...convActions.entities);
  if (convActions.complete) completeKinds.push("conversion_action");

  const convGoals = await readKind(customer, "campaign conversion goals", CAMPAIGN_CONVERSION_GOAL_GAQL, normalizeCampaignConversionGoal, report);
  extraEntities.push(...convGoals.entities);
  if (convGoals.complete) completeKinds.push("campaign_conversion_goal");

  const reads = [campaigns, adGroups, agKeywords, campKeywords, budgets, strategies];
  return {
    entities: [...reads.flatMap((r) => r.entities), ...extraEntities],
    completeKinds,
    problems: [
      ...reads.map((r) => r.problem),
      adsMain.problem, acctNeg.problem, sharedCrit.problem, convActions.problem, convGoals.problem,
      ...extraProblems,
    ].filter((p): p is string => p !== null),
    unrecognised: report,
  };
}


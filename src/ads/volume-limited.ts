/**
 * LIMITED BY SEARCH VOLUME: a campaign that is not spending its budget because
 * there is not enough to spend it on.
 *
 * Pure. Facts in, one reading out. No database, no clock, no network. The
 * adapter reads the facts (`readVolumeLimit` in google-ads-adapter.ts), the
 * rules turn a reading into a finding (rules.ts), and this file decides.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * The owner, on Franklin Brazing (gaps found 14 October): the Brazing, Assembly
 * and Annealing campaigns sat well under their daily budgets and the platform's
 * own status for each read "Limited by search volume". Nothing in the audit said
 * so. `budget_limited` reads impression share lost to BUDGET and is silent on a
 * campaign that has more money than reach; every other row judged what the
 * account was already doing. A campaign that cannot spend its budget is the
 * opposite problem from one that runs out of it, and the fix is the opposite
 * too: more of what is searched, not more money.
 *
 * ── WHAT FIRES IT, AND WHAT DOES NOT ───────────────────────────────────────
 *
 * It needs BOTH, and neither is guessed:
 *
 *   1. THE PLATFORM SAYS SO. `campaign.primary_status_reasons` holds
 *      SEARCH_VOLUME_LIMITED, which is what the console shows as "Limited by
 *      search volume". Nothing is inferred from the spend alone: an
 *      under-spending campaign has many causes (bids, quality, a disapproved
 *      ad, a learning period) and only the platform can say which. A campaign
 *      that is merely eligible and not spending, with no such reason, is
 *      SILENT here. That is the cheap direction to be wrong in, and the owner
 *      can overrule it (see the CLAUDE.md note).
 *   2. THE SPEND AGREES. Across the last SEVEN WEEKDAYS (weekends left out,
 *      because a weekday-only business reads every weekend as an outage) it
 *      spent under `SPEND_SHARE_FLOOR` of its daily budget. The floor is OURS
 *      and every sentence says so; no source publishes a share at which a
 *      campaign counts as under-spending.
 *
 * It does NOT fire together with `budget_limited` on one campaign. A campaign
 * the platform calls BUDGET_CONSTRAINED, or one that loses more than the
 * budget-lost threshold of its impressions to budget, is budget_limited's, and
 * the two readings making opposite claims about one campaign is the
 * contradiction the root-cause grouping exists to prevent. rules.ts also checks
 * that no budget_limited row exists for the campaign.
 *
 * ── A NULL IS UNANSWERED, AND THE RUN SAYS WHICH ───────────────────────────
 *
 * The reading is `cant_tell`, with the reason, when: the status query failed;
 * the reasons field came back absent (an older API, a permissions gap); the
 * account's time zone could not be read (so "the last seven weekdays" cannot be
 * placed, and a partial day would count as under-spending); the daily spend
 * query failed; the campaign is on a SHARED budget (its spend is not comparable
 * to a budget other campaigns draw on) or the sharing could not be read; the
 * budget is missing; or the campaign started inside the window (days before it
 * existed would count as nought). Each is named in the run's output, once, by
 * the accounting lines. A campaign that is not a search campaign is skipped
 * without comment, because keywords are not what limits it.
 *
 * Days with no spend row count as NOUGHT: the daily report returns a row only
 * for a day with activity. That is stated on the row. What keeps a campaign
 * that was paused for part of the window from reading as under-spending is the
 * platform's own current status above, which a paused-and-resumed campaign does
 * not carry.
 *
 * ── THE ENUM NUMBERS ARE THE PLATFORM'S, NOT OURS ──────────────────────────
 *
 * The client library returns enums as integers. The maps below are the
 * published `CampaignPrimaryStatus` and `CampaignPrimaryStatusReason` values,
 * copied from the library's own generated enum file. A value the map does not
 * know is kept as its raw text and read as "some other reason", never dropped.
 */

/** Fraction of the daily budget below which a campaign counts as not spending
 *  it. OURS: a convention, said as one in the finding. */
export const SPEND_SHARE_FLOOR = 0.6;

/** How many weekdays are read. Seven is a working week and a day or two, which
 *  smooths a quiet Tuesday without reaching back past a change. */
export const WEEKDAYS_READ = 7;

export const PRIMARY_STATUS: Record<string, string> = {
  "0": "UNSPECIFIED", "1": "UNKNOWN", "2": "ELIGIBLE", "3": "PAUSED", "4": "REMOVED",
  "5": "ENDED", "6": "PENDING", "7": "MISCONFIGURED", "8": "LIMITED", "9": "LEARNING", "10": "NOT_ELIGIBLE",
};

/** The reasons this file reads by name; any other value is kept as raw text. */
export const PRIMARY_STATUS_REASON: Record<string, string> = {
  "0": "UNSPECIFIED", "1": "UNKNOWN", "2": "CAMPAIGN_REMOVED", "3": "CAMPAIGN_PAUSED", "4": "CAMPAIGN_PENDING",
  "5": "CAMPAIGN_ENDED", "6": "CAMPAIGN_DRAFT", "7": "BIDDING_STRATEGY_MISCONFIGURED", "8": "BIDDING_STRATEGY_LIMITED",
  "9": "BIDDING_STRATEGY_LEARNING", "10": "BIDDING_STRATEGY_CONSTRAINED", "11": "BUDGET_CONSTRAINED",
  "12": "BUDGET_MISCONFIGURED", "13": "SEARCH_VOLUME_LIMITED", "14": "AD_GROUPS_PAUSED", "15": "NO_AD_GROUPS",
  "16": "KEYWORDS_PAUSED", "17": "NO_KEYWORDS", "18": "AD_GROUP_ADS_PAUSED", "19": "NO_AD_GROUP_ADS",
  "20": "HAS_ADS_LIMITED_BY_POLICY", "21": "HAS_ADS_DISAPPROVED", "22": "MOST_ADS_UNDER_REVIEW",
};

export const SEARCH_VOLUME_REASON = "SEARCH_VOLUME_LIMITED";
/** Reasons that mean budget is what holds the campaign back: budget_limited's. */
export const BUDGET_REASONS: readonly string[] = ["BUDGET_CONSTRAINED", "BUDGET_MISCONFIGURED"];

function decode(map: Record<string, string>, v: unknown): string | null {
  if (v == null) return null;
  const raw = String(v);
  if (map[raw]) return map[raw];
  const upper = raw.toUpperCase();
  return Object.values(map).includes(upper) ? upper : raw;
}

export const decodePrimaryStatus = (v: unknown) => decode(PRIMARY_STATUS, v);

/** The reasons field is a repeated enum. Absent (undefined / null) is NOT an
 *  empty list: it returns null, meaning the field was not read. */
export function decodeStatusReasons(v: unknown): string[] | null {
  if (v == null) return null;
  const arr = Array.isArray(v) ? v : [v];
  return arr.map((x) => decode(PRIMARY_STATUS_REASON, x)).filter((x): x is string => x != null);
}

// ── Dates ───────────────────────────────────────────────────────────────────

const ymdOk = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(`${s}T00:00:00Z`));

export function addDaysYmd(ymd: string, n: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** The calendar date of `now` in the account's own time zone, or null where the
 *  zone is not one this runtime knows. */
export function accountDay(now: Date, timeZone: string | null | undefined): string | null {
  if (!timeZone) return null;
  try {
    const out = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    return ymdOk(out) ? out : null;
  } catch {
    return null;
  }
}

/** The last `n` weekdays up to and including `through`, oldest first. */
export function lastWeekdays(through: string, n: number): string[] {
  const out: string[] = [];
  if (!ymdOk(through)) return out;
  let d = through;
  for (let guard = 0; out.length < n && guard < n * 3 + 7; guard++) {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) out.unshift(d);
    d = addDaysYmd(d, -1);
  }
  return out;
}

// ── Facts ───────────────────────────────────────────────────────────────────

/**
 * One campaign row of the status query, turned into facts.
 *
 * `primary_status` PROVES THE FIELD SET CAME BACK. A repeated field with
 * nothing in it can be omitted from the response instead of arriving as [], so
 * an absent `primary_status_reasons` beside a returned `primary_status` is an
 * empty list, while an absent reasons field with no `primary_status` either is
 * a query that did not return these fields at all and is unreadable.
 */
export function statusFactsFromRow(row: any): CampaignVolumeFacts {
  const primaryStatus = decodePrimaryStatus(row?.campaign?.primary_status);
  const reasonsRaw = row?.campaign?.primary_status_reasons;
  const reasons = reasonsRaw != null ? decodeStatusReasons(reasonsRaw) : primaryStatus != null ? [] : null;
  const shared = row?.campaign_budget?.explicitly_shared;
  const start = row?.campaign?.start_date;
  return {
    primaryStatus,
    reasons,
    startDate: typeof start === "string" && ymdOk(start) ? start : null,
    budgetShared: shared == null ? null : Boolean(shared),
  };
}

export interface DailySpend { date: string; costMicros: number }

export interface CampaignVolumeFacts {
  /** Decoded `campaign.primary_status`, or null where it was not returned. */
  primaryStatus: string | null;
  /** Decoded `campaign.primary_status_reasons`. NULL = the field was not
   *  returned. [] = it was returned and holds nothing. */
  reasons: string[] | null;
  /** `campaign.start_date`, YYYY-MM-DD, or null. */
  startDate: string | null;
  /** `campaign_budget.explicitly_shared`. Null = not returned. */
  budgetShared: boolean | null;
}

export interface VolumeLimitFacts {
  /** The last complete day in the ACCOUNT's own calendar. Null = the time zone
   *  could not be read, so the week cannot be placed. */
  throughDate: string | null;
  /** By campaign id. NULL = the status query failed for the whole account. */
  status: Record<string, CampaignVolumeFacts> | null;
  /** By campaign id, the days that had a spend row. NULL = the query failed or
   *  could not be run. */
  dailySpend: Record<string, DailySpend[]> | null;
}

export interface VolumeLimitInput {
  campaignId: string;
  campaignName: string;
  channelType: string | null;
  dailyBudgetMicros: number;
  volume: VolumeLimitFacts | null | undefined;
}

export type VolumeCantTell =
  | "not_read"
  | "status_unreadable"
  | "reasons_unreadable"
  | "account_day_unknown"
  | "spend_unreadable"
  | "budget_shared"
  | "budget_unreadable"
  | "campaign_too_new";

export const VOLUME_CANT_TELL_LINE: Record<VolumeCantTell, string> = {
  not_read: "this run did not read the campaign's status",
  status_unreadable: "the status query failed for this account, so no campaign could be judged as limited by search volume",
  reasons_unreadable: "the platform returned no status reasons for it",
  account_day_unknown: "the account's time zone could not be read, so the last seven weekdays cannot be placed",
  spend_unreadable: "the daily spend could not be read",
  budget_shared: "it draws on a shared budget, or whether it does could not be read, so its spend cannot be compared to a budget of its own",
  budget_unreadable: "it has no daily budget on record",
  campaign_too_new: "it started inside the last seven weekdays, so days before it existed would count as nought",
};

export type VolumeNotLimited = "not_search" | "budget_constrained" | "no_volume_reason" | "spending_enough";

export type VolumeLimitReading =
  | {
      verdict: "limited";
      weekdays: string[];
      spendMicros: number;
      budgetMicros: number;
      /** spend / budget, 0..1+ */
      share: number;
      primaryStatus: string | null;
      reasons: string[];
    }
  | { verdict: "not_limited"; why: VolumeNotLimited }
  | { verdict: "cant_tell"; why: VolumeCantTell };

export function volumeLimitReading(i: VolumeLimitInput): VolumeLimitReading {
  // A campaign that is not a search campaign is not limited by what is searched
  // in the sense this rule means, and is skipped without comment.
  if (i.channelType !== "SEARCH") return { verdict: "not_limited", why: "not_search" };
  const v = i.volume;
  if (v == null) return { verdict: "cant_tell", why: "not_read" };
  if (v.status == null) return { verdict: "cant_tell", why: "status_unreadable" };
  const st = v.status[i.campaignId];
  if (!st || st.reasons == null) return { verdict: "cant_tell", why: "reasons_unreadable" };
  // The platform's own word comes first and decides whether anything else is
  // worth reading: a campaign it does not call volume-limited is silent.
  if (st.reasons.some((r) => BUDGET_REASONS.includes(r))) return { verdict: "not_limited", why: "budget_constrained" };
  if (!st.reasons.includes(SEARCH_VOLUME_REASON)) return { verdict: "not_limited", why: "no_volume_reason" };

  if (!v.throughDate) return { verdict: "cant_tell", why: "account_day_unknown" };
  if (v.dailySpend == null) return { verdict: "cant_tell", why: "spend_unreadable" };
  // A shared budget is not this campaign's to be compared against; "could not be
  // read" is the same silence.
  if (st.budgetShared !== false) return { verdict: "cant_tell", why: "budget_shared" };
  if (!(i.dailyBudgetMicros > 0)) return { verdict: "cant_tell", why: "budget_unreadable" };

  const weekdays = lastWeekdays(v.throughDate, WEEKDAYS_READ);
  if (weekdays.length < WEEKDAYS_READ) return { verdict: "cant_tell", why: "account_day_unknown" };
  if (st.startDate && ymdOk(st.startDate) && st.startDate > weekdays[0]!) return { verdict: "cant_tell", why: "campaign_too_new" };

  const byDate = new Map((v.dailySpend[i.campaignId] ?? []).map((d) => [d.date, d.costMicros] as const));
  const spendMicros = weekdays.reduce((s, d) => s + (byDate.get(d) ?? 0), 0);
  const budgetMicros = i.dailyBudgetMicros * weekdays.length;
  const share = spendMicros / budgetMicros;
  if (share >= SPEND_SHARE_FLOOR) return { verdict: "not_limited", why: "spending_enough" };
  return { verdict: "limited", weekdays, spendMicros, budgetMicros, share, primaryStatus: st.primaryStatus, reasons: st.reasons };
}

/** One sentence in the run's output for a campaign this could not read. */
export function volumeCantTellLine(campaignName: string | null, why: VolumeCantTell): string {
  const who = campaignName ? `"${campaignName}"` : "This account";
  return `${who}: not checked for search-volume limits, because ${VOLUME_CANT_TELL_LINE[why]}.`;
}

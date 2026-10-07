/**
 * What has to exist before traffic is worth sending.
 *
 * Pure. Facts in, findings out.
 *
 * ── WHY THIS IS HERE AND NOT IN shared/data-gaps.ts ───────────────────────
 *
 * The dashboard's `shared/data-gaps.ts` asks almost exactly this question one
 * level up — what is stopping this account's data telling the truth — and its
 * four rules are borrowed here whole (below). It is NOT extended, for two
 * reasons and neither is convenience:
 *
 *  • Its resolver, `storage.getClientDataGaps`, reads Postgres and nothing
 *    else, and the app is not allowed to call an ad platform. Both readings
 *    here are built on facts only an adapter holds — where the enabled ads in
 *    a campaign actually send a click, and which conversion actions the
 *    account has switched on. There is no route from that resolver to either.
 *  • These are findings a paid-media person acts on, and the ads queue is
 *    where paid-media work is read. A row on the launch page is a row the
 *    person managing the account never opens.
 *
 * ── THE RULES, CARRIED OVER ───────────────────────────────────────────────
 *
 *  1. PROVED FROM DATA. Nothing here is a flag somebody sets. The evidence
 *     names the count, the campaign and the URL, so it can be checked rather
 *     than believed.
 *  2. IT FIXES ITSELF. Point the ads at a real page, switch a call action on,
 *     and the next audit does not produce the row. Nothing is ticked, and the
 *     lifecycle in store.ts sweeps a finding that stops being true.
 *  3. SILENCE IS NOT A PASS. Every check answers open, clear or cant_tell.
 *     An unread final URL is `cant_tell` and says so; it is never read as a
 *     good landing page.
 *  4. WORST FIRST, BY WHAT IT COSTS. Sending paid clicks to a page that
 *     cannot answer them outranks not being able to count a phone call,
 *     because one is money leaving and the other is money arriving unseen.
 */

import type { ConversionActionRow } from "./rules.js";
import { negTokens } from "./negative-match.js";

/** One enabled ad and where it sends a click. */
export interface AdDestination {
  campaignId: string;
  campaignName: string;
  adGroupName: string | null;
  /** The ad's first final URL, verbatim. NULL MEANS NOT READ — an adapter that
   *  does not pull final URLs leaves it null and the reading says so rather
   *  than calling the account's landing pages fine. */
  finalUrl: string | null;
}

/**
 * One keyword the account can serve, and where a click on IT lands.
 *
 * An ad's final URL is only where a click lands when the keyword that matched
 * carries no page of its own. A keyword with its own Final URL overrides the ad,
 * so judging a campaign by its ads alone called a keyword that goes to
 * /locations/cincinnati-ohio/ a front-page landing.
 */
export interface KeywordLanding {
  campaignId: string;
  text: string;
  /** Its own landing page(s), verbatim. Empty or null = it carries none of its
   *  own, which this reading treats the same way: it inherits its ad's. */
  finalUrls: string[] | null;
  /** Whether it can serve today. A keyword that cannot is not a landing. */
  canServe: "yes" | "no" | "unknown";
}

/** What the client's own lead record says about how enquiries arrive. */
export interface PhoneDemandFacts {
  /** Leads captured in the window that arrived as a phone call, per the
   *  dashboard's own labelling. NULL = the feed was not read. */
  phoneLeads: number | null;
  /** Every lead captured in the window, however it arrived. NULL = not read. */
  totalLeads: number | null;
}

export type ReadinessState = "open" | "clear" | "cant_tell";

export interface ReadinessCheck {
  key: "generic_landing_page" | "call_tracking_absent";
  state: ReadinessState;
  /** The campaign this is about, where it is about one. */
  campaignId: string | null;
  campaignName: string | null;
  title: string;
  summary: string;
  lines: string[];
  metrics: Record<string, number>;
  /** Money a month riding on the problem, in cents. Null where there is none
   *  to name — never nought, which reads as "this costs nothing". */
  atStakeCents: number | null;
  /**
   * HOW THE CAMPAIGN'S KEYWORDS LAND, where they were read. Present on a
   * landing-page check whose ads all point at the front page, so the run can
   * say how many keywords were let through and why — a row that clears with
   * nobody told is the failure this exists against.
   */
  keywordLanding?: KeywordLandingCount | null;
}

export interface KeywordLandingCount {
  /** Keywords that can serve in this campaign. */
  keywords: number;
  /** …with a page of their own that is not the front page. */
  ownPage: number;
  /** …that are the client's own name or an alias, landing on the front page. */
  brand: number;
  /** …that land on the front page and are neither. */
  onFront: number;
  /** Keywords whose serving state could not be read, counted as landing on the front page. */
  unreadState: number;
}

/**
 * Share of a client's leads that must arrive by phone before an account with
 * no call conversion action is a finding.
 *
 * OURS. A third is the point at which the conversion column is measuring a
 * minority of the enquiries the money is producing, so every cost per
 * conversion on the account is overstated by half or more and every bidding
 * decision made from it is wrong in the same direction. Below it the column is
 * incomplete in a way that is worth knowing and is not worth a row on its own.
 */
export const CALL_TRACKING_PHONE_SHARE = 0.34;

/**
 * …and the leads that must have been captured at all before that share means
 * anything. Two calls out of five leads is 40% and is four events.
 */
export const CALL_TRACKING_MIN_LEADS = 20;

/**
 * Google's own categories for an action that counts a phone call.
 *
 * Read off the platform's classification, never off an action's name — the
 * same rule `OUTCOME_CATEGORIES` in rules.ts follows and for the same reason.
 */
const CALL_CATEGORIES = new Set(["PHONE_CALL_LEAD"]);

/**
 * Is this URL a bare site root?
 *
 * A path of "/" or nothing, with no query and no fragment. That is the one
 * page on a site that cannot answer a specific query, because it is the page
 * written to answer all of them. Anything with a path is a page somebody chose
 * and this says nothing about it — judging whether /services is the right
 * landing page for one term is a person's job and is not derivable from a URL.
 */
export function isSiteRoot(url: string): boolean {
  const raw = String(url ?? "").trim();
  if (!raw) return false;
  try {
    const u = new URL(raw.includes("://") ? raw : `https://${raw}`);
    const path = u.pathname.replace(/\/+$/, "");
    return path === "" && !u.search && !u.hash;
  } catch {
    return false;
  }
}

/**
 * Is this keyword the client's own name?
 *
 * The brand's words appear in the keyword as a contiguous run of whole words,
 * so "ohio community health" matches "ohio community health cincinnati" and
 * "ohiocommunityhealth" matches itself. Lowercased, punctuation folded, no
 * stemming: a keyword that merely shares a letter run with the brand is not
 * the brand, and a wrong yes here drops a finding.
 */
export function isBrandKeyword(text: string, brandPatterns: readonly string[]): boolean {
  const q = negTokens(text);
  if (q.length === 0) return false;
  for (const raw of brandPatterns) {
    const n = negTokens(raw);
    if (n.length === 0) continue;
    for (let i = 0; i + n.length <= q.length; i++) {
      let hit = true;
      for (let j = 0; j < n.length; j++) if (q[i + j] !== n[j]) { hit = false; break; }
      if (hit) return true;
    }
  }
  return false;
}

/** Sort one campaign's serving keywords into where their clicks land. */
export function classifyKeywordLanding(
  keywords: readonly KeywordLanding[],
  brandPatterns: readonly string[] | null | undefined,
): KeywordLandingCount {
  let ownPage = 0, brand = 0, onFront = 0, unreadState = 0, total = 0;
  for (const k of keywords) {
    if (k.canServe === "no") continue;
    total += 1;
    if (k.canServe === "unknown") { unreadState += 1; onFront += 1; continue; }
    const urls = (k.finalUrls ?? []).filter((u) => String(u ?? "").trim());
    if (urls.length > 0 && urls.some((u) => !isSiteRoot(u))) { ownPage += 1; continue; }
    if (brandPatterns && isBrandKeyword(k.text, brandPatterns)) { brand += 1; continue; }
    onFront += 1;
  }
  return { keywords: total, ownPage, brand, onFront, unreadState };
}

// ── Sentences, every one in this block ─────────────────────────────────────

/** "6 keywords serve here: 3 have a page of their own, 2 are the client's own name, 1 lands on the front page." */
export function keywordLandingLine(l: KeywordLandingCount): string {
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  const parts = [
    `${l.ownPage} ${l.ownPage === 1 ? "has" : "have"} a page of ${l.ownPage === 1 ? "its" : "their"} own`,
    `${l.brand} ${l.brand === 1 ? "is" : "are"} the client's own name (the front page is right for ${l.brand === 1 ? "it" : "those"})`,
    `${l.onFront} ${l.onFront === 1 ? "lands" : "land"} on the front page`,
  ];
  const unread = l.unreadState > 0 ? `, and ${n(l.unreadState, "keyword's", "keywords'")} serving state could not be read so ${l.unreadState === 1 ? "it is" : "they are"} counted as landing there` : "";
  return `${n(l.keywords, "keyword serves", "keywords serve")} in this campaign: ${parts.join(", ")}${unread}.`;
}

/** The money on the row is the campaign's, which holds keywords that land elsewhere. */
export const KEYWORD_LANDING_UPPER_BOUND =
  "The spend above is the whole campaign's, so it is an upper bound: the keywords that land on their own page are inside it.";
/** The keyword list could not be read, so the row is judged on the ads alone. */
export const KEYWORD_PAGES_NOT_READ =
  "Which keywords carry a page of their own could not be read this run, so this is judged on the ads alone.";
/** No serving keywords in the campaign to count. */
export const KEYWORDS_NONE_IN_CAMPAIGN =
  "No keyword in this campaign could be matched to its ads here, so this is judged on the ads alone.";
/** Brand patterns absent. */
export const BRAND_NOT_READ =
  "The client's own name was not available to this run, so a keyword that is the brand is counted as landing on the front page.";

export interface ReadinessInput {
  campaigns: Array<{ id: string; name: string; costMicros: number; channelType: string | null }>;
  /** Enabled ads and where they send a click. Empty = none were read. */
  destinations: AdDestination[];
  /** Enabled conversion actions. NULL = the read failed, [] = there are none. */
  conversionActions: ConversionActionRow[] | null;
  phone: PhoneDemandFacts | null | undefined;
  /** Spend floor a campaign must clear, in micros, so a parked campaign does
   *  not produce a row. Passed in rather than re-declared: it is
   *  THRESHOLDS.campaignMinSpendMicros and there must be one of it. */
  campaignMinSpendMicros: number;
  /** Days the evidence window covers, so a 90-day spend can be said as a
   *  monthly one without a second opinion about what a month is. */
  windowDays: number;
  /**
   * Every keyword the account holds, with its own landing page. NULL OR ABSENT
   * = not read, and the check then behaves exactly as it did before keywords
   * were consulted: judged on the ads alone, and saying so.
   */
  keywords?: KeywordLanding[] | null;
  /**
   * The client's own name, aliases and domain label, lowercased — the part of
   * the protected list the CLIENT did not have to type. A keyword that is
   * one of these landing on the front page is the correct landing, because the
   * front page is what somebody searching for the company is looking for.
   * NULL OR ABSENT = not read, and no keyword is let through as a brand.
   */
  brandPatterns?: string[] | null;
}

const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;

/**
 * Pure. One account, the checks it can answer.
 *
 * Every check returns a row whatever its answer — `clear` and `cant_tell`
 * included — and the caller decides which become findings. That is rule 3:
 * "we found nothing" and "we could not look" are different answers and merging
 * them is how an account with no readable landing pages reads as healthy.
 */
export function trafficReadiness(i: ReadinessInput): ReadinessCheck[] {
  const out: ReadinessCheck[] = [];
  const monthly = (micros: number) => Math.round((micros / 10_000) * (30 / Math.max(1, i.windowDays)));

  // ── 1. Where the money is landing ────────────────────────────────────────
  const byCampaign = new Map<string, AdDestination[]>();
  for (const d of i.destinations) {
    byCampaign.set(d.campaignId, [...(byCampaign.get(d.campaignId) ?? []), d]);
  }
  for (const c of i.campaigns) {
    if (c.costMicros < i.campaignMinSpendMicros) continue;
    const ads = byCampaign.get(c.id) ?? [];
    if (ads.length === 0) continue;   // a campaign with no ads is `thin_ad_group`'s row, not this one
    const unread = ads.filter((a) => a.finalUrl == null).length;
    if (unread === ads.length) {
      out.push({
        key: "generic_landing_page", state: "cant_tell",
        campaignId: c.id, campaignName: c.name,
        title: `Where this campaign's ads send a click could not be read`,
        summary: "Nothing here can say whether the clicks this campaign is paying for land on a page that answers them.",
        lines: [`${ads.length} enabled ad(s), no final URL read on any of them`],
        metrics: { ads: ads.length, rootAds: 0, costMicros: c.costMicros },
        atStakeCents: null,
      });
      continue;
    }
    const read = ads.filter((a) => a.finalUrl != null);
    const roots = read.filter((a) => isSiteRoot(a.finalUrl as string));
    if (roots.length === read.length) {
      const urls = Array.from(new Set(read.map((a) => a.finalUrl as string))).slice(0, 3);
      // WHERE A CLICK ACTUALLY LANDS IS DECIDED BY THE KEYWORD FIRST. Every ad
      // here points at the front page, but a keyword with a Final URL of its
      // own overrides its ad, and a keyword that is the client's own name is
      // right to land on the front page. Both are counted, and only what is
      // left lands somewhere that cannot answer what was searched.
      const kwHere = i.keywords == null ? null : i.keywords.filter((k) => k.campaignId === c.id);
      const landing = kwHere && kwHere.length > 0 ? classifyKeywordLanding(kwHere, i.brandPatterns) : null;
      if (landing && landing.onFront === 0) {
        out.push({
          key: "generic_landing_page", state: "clear",
          campaignId: c.id, campaignName: c.name,
          title: `"${c.name}" sends its clicks to real pages, or to the front page where that is right`,
          summary: "",
          lines: [keywordLandingLine(landing), "The ads all point at the front page, and every keyword that can serve either carries a page of its own or is the client's own name."],
          metrics: { ads: read.length, rootAds: roots.length, costMicros: c.costMicros, keywords: landing.keywords, keywordsOwnPage: landing.ownPage, keywordsBrand: landing.brand, keywordsOnFront: 0 },
          atStakeCents: null,
          keywordLanding: landing,
        });
        continue;
      }
      out.push({
        key: "generic_landing_page", state: "open",
        campaignId: c.id, campaignName: c.name,
        title: `Every ad in "${c.name}" sends its clicks to the site's front page`,
        summary: "Somebody searched for one thing, paid for a click, and arrived on the page written to answer everything. "
          + "The page cannot repeat their words back, cannot carry the one form that matches what they asked for, and gives "
          + "Google nothing to judge the landing-page half of Ad Rank on — so the clicks cost more as well as converting less. "
          + "Nothing here proposes a page: which page, and what goes on it, is the work.",
        lines: [
          `${read.length} enabled ad(s) in this campaign, all pointing at the front page`,
          ...urls.map((u) => `sends to ${u}`),
          `${usd(c.costMicros)} spent over the window behind them`,
          ...(unread > 0 ? [`${unread} further ad(s) had no final URL to read`] : []),
          ...(landing ? [keywordLandingLine(landing), KEYWORD_LANDING_UPPER_BOUND] : []),
          ...(!landing && i.keywords != null ? [KEYWORDS_NONE_IN_CAMPAIGN] : []),
          ...(i.keywords == null ? [KEYWORD_PAGES_NOT_READ] : []),
          ...(landing && i.brandPatterns == null ? [BRAND_NOT_READ] : []),
        ],
        metrics: {
          ads: read.length, rootAds: roots.length, costMicros: c.costMicros,
          ...(landing ? { keywords: landing.keywords, keywordsOwnPage: landing.ownPage, keywordsBrand: landing.brand, keywordsOnFront: landing.onFront } : {}),
        },
        atStakeCents: monthly(c.costMicros),
        keywordLanding: landing,
      });
    } else {
      out.push({
        key: "generic_landing_page", state: "clear",
        campaignId: c.id, campaignName: c.name,
        title: `"${c.name}" sends its clicks to real pages`,
        summary: "",
        lines: [`${read.length - roots.length} of ${read.length} enabled ad(s) point at a page rather than the front page`],
        metrics: { ads: read.length, rootAds: roots.length, costMicros: c.costMicros },
        atStakeCents: null,
      });
    }
  }

  // ── 2. Can a phone call be counted at all ────────────────────────────────
  const accountSpend = i.campaigns.reduce((s, c) => s + c.costMicros, 0);
  if (i.conversionActions == null) {
    out.push({
      key: "call_tracking_absent", state: "cant_tell",
      campaignId: null, campaignName: null,
      title: "Whether this account can count a phone call could not be read",
      summary: "The account's conversion actions could not be read this run.",
      lines: ["conversion actions unread"],
      metrics: { phoneLeads: 0, totalLeads: 0 },
      atStakeCents: null,
    });
  } else if (i.phone?.phoneLeads == null || i.phone?.totalLeads == null) {
    out.push({
      key: "call_tracking_absent", state: "cant_tell",
      campaignId: null, campaignName: null,
      title: "How this client's enquiries arrive could not be read",
      summary: "Nothing here can say what share of their leads come in by phone, so it cannot say whether the conversion column is missing them.",
      lines: ["the client's own lead feed was not read"],
      metrics: { phoneLeads: 0, totalLeads: 0 },
      atStakeCents: null,
    });
  } else if (i.phone.totalLeads < CALL_TRACKING_MIN_LEADS) {
    out.push({
      key: "call_tracking_absent", state: "cant_tell",
      campaignId: null, campaignName: null,
      title: "Too few leads on record to say how this client's enquiries arrive",
      summary: "",
      lines: [`${i.phone.totalLeads} lead(s) captured over the window, under the ${CALL_TRACKING_MIN_LEADS} it takes to read a share`],
      metrics: { phoneLeads: i.phone.phoneLeads, totalLeads: i.phone.totalLeads },
      atStakeCents: null,
    });
  } else {
    const share = i.phone.phoneLeads / i.phone.totalLeads;
    const enabled = i.conversionActions.filter((a) => String(a.status ?? "ENABLED").toUpperCase() === "ENABLED");
    const callActions = enabled.filter((a) => CALL_CATEGORIES.has(String(a.category ?? "").toUpperCase()));
    if (share >= CALL_TRACKING_PHONE_SHARE && callActions.length === 0) {
      out.push({
        key: "call_tracking_absent", state: "open",
        campaignId: null, campaignName: null,
        title: `${Math.round(share * 100)}% of this client's enquiries arrive by phone and nothing in the account counts a call`,
        summary: "Not one enabled conversion action on this account is classified as a phone call, and most of the enquiries the "
          + "money is producing are calls. So the conversion column counts a minority of what the account actually delivers: "
          + "every cost per conversion on it is overstated, every campaign judged on it looks worse than it is, and the bidding "
          + "is optimising toward the smaller half of the outcome.",
        lines: [
          `${i.phone.phoneLeads} of ${i.phone.totalLeads} lead(s) over the window arrived as a phone call`,
          `${enabled.length} enabled conversion action(s), none of them classified as a call`,
          `${usd(accountSpend)} spent over the window with the calls it produced uncounted`,
        ],
        metrics: {
          phoneLeads: i.phone.phoneLeads, totalLeads: i.phone.totalLeads,
          enabledActions: enabled.length, callActions: 0, costMicros: accountSpend,
        },
        atStakeCents: monthly(accountSpend),
      });
    } else {
      out.push({
        key: "call_tracking_absent", state: "clear",
        campaignId: null, campaignName: null,
        title: callActions.length > 0 ? "This account counts phone calls" : "Phone is a minority of this client's enquiries",
        summary: "",
        lines: [`${i.phone.phoneLeads} of ${i.phone.totalLeads} lead(s) by phone · ${callActions.length} call conversion action(s)`],
        metrics: {
          phoneLeads: i.phone.phoneLeads, totalLeads: i.phone.totalLeads,
          enabledActions: enabled.length, callActions: callActions.length, costMicros: accountSpend,
        },
        atStakeCents: null,
      });
    }
  }

  return out;
}

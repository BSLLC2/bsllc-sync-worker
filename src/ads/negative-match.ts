/**
 * Does a negative keyword already block this query?
 *
 * Pure. Facts in, one answer out, in the style of `bid-target.ts` and
 * `service-relevance.ts` next door.
 *
 * ── WHERE THIS COMES FROM ────────────────────────────────────────────────────
 *
 * OCH's account is worked through Google Ads Editor imports, not through the
 * approve queue here, so a negative somebody added on 5 October never passed
 * through this system and the findings on that account kept describing a
 * world from before it. The waste rule has always asked "is this term already
 * negated" and dropped the proposal when so (`alreadyNegated` in rules.ts).
 * The OTHER rule that reads the same search-terms report — the one that says
 * "this query converted, make it a keyword" (`converting_search_term`) — never
 * asked. So on a live list it recommended making "cat house cincinnati",
 * "ccat house" and "cbh hamilton ohio" into keywords when a negative on that
 * very campaign already blocked each of them.
 *
 * ── THE MATCH TYPES ARE READ, WHERE THEY ARE KNOWN ──────────────────────────
 *
 * `alreadyNegated` reads every negative as a phrase because the negatives pull
 * was a flat list of texts, and being too generous there only ever costs a
 * proposal that would have been a duplicate. Here the cost runs the other way:
 * calling a query blocked when it is not drops a growth recommendation. So the
 * match type travels with the text, and the three types mean what Google says
 * they mean for a NEGATIVE keyword:
 *
 *   exact   [cat house]  blocks the query "cat house" and nothing longer.
 *   phrase  "cat house"  blocks any query holding those words together, in
 *                        that order.
 *   broad   cat house    blocks any query holding every one of the words, in
 *                        any order.
 *
 * Close variants (plurals, misspellings) are NOT matched by a negative, so
 * none is applied here. A match type this build could not decode is read as a
 * phrase — the same reading the waste rule makes of every negative — and the
 * sentence says so rather than naming a type it does not know.
 *
 * ── A SOURCE THIS RUN COULD NOT READ IS NAMED, NEVER ASSUMED EMPTY ─────────
 *
 * Three places hold a negative: the campaign itself, a shared list attached to
 * the campaign, and the account. The campaign read is the one the waste rule
 * stands on and its failure silences that rule. The other two only ever ADD
 * blocked queries, so a failed read of either means a blocked query may still
 * be listed — which is clutter, the cheap direction — and the run says which
 * source it could not see.
 *
 * WHAT IS STILL NOT READ: negatives set at the AD GROUP level. They are named
 * in the run's output on every account rather than left to be discovered.
 */

export type NegativeMatchType = "EXACT" | "PHRASE" | "BROAD" | "UNKNOWN";
export type NegativeSource = "campaign" | "shared_list" | "account";

export interface NegativeRule {
  /** Lowercased, as the platform holds it. */
  text: string;
  matchType: NegativeMatchType;
  source: NegativeSource;
  /** The shared list's own name, where the rule came from one. */
  listName?: string | null;
}

/** Letters and digits only, lowercased, split on everything else. The same
 *  fold `normalizeQueryText` applies — case, punctuation and spacing never
 *  change what a query says. Kept local so this module imports nothing. */
export function negTokens(s: string): string[] {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/** Pure. Does this one rule block this one query? */
export function negativeBlocks(term: string, rule: NegativeRule): boolean {
  const q = negTokens(term);
  const n = negTokens(rule.text);
  if (q.length === 0 || n.length === 0) return false;
  if (rule.matchType === "EXACT") {
    return q.length === n.length && q.every((t, i) => t === n[i]);
  }
  if (rule.matchType === "BROAD") {
    const have = new Set(q);
    return n.every((t) => have.has(t));
  }
  // PHRASE, and UNKNOWN read as a phrase: the words together, in order, as a
  // contiguous run, with anything allowed either side.
  for (let i = 0; i + n.length <= q.length; i++) {
    let hit = true;
    for (let j = 0; j < n.length; j++) if (q[i + j] !== n[j]) { hit = false; break; }
    if (hit) return true;
  }
  return false;
}

/** The first rule in the list that blocks the query, or null. Campaign rules
 *  are tried before shared-list ones and those before the account's, so the
 *  sentence names the narrowest place the block lives. */
export function firstBlockingNegative(term: string, rules: readonly NegativeRule[]): NegativeRule | null {
  const order: NegativeSource[] = ["campaign", "shared_list", "account"];
  for (const src of order) {
    for (const r of rules) if (r.source === src && negativeBlocks(term, r)) return r;
  }
  return null;
}

/** Everything the rules read about negatives, in one input. */
export interface NegativeRuleFacts {
  /**
   * Campaign-level negatives with their match types, per campaign id, with the
   * shared lists attached to each campaign folded in. NULL = the base read
   * failed, which makes everything that stands on it silent.
   */
  byCampaign: ReadonlyMap<string, NegativeRule[]> | null;
  /** Account-level negatives, which apply to every campaign. */
  account: NegativeRule[];
  /** Sources this run could not read, each named. Never empty-and-silent. */
  unread: string[];
}

/** The rules that apply to one campaign, or null where the base read failed. */
export function rulesForCampaign(f: NegativeRuleFacts | null | undefined, campaignId: string): NegativeRule[] | null {
  if (!f || f.byCampaign == null) return null;
  return [...(f.byCampaign.get(campaignId) ?? []), ...f.account];
}

// ── Shaping (pure; the adapter's rows in, the rules' shapes out) ────────────

type Decode = (v: unknown) => string;

const asType = (decoded: string): NegativeMatchType =>
  decoded === "EXACT" || decoded === "PHRASE" || decoded === "BROAD" ? decoded : "UNKNOWN";

const CRITERION_RN = /\/campaignCriteria\/(\d+)~/;

/** Campaign-level negatives, with their match types. Same placement rule as
 *  `shapeNegatives`: rows that arrive and none of which can be placed in a
 *  campaign are a systemic read failure, which is null and not an empty map. */
export function shapeCampaignNegativeRules(rows: any[] | null, decode: Decode): Map<string, NegativeRule[]> | null {
  if (rows == null) return null;
  const by = new Map<string, NegativeRule[]>();
  let any = 0;
  let placed = 0;
  for (const r of rows) {
    const text = String(r?.campaign_criterion?.keyword?.text ?? "").trim().toLowerCase();
    if (!text) continue;
    any += 1;
    const id = String(r?.campaign?.id ?? "")
      || CRITERION_RN.exec(String(r?.campaign_criterion?.resource_name ?? ""))?.[1]
      || "";
    if (!id) continue;
    placed += 1;
    const rule: NegativeRule = {
      text, matchType: asType(decode(r?.campaign_criterion?.keyword?.match_type)), source: "campaign",
    };
    by.set(id, [...(by.get(id) ?? []), rule]);
  }
  if (any > 0 && placed === 0) return null;
  return by;
}

/**
 * Shared negative keyword lists, attached to the campaigns they are attached to.
 *
 * Two reads joined here: which lists each campaign uses, and what each list
 * holds. A list attached to nobody blocks nothing and is ignored. Either read
 * being null makes the whole source unread, because half a join is a list of
 * rules attached to nothing.
 */
export function shapeSharedNegativeRules(
  attachments: any[] | null,
  criteria: any[] | null,
  decode: Decode,
): Map<string, NegativeRule[]> | null {
  if (attachments == null || criteria == null) return null;
  const campaignsOf = new Map<string, string[]>();
  for (const a of attachments) {
    const setId = String(a?.shared_set?.id ?? "");
    const campaignId = String(a?.campaign?.id ?? "");
    if (!setId || !campaignId) continue;
    campaignsOf.set(setId, [...(campaignsOf.get(setId) ?? []), campaignId]);
  }
  const by = new Map<string, NegativeRule[]>();
  for (const c of criteria) {
    const text = String(c?.shared_criterion?.keyword?.text ?? "").trim().toLowerCase();
    const setId = String(c?.shared_set?.id ?? "");
    if (!text || !setId) continue;
    const rule: NegativeRule = {
      text,
      matchType: asType(decode(c?.shared_criterion?.keyword?.match_type)),
      source: "shared_list",
      listName: c?.shared_set?.name ? String(c.shared_set.name) : null,
    };
    for (const campaignId of campaignsOf.get(setId) ?? []) {
      by.set(campaignId, [...(by.get(campaignId) ?? []), rule]);
    }
  }
  return by;
}

/** Account-level negatives. Null where the read failed. */
export function shapeAccountNegativeRules(rows: any[] | null, decode: Decode): NegativeRule[] | null {
  if (rows == null) return null;
  const out: NegativeRule[] = [];
  for (const r of rows) {
    const text = String(r?.customer_negative_criterion?.keyword?.text ?? "").trim().toLowerCase();
    if (!text) continue;
    out.push({ text, matchType: asType(decode(r?.customer_negative_criterion?.keyword?.match_type)), source: "account" });
  }
  return out;
}

/**
 * Put the three sources together.
 *
 * The campaign read is the base. Where it failed the facts say so (`byCampaign`
 * null) whatever else came back. A shared-list or account read that failed is
 * NAMED in `unread` and the rules go on without it.
 */
export function combineNegativeRules(
  campaign: Map<string, NegativeRule[]> | null,
  shared: Map<string, NegativeRule[]> | null,
  account: NegativeRule[] | null,
): NegativeRuleFacts {
  const unread: string[] = [];
  if (shared == null) unread.push("shared negative keyword lists");
  if (account == null) unread.push("account-level negatives");
  if (campaign == null) return { byCampaign: null, account: account ?? [], unread };
  const merged = new Map<string, NegativeRule[]>();
  for (const [id, rules] of campaign) merged.set(id, [...rules]);
  if (shared) for (const [id, rules] of shared) merged.set(id, [...(merged.get(id) ?? []), ...rules]);
  return { byCampaign: merged, account: account ?? [], unread };
}

// ── Sentences, every one in this block ─────────────────────────────────────

const TYPE_WORD: Record<NegativeMatchType, string> = {
  EXACT: "exact", PHRASE: "phrase", BROAD: "broad", UNKNOWN: "phrase",
};

const WHERE_WORD = (r: NegativeRule): string =>
  r.source === "campaign" ? "on this campaign"
    : r.source === "account" ? "on the account"
      : r.listName ? `in the shared list "${r.listName}"` : "in a shared list on this campaign";

/** "the phrase negative "cat house" on this campaign". */
export function blockingNegativePhrase(r: NegativeRule): string {
  const unknown = r.matchType === "UNKNOWN" ? " (read as a phrase)" : "";
  return `the ${TYPE_WORD[r.matchType]} negative "${r.text}"${unknown} ${WHERE_WORD(r)}`;
}

/** What the run prints, per campaign, for queries it did not recommend. */
export function blockedPromotionLine(campaignName: string, n: number, byNegative: { text: string; matchType: NegativeMatchType; count: number }[]): string {
  const names = byNegative.slice(0, 4).map((b) => `"${b.text}" (${TYPE_WORD[b.matchType]}, ${b.count})`).join(", ");
  const rest = byNegative.length > 4 ? ` and ${byNegative.length - 4} more` : "";
  return `${campaignName}: ${n} converting quer${n === 1 ? "y" : "ies"} not recommended as a keyword because a negative already blocks ${n === 1 ? "it" : "them"}: ${names}${rest}.`;
}

/** Said on the converting-search-term row when a negative source was unread. */
export function negativeSourcesUnreadLine(unread: readonly string[]): string {
  return `This run could not read ${unread.join(" or ")}, so a query one of them blocks can still be listed here. Check a query against the account before adding it.`;
}

/** Said in the run output on every account: the one source never read. */
export const AD_GROUP_NEGATIVES_NOT_READ =
  "Negatives set on an individual ad group are not read, so a query blocked only at that level can still be listed.";

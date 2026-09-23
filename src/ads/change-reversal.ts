/**
 * Going back — what a recorded window can and cannot put back.
 *
 * ── WHAT WAS ASKED, AND THE HONEST ANSWER ──────────────────────────────────
 *
 * "make sure we can have version histories somewhere and relaunch an old
 * version if things go badly however best to manage that."
 *
 * There is no version of an ad account to relaunch. Google Ads keeps no
 * snapshots and offers no restore: `change_event` is a log of what changed, it
 * is capped at THIRTY DAYS, and after that the record is deleted rather than
 * archived. Nothing in the API takes an account back to how it looked on a
 * Tuesday.
 *
 * So the shape that is actually available is REVERSING A RECORDED WINDOW: take
 * the changes captured between two times, work out what each one moved, and
 * propose putting those values back. That is strictly weaker than a restore
 * and the difference matters, so every sentence this module produces says
 * which of the two it is doing.
 *
 * ── THREE LAYERS OF "GOING BACK" ALREADY EXIST, AND THIS IS THE THIRD ──────
 *
 *   1. ONE CHANGE WE MADE. `rollbackChangeSet` in src/apply-ads-changes.ts,
 *      driven from the dashboard's own Roll back. It restores from the prior
 *      values captured at apply time, so it is exact — and it only ever covers
 *      a change that went through our approve queue.
 *   2. ONE CHANGE ANYBODY MADE, read back. `ads_change_events` (v194) records
 *      old and new values for changes Google reports, whoever made them, for
 *      up to thirty days.
 *   3. A WINDOW of (2), which is this file. It reads those stored events and
 *      proposes the reversal as ordinary findings, which a person approves one
 *      at a time and the existing guarded apply path performs.
 *
 * ── NOTHING HERE APPLIES ANYTHING ──────────────────────────────────────────
 *
 * This module is pure: facts in, one plan out. It holds no client, opens no
 * socket and writes no row. The plan becomes `ads_findings` at status
 * `proposed`, which is where every other proposal in this system starts, and
 * the propose/approve split is untouched. A reversal is itself a change: it
 * passes validate_only, the budget caps, the staleness guard and the protected
 * terms like anything else, its own prior values are captured before it is
 * written, and Google's change history records it in turn.
 *
 * ── THE STALENESS GUARD IS THE REASON THIS IS SAFE ─────────────────────────
 *
 * A budget reversal carries `fromDailyMicros` set to what the captured event
 * left the budget AT. If anybody has moved it since, the apply path refuses
 * the item and says so rather than overwriting their work with a stale figure.
 * That guard already exists and this leans on it rather than adding a second
 * one.
 *
 * ── A NULL IS UNANSWERED ───────────────────────────────────────────────────
 *
 * `ads_change_scans` says what was actually looked at. A window that reaches
 * past recorded coverage produces an INCOMPLETE plan, said in words, because a
 * reversal that reports success over a window nobody captured is the worst
 * possible failure here: it reads as "put back" and is not.
 */

/** One stored row of `ads_change_events`, as this module needs it. */
export interface StoredChange {
  eventKey: string;
  /** ISO. Never null — a row with no timestamp is never stored. */
  changedAt: string;
  resourceType: string | null;
  operation: string | null;
  changedFields: string | null;
  campaignId: string | null;
  adGroupId: string | null;
  oldResourceJson: string | null;
  newResourceJson: string | null;
}

/** What `ads_change_scans` says about this account. */
export interface ReversalCoverage {
  /** YYYY-MM-DD. Null where nothing has ever been captured. */
  coveredFrom: string | null;
  coveredTo: string | null;
  /** False where the last scan failed. Null where there is no scan row. */
  ok: boolean | null;
}

export interface ReversalFacts {
  windowStart: Date;
  windowEnd: Date;
  /** Every captured change on the account inside the window. */
  events: StoredChange[];
  coverage: ReversalCoverage;
  /**
   * Campaign id → campaign NAME. The guarded apply path addresses a campaign
   * by name and the change feed carries only an id, so the caller resolves
   * them. An id missing from this map is refused rather than guessed.
   */
  campaignNames: Record<string, string>;
}

/** Why one captured change cannot be put back from here. */
export const REVERSAL_REFUSALS = [
  "entity_not_supported",
  "field_not_supported",
  "no_prior_value",
  "campaign_name_unknown",
  "nets_to_nothing",
  "url_shape_unsupported",
  "budget_cap",
] as const;
export type ReversalRefusal = (typeof REVERSAL_REFUSALS)[number];

/**
 * The apply path's own caps, repeated here so a proposal that could only ever
 * be refused is named at plan time instead of failing at approval. THE GUARDS
 * THEMSELVES ARE NOT WEAKENED OR BYPASSED — these are read-only copies used to
 * warn, and src/apply-ads-changes.ts still enforces them.
 */
export const MAX_BUDGET_FACTOR = 2;
export const MAX_BUDGET_DELTA_USD = 100;

export function reversalRefusalLine(reason: ReversalRefusal, detail?: string | null): string {
  switch (reason) {
    case "entity_not_supported":
      return `Our apply path does not change this kind of thing${detail ? ` (${detail})` : ""}. Put it back in the platform by hand.`;
    case "field_not_supported":
      return `The field that moved is not one our apply path writes${detail ? ` (${detail})` : ""}. Put it back in the platform by hand.`;
    case "no_prior_value":
      return "Google's history recorded the change without the value it held before, so there is nothing here to put back. The old value is in the platform's own change history screen.";
    case "campaign_name_unknown":
      return "The campaign this happened in could not be named — it has most likely been removed since. A campaign that is gone cannot be changed back.";
    case "nets_to_nothing":
      return "It was made and undone again inside this window, so the account already holds what it held before.";
    case "url_shape_unsupported":
      return detail === "inherited"
        ? "The keyword had no final URL of its own before, and our apply path can only set one, not clear one. Clear it in the platform instead."
        : "The keyword had more than one final URL before, and our apply path writes exactly one. Put them back in the platform instead.";
    case "budget_cap":
      return `Putting this budget back would move it further than one run is allowed to (${MAX_BUDGET_FACTOR}x, or $${MAX_BUDGET_DELTA_USD} a day). Move it in steps, or in the platform.`;
  }
}

/** One thing this plan would put back, as the exact payload the guarded apply
 *  path takes. `op` is a ChangeSet key and nothing else. */
export interface ReversalItem {
  /** A person-readable label. Campaign names and keyword text only. */
  entity: string;
  /** What putting it back does, in plain words. */
  what: string;
  op: "budgets" | "campaignNegatives" | "removeCampaignNegatives" | "keywordFinalUrls";
  body: unknown;
  /** How many captured changes collapsed into this one proposal. */
  changes: number;
  /** Said where the reversal is wider or looser than the change was. */
  caution: string | null;
  /** The newest captured change behind it, for ordering and for the record. */
  latestAt: string;
}

export interface ReversalBlocked {
  entity: string;
  what: string;
  reason: ReversalRefusal;
  why: string;
}

export interface ReversalPlan {
  /** Newest change first, which is the order somebody undoing an afternoon
   *  reads them in. */
  reversible: ReversalItem[];
  blocked: ReversalBlocked[];
  /** True only where recorded coverage spans the whole window. */
  complete: boolean;
  /** Says which of the two it is, always. */
  coverageNote: string;
  /** One sentence. It never says the account was restored. */
  summary: string;
  /** How many captured changes the window held at all. */
  considered: number;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;

function parse(json: string | null): any | null {
  if (!json) return null;
  try { return JSON.parse(json); } catch { return null; }
}

/**
 * The changed resource, whichever of the oneof branches Google filled in.
 *
 * DECIDED FROM THE JSON PRESENT, NEVER FROM THE OPERATION ENUM. Google's
 * documentation on which operations populate `old_resource` and which populate
 * `new_resource` is not something this sandbox can verify, so reading the
 * payload that is actually there is both simpler and correct either way.
 */
function branch(resource: any, key: string): any | null {
  if (!resource || typeof resource !== "object") return null;
  return resource[key] ?? resource[key.replace(/_([a-z])/g, (_m, c) => c.toUpperCase())] ?? null;
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Keyword text out of a criterion branch, whichever casing came back. */
function keywordOf(criterion: any): { text: string | null; matchType: string | null } {
  const kw = criterion?.keyword ?? null;
  if (!kw) return { text: null, matchType: null };
  const text = typeof kw.text === "string" ? kw.text : null;
  const raw = kw.match_type ?? kw.matchType ?? null;
  // Enums arrive as integers over REST. An integer these do not know passes
  // through as its own digits rather than being guessed at — the same handling
  // src/ads/change-history.ts already applies to every other enum here.
  const MATCH: Record<string, string> = { "2": "EXACT", "3": "PHRASE", "4": "BROAD" };
  const key = raw == null ? null : String(raw);
  return { text, matchType: key ? (MATCH[key] ?? key) : null };
}

const finalUrlsOf = (criterion: any): string[] | null => {
  const v = criterion?.final_urls ?? criterion?.finalUrls ?? null;
  return Array.isArray(v) ? v.filter((u: unknown): u is string => typeof u === "string") : null;
};

/**
 * Work out what a window's captured changes would put back.
 *
 * Changes are COLLAPSED PER THING, not replayed one by one. A budget somebody
 * moved three times on Tuesday is one proposal back to what it held at the
 * start of the window, with one guard and one approval — which is what "go
 * back to Tuesday" means, and it is also the only shape the staleness guard
 * can check in a single step.
 */
export function planReversal(f: ReversalFacts): ReversalPlan {
  const inWindow = f.events
    .filter((e) => {
      const t = Date.parse(e.changedAt);
      return Number.isFinite(t) && t >= f.windowStart.getTime() && t <= f.windowEnd.getTime();
    })
    .sort((a, b) => Date.parse(a.changedAt) - Date.parse(b.changedAt));

  const reversible: ReversalItem[] = [];
  const blocked: ReversalBlocked[] = [];
  const seenBlocked = new Set<string>();
  const block = (entity: string, what: string, reason: ReversalRefusal, detail?: string | null) => {
    const key = `${entity}|${reason}|${detail ?? ""}`;
    if (seenBlocked.has(key)) return;
    seenBlocked.add(key);
    blocked.push({ entity, what, reason, why: reversalRefusalLine(reason, detail) });
  };

  // ── Campaign budgets ─────────────────────────────────────────────────────
  const budgetRuns = new Map<string, StoredChange[]>();
  // ── Campaign-level negative keywords ─────────────────────────────────────
  const negativeRuns = new Map<string, StoredChange[]>();
  // ── Keyword final URLs ───────────────────────────────────────────────────
  const urlRuns = new Map<string, StoredChange[]>();

  for (const e of inWindow) {
    const type = (e.resourceType ?? "").toUpperCase();
    const fields = (e.changedFields ?? "").toLowerCase();
    if (type === "CAMPAIGN_BUDGET") {
      if (fields && !fields.includes("amount_micros")) {
        block(campaignLabel(e, f), "a campaign budget setting changed", "field_not_supported", e.changedFields);
        continue;
      }
      push(budgetRuns, e.campaignId ?? `budget:${e.eventKey}`, e);
      continue;
    }
    if (type === "CAMPAIGN_CRITERION") {
      const crit = branch(parse(e.newResourceJson), "campaign_criterion") ?? branch(parse(e.oldResourceJson), "campaign_criterion");
      const kw = keywordOf(crit);
      if (!kw.text) {
        block(campaignLabel(e, f), "a campaign-level target changed", "entity_not_supported", "campaign targeting that is not a keyword");
        continue;
      }
      push(negativeRuns, `${e.campaignId ?? ""}|${kw.text.toLowerCase()}`, e);
      continue;
    }
    if (type === "AD_GROUP_CRITERION") {
      if (fields && !fields.includes("final_urls")) {
        block(keywordLabel(e), "a keyword setting changed", "field_not_supported", e.changedFields);
        continue;
      }
      const crit = branch(parse(e.oldResourceJson), "ad_group_criterion") ?? branch(parse(e.newResourceJson), "ad_group_criterion");
      const kw = keywordOf(crit);
      push(urlRuns, `${e.adGroupId ?? ""}|${(kw.text ?? e.eventKey).toLowerCase()}`, e);
      continue;
    }
    block(
      type === "AD" || type === "AD_GROUP_AD" ? "An ad" : type === "CAMPAIGN" ? campaignLabel(e, f) : type === "AD_GROUP" ? "An ad group" : "Something in the account",
      `${humanType(type)} changed`,
      "entity_not_supported",
      humanType(type),
    );
  }

  for (const [, run] of Array.from(budgetRuns)) {
    const first = run[0]!;
    const last = run[run.length - 1]!;
    const name = first.campaignId ? f.campaignNames[first.campaignId] ?? null : null;
    const label = name ? `Campaign "${name}"` : "A campaign budget";
    const was = num(branch(parse(first.oldResourceJson), "campaign_budget")?.amount_micros
      ?? branch(parse(first.oldResourceJson), "campaign_budget")?.amountMicros);
    const now = num(branch(parse(last.newResourceJson), "campaign_budget")?.amount_micros
      ?? branch(parse(last.newResourceJson), "campaign_budget")?.amountMicros);
    if (was == null) { block(label, "a campaign budget changed", "no_prior_value"); continue; }
    if (!name) { block(label, "a campaign budget changed", "campaign_name_unknown"); continue; }
    if (now != null && was === now) { block(label, "a campaign budget changed", "nets_to_nothing"); continue; }
    // The caps, read rather than enforced — the apply path is still the only
    // thing that enforces them, and it does so against the LIVE figure.
    if (now != null && (was > now * MAX_BUDGET_FACTOR || (was - now) / 1_000_000 > MAX_BUDGET_DELTA_USD)) {
      block(label, `a campaign budget moved from ${usd(was)} to ${usd(now)} a day`, "budget_cap");
      continue;
    }
    reversible.push({
      entity: label,
      what: `Put the daily budget back to ${usd(was)}${now != null ? `, from ${usd(now)}` : ""}.`,
      op: "budgets",
      body: [{
        campaign: name,
        newDailyUsd: was / 1_000_000,
        // THE STALENESS GUARD'S INPUT. Set to what the captured changes left
        // the budget at, so a budget somebody has moved again since is refused
        // at apply time rather than overwritten with a stale figure.
        fromDailyMicros: now ?? undefined,
        reason: `Putting back what this budget held on ${ymd(f.windowStart)}, before ${run.length} recorded change${run.length === 1 ? "" : "s"} in this window.`,
      }],
      changes: run.length,
      caution: now == null
        ? "Google's history did not record what this budget was left at, so the apply path will refuse this until the next audit works the figure out from the live account."
        : null,
      latestAt: last.changedAt,
    });
  }

  for (const [, run] of Array.from(negativeRuns)) {
    const first = run[0]!;
    const last = run[run.length - 1]!;
    const name = first.campaignId ? f.campaignNames[first.campaignId] ?? null : null;
    const created = branch(parse(last.newResourceJson), "campaign_criterion");
    const removedFrom = branch(parse(first.oldResourceJson), "campaign_criterion");
    const kw = keywordOf(created ?? removedFrom);
    const label = name ? `Negative "${kw.text}" on "${name}"` : `Negative "${kw.text}"`;
    if (!name) { block(label, "a negative keyword changed", "campaign_name_unknown"); continue; }
    const startedPresent = String(first.operation ?? "").toUpperCase() !== "CREATE";
    const endsPresent = String(last.operation ?? "").toUpperCase() !== "REMOVE";
    if (startedPresent === endsPresent) { block(label, "a negative keyword changed", "nets_to_nothing"); continue; }
    if (endsPresent) {
      reversible.push({
        entity: label,
        what: `Take the negative "${kw.text}" back off "${name}", so those searches can run again.`,
        op: "removeCampaignNegatives",
        body: [{ campaign: name, keywords: [kw.text!], reason: `Added during this window; putting the campaign back to how it was on ${ymd(f.windowStart)}.` }],
        changes: run.length,
        caution: null,
        latestAt: last.changedAt,
      });
    } else {
      const matchType = kw.matchType;
      if (!matchType) { block(label, "a negative keyword was removed", "no_prior_value"); continue; }
      reversible.push({
        entity: label,
        what: `Put the negative "${kw.text}" back on "${name}" as ${matchType}.`,
        op: "campaignNegatives",
        body: [{ campaign: name, matchType, keywords: [kw.text!], reason: `Removed during this window; putting the campaign back to how it was on ${ymd(f.windowStart)}.` }],
        changes: run.length,
        // The protected-term guard still runs over this at apply time and
        // aborts the whole run on a collision, which is the behaviour that
        // stops a brand term being blocked by accident.
        caution: null,
        latestAt: last.changedAt,
      });
    }
  }

  for (const [, run] of Array.from(urlRuns)) {
    const first = run[0]!;
    const last = run[run.length - 1]!;
    const crit = branch(parse(first.oldResourceJson), "ad_group_criterion");
    const kw = keywordOf(crit);
    const label = kw.text ? `Keyword "${kw.text}"` : "A keyword";
    const was = finalUrlsOf(crit);
    if (!kw.text) { block(label, "a keyword's landing page changed", "no_prior_value"); continue; }
    if (was == null) { block(label, "a keyword's landing page changed", "no_prior_value"); continue; }
    if (was.length === 0) { block(label, "a keyword's landing page changed", "url_shape_unsupported", "inherited"); continue; }
    if (was.length > 1) { block(label, "a keyword's landing page changed", "url_shape_unsupported", "several"); continue; }
    reversible.push({
      entity: label,
      what: `Point "${kw.text}" back at ${was[0]}.`,
      op: "keywordFinalUrls",
      body: [{ reason: `Putting back the landing page this keyword had on ${ymd(f.windowStart)}.`, map: [{ keyword: kw.text, url: was[0]! }] }],
      changes: run.length,
      // A real and stated limit: the op matches a keyword by TEXT across every
      // enabled ad group in the account, while the change happened in one.
      caution: "Our apply path finds a keyword by its text, so this reaches every enabled keyword reading the same in the account.",
      latestAt: last.changedAt,
    });
  }

  reversible.sort((a, b) => Date.parse(b.latestAt) - Date.parse(a.latestAt));

  // ── Coverage. A window nobody captured is never reported as reversed. ────
  const from = f.coverage.coveredFrom;
  const to = f.coverage.coveredTo;
  const complete = Boolean(
    from && to
    && Date.parse(`${from}T00:00:00Z`) <= f.windowStart.getTime()
    && Date.parse(`${to}T23:59:59Z`) >= f.windowEnd.getTime()
    && f.coverage.ok !== false,
  );
  const coverageNote = !from
    ? "No change history has been captured for this account, so this window is unknown here and nothing below is a full list of what moved."
    : complete
      ? `Change history covers ${from} to ${to}, so the whole of this window was recorded.`
      : f.coverage.ok === false
        ? `The last capture on this account failed, so coverage stops at ${to} and anything after it is unknown here.`
        : `Change history covers ${from} to ${to}, which does not span this window, so part of it is unknown here.`;

  const summary = summarise(reversible.length, blocked.length, inWindow.length, complete, f);
  return { reversible, blocked, complete, coverageNote, summary, considered: inWindow.length };
}

function push(m: Map<string, StoredChange[]>, key: string, e: StoredChange) {
  const list = m.get(key) ?? [];
  list.push(e);
  m.set(key, list);
}

function campaignLabel(e: StoredChange, f: ReversalFacts): string {
  const name = e.campaignId ? f.campaignNames[e.campaignId] : null;
  return name ? `Campaign "${name}"` : "A campaign";
}
const keywordLabel = (_e: StoredChange) => "A keyword";

function humanType(type: string): string {
  switch (type) {
    case "AD": case "AD_GROUP_AD": return "an ad";
    case "AD_GROUP": return "an ad group";
    case "CAMPAIGN": return "a campaign setting";
    case "AD_GROUP_BID_MODIFIER": return "a bid adjustment";
    case "ASSET": case "CAMPAIGN_ASSET": case "AD_GROUP_ASSET": case "CUSTOMER_ASSET": return "an asset";
    case "FEED": case "FEED_ITEM": case "CAMPAIGN_FEED": case "AD_GROUP_FEED": return "a feed";
    default: return "something";
  }
}

/**
 * THE SENTENCE, and it never claims a restore.
 *
 * It says how much of the window can be put back, how much cannot and why the
 * difference exists, and — where coverage is short — that the list itself is
 * incomplete. A reversal that reads as "the account is back where it was" when
 * part of the window was never captured is the failure this whole module is
 * shaped around.
 */
function summarise(ok: number, no: number, considered: number, complete: boolean, f: ReversalFacts): string {
  const window = `${ymd(f.windowStart)} to ${ymd(f.windowEnd)}`;
  if (!considered) {
    return complete
      ? `Nothing was recorded on this account between ${window}.`
      : `Nothing was recorded on this account between ${window}, and the history does not cover the whole of it, so that is not the same as nothing having happened.`;
  }
  const head = `${considered} change${considered === 1 ? "" : "s"} recorded between ${window}: ${ok} can be proposed back, ${no} cannot.`;
  const tail = complete
    ? " Approving all of them puts those values back; it does not restore the account, because nothing outside this list was ever recorded as changeable from here."
    : " The history does not cover the whole window, so this is part of what moved and not all of it.";
  return head + tail;
}

/**
 * Why this account has no growth findings, on the queue, where somebody reads it.
 *
 * Pure. Facts in, one reading out, in the style of `shared/data-gaps.ts` in the
 * app repo: nothing is ticked, nothing can be dismissed, and the run that finds
 * the input recorded simply does not produce the row.
 *
 * ── THE DEFECT, AND IT IS THE BIGGEST ONE HERE ────────────────────────────
 *
 * The company owner, on a queue of fifteen live findings: "i still don't think
 * we're seeing growth opportunities just optimization."
 *
 * The growth rules were not missing. Three of them — `keyword_gap`,
 * `converting_search_term` and `headroom` — ran on that account, on that run,
 * and each REFUSED, correctly, for a reason it could state precisely:
 *
 *   keyword_gap            nobody has confirmed what this client sells, and two
 *                          derived candidates are sitting unticked
 *   converting_search_term one conversion action counts page views, so a query
 *                          that "converted" did not necessarily produce anything
 *   headroom               no cost per conversion could be read off that same
 *                          column, so there is no margin to measure
 *
 * Every one of those refusals was written down, in a sentence, in the reading
 * that made it. And then it was DROPPED ON THE FLOOR. `rules.ts` iterates
 * `gaps.services` and `promotions.byCampaign` and pushes a finding per entry;
 * where the list is empty there is no entry, so there is no row, so the
 * refusal never leaves the process. Nothing in this repo reads `gaps.silence`
 * or `promotions.silence` at all.
 *
 * So the owner's screen was not wrong and the engine was not broken. The
 * engine had three answers ready and no way to say them. An account whose
 * growth readings are all blocked looks exactly like an account with no growth
 * available — and those are opposite situations with opposite responses.
 *
 * ── WHAT THIS IS NOT ──────────────────────────────────────────────────────
 *
 * It is NOT a growth finding and must never be mistaken for one. It claims no
 * money, no leads and no opportunity, because it has no idea whether there is
 * one — that is the entire point. `estImpactCents` is nought and the rank
 * basis is `none`: not `unpriced`, because `unpriced` means a recorded figure
 * would put this row in the money order, and no figure would. This row is
 * about the QUESTION being unanswerable.
 *
 * ── SILENCE IS NOT A PASS, BUT A HEALTHY SILENCE IS ───────────────────────
 *
 * A reading that refused because there is genuinely nothing there — a campaign
 * taking 93% of its impressions, a services list with every term already
 * covered — is a GOOD answer and produces nothing here. Only a silence
 * somebody could END is reported, and each one names the person who would end
 * it and the thing they would do. A row that says "we could not look" with no
 * way to change that is furniture.
 */

/** One growth reading that had nothing to say, and whether that is fixable. */
export interface GrowthSilenceFact {
  /** The finding type the reading would have produced. Stable, and it is what
   *  lets somebody match the row against the queue's own type filter. */
  findingType: string;
  /** What the reading is for, in the words a person uses. */
  label: string;
  /** The reading's OWN verdict string, verbatim. Never re-derived here. */
  verdict: string;
  /** The reading's OWN silence sentence, verbatim. This module never rewrites
   *  a refusal: the reading that made it is the only thing that knows why. */
  silence: string | null;
  /** True where somebody could end this silence. False where the reading
   *  simply found nothing, which is a healthy answer and not a gap. */
  fixable: boolean;
  /** The one thing that would end it, in a person's words. Null where nothing
   *  would — and then `fixable` is false. */
  unlock: string | null;
  /** Who does that thing. `us` = this agency, `client` = the client must
   *  answer, `build` = it does not exist and somebody has to make it. The same
   *  three the app's own `shared/data-gaps.ts` uses. */
  owner: "us" | "client" | "build" | null;
}

export interface GrowthSilenceInput {
  accountId: string;
  accountName: string;
  facts: GrowthSilenceFact[];
  /** Account spend over the window. A dormant account is not told its growth
   *  readings are blocked; nobody is going to act on it. */
  accountCostMicros: number;
  minSpendMicros: number;
  /** How many growth findings the run DID produce. A row still appears where
   *  some fired and others are blocked — "we found two and could not look for
   *  three" is a truer sentence than either half — but the count changes what
   *  it says. */
  growthFindingsRaised: number;
}

export type GrowthSilenceVerdict =
  /** Every growth reading on this account is blocked, and each is fixable. */
  | "all_blocked"
  /** Some fired, some are blocked. */
  | "partly_blocked"
  /** Nothing is blocked, or nothing blocked is fixable. No row. */
  | "clear"
  /** Too little spend for anybody to act on this. No row. */
  | "too_small";

export interface GrowthSilenceReading {
  verdict: GrowthSilenceVerdict;
  /** The fixable silences, in the order they were given. Never re-sorted by
   *  anything computed: the caller lists them cheapest-to-answer first, and a
   *  list that sorts itself is a list you have to read twice. */
  blocked: GrowthSilenceFact[];
  /** Readings that refused because there is genuinely nothing there. Counted,
   *  never listed — "we looked and found nothing" is one fact about the
   *  account, not one row per reading. */
  healthySilences: number;
  title: string;
  summary: string;
  lines: string[];
  metrics: Record<string, number>;
  silence: string | null;
}

/**
 * Pure. One account's answer.
 *
 * `clear` and `too_small` are SILENT. An account whose growth readings all
 * produced something needs no row saying so, and an account nobody is spending
 * on needs no homework.
 */
export function growthSilenceReading(i: GrowthSilenceInput): GrowthSilenceReading {
  const healthySilences = i.facts.filter((f) => !f.fixable && f.silence != null).length;
  const base = {
    blocked: [] as GrowthSilenceFact[], healthySilences,
    title: "", summary: "", lines: [] as string[],
    metrics: {} as Record<string, number>,
  };

  if (i.accountCostMicros < i.minSpendMicros) {
    return { ...base, verdict: "too_small",
      silence: "No row: this account is under the spend floor at which anybody would act on a list of blocked readings." };
  }

  // A fact is only reported where somebody could END it. `fixable` is the
  // reading's own answer and is never inferred from the verdict string here —
  // two answers to one question is how this engine starts disagreeing with
  // itself, and the reading is the only thing that knows which of its
  // refusals a person can do something about.
  const blocked = i.facts.filter((f) => f.fixable && f.unlock != null);
  if (blocked.length === 0) {
    return { ...base, verdict: "clear",
      silence: "No row: every growth reading on this account either produced something or refused because there is genuinely nothing there, which is an answer rather than a gap." };
  }

  const allBlocked = i.growthFindingsRaised === 0;
  const n = blocked.length;
  const ours = blocked.filter((f) => f.owner === "us").length;
  const theirs = blocked.filter((f) => f.owner === "client").length;

  const title = allBlocked
    ? `Nothing on this account can say where growth is — ${n} reading${n === 1 ? "" : "s"} blocked, ${n === 1 ? "and it is" : "and all of them are"} answerable`
    : `${n} of this account's growth reading${n === 1 ? "" : "s"} could not run, so the queue is showing less than there is`;

  const summary = (allBlocked
    ? `Every rule on this account that looks for MORE — demand it is not bidding on, queries that already convert, campaigns cheap enough to buy more of — `
      + `ran this week and refused. None of them refused because there is nothing there. Each refused because a figure it needs is not recorded, `
      + `so a queue of nothing but waste and repairs is what this account looks like whether or not there is growth on it. `
    : `Some growth readings produced rows this week and ${n} did not, and none of the ${n} refused because there is nothing there. `
      + `Each refused because a figure it needs is not recorded, so what is on the queue is less than what is on the account. `)
    + `Each line below names the reading, what it refused on in its own words, and the one thing that would end it. `
    + `Nothing here claims there IS growth on this account — it claims nobody can currently tell, which is a different and more fixable problem. `
    + `Nothing is applied and nothing is ticked: record the figure and the row stops appearing.`;

  const lines: string[] = [];
  for (const f of blocked) {
    lines.push(`${f.label} — ${f.silence ?? "refused with no reason recorded, which is itself a defect"}`);
    lines.push(`   → ${f.unlock}${f.owner === "client" ? " (the client has to answer this)" : f.owner === "build" ? " (this does not exist yet and has to be built)" : " (ours to do)"}`);
  }
  if (healthySilences > 0) {
    lines.push(`${healthySilences} further growth reading(s) refused because there is genuinely nothing there, which is an answer and is not listed.`);
  }

  return {
    verdict: allBlocked ? "all_blocked" : "partly_blocked",
    blocked,
    healthySilences,
    title,
    summary,
    lines,
    metrics: {
      blockedReadings: n,
      readingsOnUs: ours,
      readingsOnClient: theirs,
      healthySilences,
      growthFindingsRaised: i.growthFindingsRaised,
      accountCostMicros: i.accountCostMicros,
    },
    silence: null,
  };
}

/**
 * The one sentence this row's figure column carries.
 *
 * It claims nothing, and says so in the words `impact-rank.ts` uses for a
 * `none` basis: the difference between `none` and `unpriced` is whether a
 * recorded figure would change the answer, and no figure would put THIS row
 * in a money order. Recording the figures it names is what makes the rows it
 * is standing in for appear — with figures of their own.
 */
export function growthSilenceClaim(r: GrowthSilenceReading): string {
  if (r.verdict !== "all_blocked" && r.verdict !== "partly_blocked") {
    return r.silence ?? "No figure claimed.";
  }
  return "No figure, and not one that is missing either. This row is not an opportunity and must not be read as one — it is the reason the "
    + "opportunities cannot be counted. Answering what it names is what produces the rows that DO carry figures, each projected from this "
    + "account's own numbers rather than from anything assumed here.";
}

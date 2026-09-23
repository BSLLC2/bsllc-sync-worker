/**
 * One measure, so a queue can be ordered by what actually matters.
 *
 * Pure. One finding and the client's own economics in, one reading out.
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────
 *
 * The queue sorts on `est_impact_cents` alone, and that column no longer holds
 * one thing. Since version 5 it carries dollars a month on a waste row, LEADS
 * a month on a headroom row (`impactUnit: "leads_month"`, leads × 100), and
 * nought on every row that deliberately claims nothing. A single-column sort
 * over three units puts a $645 saving above a growth finding worth three times
 * it and below one claiming nothing at all, and every rule added from here
 * makes it worse.
 *
 * ── THE COMMON MEASURE: MONEY A MONTH, AND WHAT IT ASSUMES ────────────────
 *
 * `rankCents` is cents a month, on every finding that can reach one. Getting
 * there from a leads figure needs what a lead is worth to THIS client, which
 * is `customer value × close rate` — both recorded on the client, both null on
 * a good share of this book. The conversion is composed from `costTargets`'s
 * `modelled` basis rather than worked out again here, so a lead is worth the
 * same in a rank as it is in a cost target.
 *
 * ── THREE KINDS OF CLAIM, NEVER ADDED, NEVER SILENTLY EQUAL ───────────────
 *
 * The figure is one number. What it MEANS is three different things, and the
 * basis word travels with the figure everywhere it is printed — the row, the
 * queue, the brief — so nobody reads a forecast as a fact:
 *
 *  recoverable — money going out now that stopping this keeps. Read off the
 *                account, haircut where the rule that produced it says so.
 *  projected   — money that could come in, worked out through the client's own
 *                close rate and customer value. A forecast, and it says so.
 *  at_stake    — money already flowing through the thing this row is about.
 *                It claims NO gain and NO saving; it says how big the thing is.
 *
 * They are never summed. Nothing in this engine adds two findings' figures
 * together, and nothing may start to — a total over three bases is a number
 * that answers no question.
 *
 * ── at_stake IS HOW A ROW THAT CLAIMS NOTHING RANKS HONESTLY ──────────────
 *
 * `converting_search_term` refuses a dollar figure on purpose: the conversions
 * already happen, so pricing them as the gain from promoting the query counts
 * the same conversion twice. That refusal is right and is not relaxed here.
 * But "claims no gain" is not "does not matter", and leaving it at nought puts
 * the clearest growth signal a search account has at the bottom of every queue
 * forever. What it ranks on is the money ALREADY riding on the query — spend
 * flowing through a keyword nobody chose, at a bid nobody set. That is a
 * measured figure about the size of the thing and it claims nothing about a
 * gain, which is exactly what the basis word says.
 *
 * ── WHERE THE CLIENT'S ECONOMICS ARE MISSING ──────────────────────────────
 *
 * The figure is null, the basis is `unpriced`, and `blockedBy` NAMES the
 * figure nobody recorded. In `sequenceFindings` such a row contributes nothing
 * to its group's position and is neither sunk nor floated: it keeps its
 * campaign group and its stage, so a person reads it with the rest of that
 * campaign's work.
 *
 * The dashboard's own list is FLAT and has no groups to keep it in, so there it
 * sorts last and the screen carries `ADS_RANK_UNPRICED_NOTE` naming the figure
 * that would put it in the order. Last with a sentence saying why is not the
 * same as buried, and a finding ranked last because nobody typed a number and
 * nothing said so is a finding nobody ever does.
 *
 * ── STAGE AND RANK ────────────────────────────────────────────────────────
 *
 * They answer different questions and both survive. Stage (`sequence.ts`) is a
 * CORRECTNESS rule about one campaign: stop the money going out for nothing
 * before you fund more of it. Rank is a PRIORITY rule across the board: which
 * campaign's work is worth reading first. So stage constrains order WITHIN a
 * group and rank orders the groups against each other — which is what
 * `sequenceFindings` already did, with the size of one column swapped for a
 * figure that means the same thing on every row.
 */

// TYPES ONLY, and deliberately. `rules.ts` imports `rankImpact` from here, so
// a value import back the other way would be a runtime cycle; `import type` is
// erased at compile time and there is none. The one thing this needs from that
// module at runtime — what a lead is worth — is PASSED IN as the cost targets
// `rules.ts` has already worked out, so a lead is worth the same in a rank as
// it is in every cost target this engine prints rather than being computed
// twice from the same columns.
import type { DerivedFinding, ClientEconomics, CostTarget } from "./rules.js";

export const RANK_BASES = ["recoverable", "projected", "at_stake", "unpriced", "none"] as const;
export type RankBasis = (typeof RANK_BASES)[number];

/**
 * What each finding type's figure IS.
 *
 * Declared per type, in one map, for `FINDING_STAGE`'s reason: a basis is a
 * statement about what the number means, and inferring it from `impactUnit`,
 * severity or whether a change payload exists would be three answers that
 * disagree the first time a rule changes.
 */
export const RANK_BASIS: Record<string, RankBasis> = {
  // Money leaving now that stopping this keeps. Each already carries its own
  // haircut and its own assumption sentence; nothing is haircut twice here.
  wasted_search_term: "recoverable",
  dead_keyword: "recoverable",
  cpa_above_target: "recoverable",

  // Money that could come in, through the client's own close rate and value.
  budget_limited: "projected",
  headroom: "projected",
  // v7. Searches this account already bids on and is losing to Ad Rank, sized
  // from its own impression share, click-through rate and — where the column
  // can be read — its own conversion rate. A forecast of a change nobody has
  // made. NEVER `recoverable`: nothing here is money leaving the account now.
  unmet_demand: "projected",

  // Money already flowing through the thing the row is about. No gain claimed.
  //
  // `bid_target_absent` is at_stake rather than recoverable, which is where it
  // parts company with the `cpa_above_target` row it replaces. Stopping a
  // wasted search term keeps the money it was spending. Setting a cost target
  // buys fewer conversions as well as cheaper ones, and how many fewer is not
  // knowable from anything on the row — so the figure is the size of the gap
  // and not a saving.
  bid_target_absent: "at_stake",
  no_conversions: "at_stake",
  converting_search_term: "at_stake",
  keyword_gap: "at_stake",
  generic_landing_page: "at_stake",
  call_tracking_absent: "at_stake",
};

/**
 * A type nobody has placed claims no money and is not given one.
 *
 * `none` rather than `unpriced`: the difference is whether a recorded figure
 * would change the answer. A conversion-tracking gap has no size in money and
 * never will; a headroom row on a client with no customer value has one that
 * nobody has written down. Two different sentences, two different fixes.
 */
export const DEFAULT_RANK_BASIS: RankBasis = "none";

export function rankBasisOf(findingType: string): RankBasis {
  return RANK_BASIS[findingType] ?? DEFAULT_RANK_BASIS;
}

export interface RankReading {
  /** Cents a month, comparable across findings. Null on `unpriced`/`none`. */
  cents: number | null;
  basis: RankBasis;
  /** The sentence that travels with the figure. Empty on `none`. */
  why: string;
  /** The recorded figure that would let this be compared. Null where nothing
   *  would — a `none` row is not waiting on anybody. */
  blockedBy: string | null;
}

/** What a lead is worth to this client, in cents, or null where nobody has
 *  said. Read off the `modelled` cost target rather than recomputed. */
export function leadValueCents(targets: CostTarget[]): number | null {
  const modelled = targets.find((t) => t.basis === "modelled");
  return modelled ? modelled.cents : null;
}

/** Which recorded figure is missing, said in the words the client page uses. */
function missingEconomics(e: ClientEconomics | null | undefined): string {
  const missing: string[] = [];
  if (!e || e.customerValueCents == null || e.customerValueCents <= 0) missing.push("what one customer is worth to them");
  if (!e || e.closeRatePct == null || e.closeRatePct <= 0) missing.push("their lead-to-customer close rate");
  return missing.length === 2
    ? "Nobody has recorded what one customer is worth to this client or their close rate, so a leads figure cannot be turned into money and this row cannot be compared with the rest."
    : `Nobody has recorded ${missing[0]}, so a leads figure cannot be turned into money and this row cannot be compared with the rest.`;
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * Pure. One finding, one place in the order.
 *
 * `atStakeCents` is passed in rather than parsed back off the finding, because
 * a row's "how big is this" figure is not always its `estImpactCents` — on a
 * `converting_search_term` that column is deliberately nought, and reading
 * nought as the size would be the defect this module exists to fix.
 */
export function rankImpact(
  f: Pick<DerivedFinding, "findingType" | "estImpactCents" | "impactUnit">,
  targets: CostTarget[],
  economics: ClientEconomics | null | undefined,
  atStakeCents: number | null,
): RankReading {
  const basis = rankBasisOf(f.findingType);

  if (basis === "none") {
    return { cents: null, basis, why: "", blockedBy: null };
  }

  if (basis === "at_stake") {
    if (atStakeCents == null || atStakeCents <= 0) {
      return {
        cents: null, basis: "unpriced",
        why: "Nothing here could put a size on this row, so it is read with its own campaign's work rather than against the rest of the queue.",
        blockedBy: null,
      };
    }
    return {
      cents: atStakeCents, basis,
      why: `${money(atStakeCents)} a month is already riding on this. It is the size of what this row is about — not a saving and not a gain.`,
      blockedBy: null,
    };
  }

  if (basis === "recoverable") {
    const cents = f.impactUnit === "usd_month" ? f.estImpactCents : 0;
    if (!cents || cents <= 0) {
      return {
        cents: null, basis: "unpriced",
        why: "This row claims no figure this run, so it is read with its own campaign's work rather than against the rest of the queue.",
        blockedBy: null,
      };
    }
    return {
      cents, basis,
      why: `${money(cents)} a month is money going out now that this would keep. The assumption behind it is on the row.`,
      blockedBy: null,
    };
  }

  // projected
  if (f.impactUnit === "usd_month") {
    // budget_limited already does the leads-to-money arithmetic itself, and it
    // claims nothing at all where the client has no modelled lead value — so a
    // nought here is the rule refusing, not a small number.
    if (!f.estImpactCents || f.estImpactCents <= 0) {
      return {
        cents: null, basis: "unpriced",
        why: missingEconomics(economics), blockedBy: leadValueCents(targets) == null ? "a lead value for this client" : null,
      };
    }
    return {
      cents: f.estImpactCents, basis,
      why: `${money(f.estImpactCents)} a month, projected from this client's own recorded close rate and customer value. A forecast of a change nobody has made yet, not money on the record.`,
      blockedBy: null,
    };
  }

  // leads_month → money, through the client's own figures or not at all.
  const leads = f.estImpactCents / 100;
  const perLead = leadValueCents(targets);
  if (perLead == null) {
    return {
      cents: null, basis: "unpriced",
      why: missingEconomics(economics), blockedBy: "a lead value for this client",
    };
  }
  const cents = Math.round(leads * perLead);
  if (cents <= 0) {
    return {
      cents: null, basis: "unpriced",
      why: "This row projects no extra leads this run, so there is nothing to compare.", blockedBy: null,
    };
  }
  return {
    cents, basis,
    why: `${leads.toFixed(1)} extra leads a month at ${money(perLead)} each — this client's own recorded customer value at their own recorded close rate — is ${money(cents)} a month. A forecast of a change nobody has made yet, not money on the record.`,
    blockedBy: null,
  };
}

/** The word a figure is printed with. Never a figure on its own. */
export const RANK_BASIS_LABEL: Record<RankBasis, string> = {
  recoverable: "recoverable",
  projected: "projected",
  at_stake: "at stake",
  unpriced: "not comparable",
  none: "no figure",
};

/**
 * A figure and its basis, together, in one string.
 *
 * There is no call anywhere that emits a bare rank figure: this is the only
 * formatter, and it takes the basis. A number on a queue that does not say
 * whether it is money saved, money forecast or money already moving is three
 * different claims wearing one font.
 */
export function rankedAmount(r: Pick<RankReading, "cents" | "basis">): string {
  if (r.cents == null) return RANK_BASIS_LABEL[r.basis];
  return `${money(r.cents)}/mo ${RANK_BASIS_LABEL[r.basis]}`;
}

/**
 * The one line a queue carries when some of its rows could not be compared.
 *
 * It names the figure rather than the rows, because typing the figure once
 * fixes every row at once.
 */
export const RANK_UNPRICED_NOTE =
  "Some rows here could not be put in money, so they sit with their own campaign's work instead of in the order. "
  + "Recording what one customer is worth to this client and their close rate is what puts them in it.";

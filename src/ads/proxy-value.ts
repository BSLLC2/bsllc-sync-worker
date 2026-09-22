/**
 * What one lead is worth, as a figure that can be put on a conversion action.
 *
 * Pure. Facts in, one reading out.
 *
 * ── THE CONSTRUCTION, AND WHY IT IS THE STANDARD ONE ──────────────────────
 *
 * Close rate times customer value. If a tenth of leads become customers and a
 * customer is worth $500, a lead is worth about $50. It is the construction the
 * value-based-bidding guidance reaches for wherever an advertiser has no
 * per-lead revenue figure, and it works at volumes where uploading closed deals
 * does not — because the value rides on the form fill the account already gets
 * several times a week rather than on the sale it gets twice a quarter.
 *
 * `clients.close_rate_pct` and `clients.customer_value_cents` already exist,
 * the launch flow already chases both, and `costTargets()` in rules.ts already
 * reads them to say what a conversion may cost. The figure has never been sent
 * anywhere, which is the gap this closes.
 *
 * ── THE ABSENCE RULES, WHICH ARE THE HARD PART ────────────────────────────
 *
 *  1. A NULL IS UNANSWERED AND NEVER A NOUGHT. `client_targets.cpl_ceiling_cents`
 *     is `DEFAULT 0` and its own dialog says to leave a field at nought to skip
 *     it, and `clients.customer_value_cents` and `close_rate_pct` have the same
 *     shape. All three are resolved to null once, in `clientEconomicsFor` in
 *     src/ads/store.ts, and nothing here may read a nought as an answer.
 *  2. WHERE AN INPUT IS MISSING THE READING NAMES IT AND ASKS. It never
 *     substitutes a figure, never falls back to an average and never borrows
 *     one from another account. A proposal built on an invented input renders
 *     identically to one built on the client's own answer.
 *  3. THE FIGURE IS MODELLED AND THE WORD IS PART OF IT. It is arithmetic over
 *     two things somebody typed, not a measurement of anything, and it is never
 *     added to, averaged with or substituted for a measured figure. Where a
 *     measured per-win value exists it is stated on its own line with its own
 *     basis and multiplied by nothing.
 *
 * That discipline is `shared/case-study.ts`'s and it is followed rather than
 * borrowed: nothing here imports that module, and none of its basis words is
 * reused. What a client may claim about revenue we generated and what a bidding
 * model should be told a lead is worth are two different questions.
 *
 * ── THE CHANGE IS A PERSON'S, NOT AN API CALL ─────────────────────────────
 *
 * Setting a value on a conversion action changes what the account optimises
 * toward. There is no guarded path for it here and there should not be: that is
 * the one mutation class this system has always kept out of the apply path.
 * The reading computes the number and writes the instruction; somebody opens
 * the account and types it.
 */

/** What the client has recorded. Structurally the `ClientEconomics` the rules
 *  module already builds, restated here so this module imports nothing from it
 *  and the two cannot form a cycle. */
export interface ProxyEconomics {
  customerValueCents: number | null;
  customerValueFromClient: boolean;
  closeRatePct: number | null;
}

/** One conversion action, reduced to what deciding a value needs. */
export interface ValuedAction {
  name: string;
  /** The platform's own category, already decoded. */
  category: string | null;
  /** Does it count into the headline conversions column? Null = not reported. */
  countsIntoConversionsColumn: boolean | null;
  /** The default value set on the action, in the account's currency, or null
   *  where none is set or the field was not read. */
  defaultValue: number | null;
  /** Does the action always use that default rather than a value the page
   *  sends? Null = not reported, never read as false. */
  alwaysUseDefaultValue: boolean | null;
}

/**
 * Categories where the platform is already being handed a real transaction
 * amount. A proxy value over the top of one is a worse number replacing a
 * better one, so these are ruled out rather than valued.
 */
const TRANSACTION_CATEGORIES = new Set(["PURCHASE", "SUBSCRIBE_PAID", "STORE_SALE"]);

/**
 * How far the value already on the account may sit from the modelled figure
 * before the difference is worth a row.
 *
 * A quarter. Both figures are soft — the recorded one was typed by somebody at
 * some point and the modelled one moves whenever either input is corrected —
 * so a row every time they differ by a few per cent is a row people learn to
 * scroll past. Ours, and said to be ours.
 */
export const VALUE_DISAGREEMENT_TOLERANCE = 0.25;

export type ProxyValueState =
  /** Both inputs are on record and no value is set: the figure and the ask. */
  | "ready"
  /** One or both inputs are missing. The reading names which. */
  | "missing_inputs"
  /** A value is set and it is close enough to the modelled one. Silence. */
  | "already_valued"
  /** A value is set and it is a long way from what the record implies. */
  | "disagrees"
  /** The account is already handed a real amount per transaction. */
  | "transaction_valued"
  /** The conversion column is not recording an outcome, so valuing it would
   *  put a price on a page view. */
  | "column_unreadable";

export interface ProxyValueReading {
  state: ProxyValueState;
  /** The modelled figure in cents. Null on every state but ready/disagrees. */
  valueCents: number | null;
  /** Which recorded inputs are missing, named. Empty where none are. */
  missing: string[];
  /** The counting actions this would be set on, by name. */
  actionNames: string[];
  /** The value already set on the account, where one is. */
  recordedValue: number | null;
  lines: string[];
  /** The instruction a person follows in the account. Empty unless there is
   *  something for them to do. */
  instruction: string[];
  metrics: Record<string, number>;
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * Pure.
 *
 * `columnCountsOutcomes` is `trackingReading().countsOutcomes` and is composed
 * rather than re-decided — the same rule `biddingReadiness` follows next door.
 * A column counting page views must never be given a lead's value.
 */
export function proxyConversionValue(
  economics: ProxyEconomics | null | undefined,
  actions: ValuedAction[] | null | undefined,
  columnCountsOutcomes: "yes" | "no" | "unknown",
  /** Measured value per closed outcome from the client's CRM, where one has
   *  been measured. STATED BESIDE THE MODELLED FIGURE, NEVER BLENDED WITH IT. */
  measuredWonValueCents: number | null,
): ProxyValueReading {
  const base = {
    valueCents: null, missing: [] as string[], actionNames: [] as string[],
    recordedValue: null, instruction: [] as string[], metrics: {} as Record<string, number>,
  };

  if (columnCountsOutcomes !== "yes") {
    return {
      ...base, state: "column_unreadable",
      lines: [columnCountsOutcomes === "no"
        ? "What this account counts as a conversion is not an enquiry, so putting a lead's value on it would price a page view."
        : "Whether this account's conversion column records an enquiry could not be settled, and a value on a column nobody has checked is a number the bidding would act on."],
    };
  }
  if (actions == null) {
    return {
      ...base, state: "column_unreadable",
      lines: ["The account's conversion actions could not be read, so nothing here can say which of them a value would go on."],
    };
  }

  const counting = actions.filter((a) => a.countsIntoConversionsColumn !== false);
  if (counting.length === 0) {
    return {
      ...base, state: "column_unreadable",
      lines: ["No conversion action on this account counts into the column bidding reads, so there is nothing to put a value on."],
    };
  }
  if (counting.some((a) => TRANSACTION_CATEGORIES.has(String(a.category ?? "").toUpperCase()))) {
    return {
      ...base, state: "transaction_valued",
      actionNames: counting.map((a) => a.name),
      lines: ["This account counts a purchase, so the platform is already handed the amount of each one. A modelled average over the top of a real transaction value is a worse number replacing a better one."],
    };
  }

  const e = economics ?? { customerValueCents: null, customerValueFromClient: false, closeRatePct: null };
  const missing: string[] = [];
  if (e.customerValueCents == null || e.customerValueCents <= 0) {
    missing.push("What one customer is worth to this client. Nobody has answered it on the account record — and a nought there is the shape of the blank, not an answer.");
  }
  if (e.closeRatePct == null || e.closeRatePct <= 0) {
    missing.push("What share of leads become customers. Nobody has answered it on the account record, and it is the figure a real client can honestly not have at kickoff — which is a reason to ask them for it, never to pick one.");
  }

  const actionNames = counting.map((a) => a.name);
  const valuedActions = counting.filter((a) => a.defaultValue != null && a.defaultValue > 0);
  const recordedValue = valuedActions.length ? Math.round(valuedActions[0]!.defaultValue! * 100) : null;

  if (missing.length) {
    return {
      ...base, state: "missing_inputs", missing, actionNames, recordedValue,
      lines: [
        "A value on the conversion action is what lets the platform prefer the leads worth more, and the two figures it is worked out from are not both on this account's record.",
        ...missing,
        ...(measuredWonValueCents != null
          ? [`The client's CRM puts a closed outcome at about ${money(measuredWonValueCents)} on its own amounts. That is measured and it is a different figure from the two above — it is what a CUSTOMER is worth, so it answers half of this and only half.`]
          : []),
      ],
      instruction: [
        "Ask the client for the missing figure and record it on the account. Nothing here will pick one: a value that was guessed renders on the screen exactly like a value they gave us, and the platform would spend against it either way.",
      ],
      metrics: { missingInputs: missing.length },
    };
  }

  const valueCents = Math.round((e.customerValueCents as number) * ((e.closeRatePct as number) / 100));
  const whose = e.customerValueFromClient ? "on a customer value the client gave us" : "on a customer value we assumed rather than one the client gave us";
  const modelledLine = `Modelled, not measured: about ${money(valueCents)} a lead — ${money(e.customerValueCents as number)} a customer at the ${e.closeRatePct}% close rate on record, ${whose}.`;
  const measuredLine = measuredWonValueCents != null
    ? `Measured, separately: the client's CRM puts one closed outcome at about ${money(measuredWonValueCents)} on its own amounts. It is stated beside the figure above and is not averaged with it — one is a price per lead worked out from two typed numbers, the other is a price per customer the CRM recorded, and adding them would answer neither question.`
    : null;
  const metrics = {
    modelledLeadValueCents: valueCents,
    customerValueCents: e.customerValueCents as number,
    closeRatePct: e.closeRatePct as number,
    ...(recordedValue != null ? { recordedValueCents: recordedValue } : {}),
    ...(measuredWonValueCents != null ? { measuredWonValueCents } : {}),
  };

  if (recordedValue != null) {
    const drift = Math.abs(recordedValue - valueCents) / Math.max(1, valueCents);
    if (drift <= VALUE_DISAGREEMENT_TOLERANCE) {
      return {
        ...base, state: "already_valued", valueCents, actionNames, recordedValue, metrics,
        lines: [`A value of ${money(recordedValue)} is already set on this account's counting action, within a quarter of the ${money(valueCents)} the record implies.`, modelledLine],
      };
    }
    return {
      ...base, state: "disagrees", valueCents, actionNames, recordedValue, metrics,
      lines: [
        `The account values a conversion at ${money(recordedValue)} and this client's own record implies about ${money(valueCents)}.`,
        modelledLine,
        ...(measuredLine ? [measuredLine] : []),
        "Both cannot be right, and the platform is spending against the one in the account.",
      ],
      instruction: [
        `Settle which figure is correct with the client before changing either. Where the account's figure is the older one, set the counting action's value to ${money(valueCents)}; where the record is what is out of date, correct the customer value and the close rate on the account instead.`,
      ],
    };
  }

  return {
    ...base, state: "ready", valueCents, actionNames, recordedValue: null, metrics,
    lines: [
      modelledLine,
      ...(measuredLine ? [measuredLine] : []),
      `No value is set on ${actionNames.length === 1 ? "the counting action" : `any of the ${actionNames.length} counting actions`} on this account, so every lead is worth the same to the bidding whatever it turns out to be.`,
    ],
    instruction: [
      `In the account, open the conversion action${actionNames.length === 1 ? ` "${actionNames[0]}"` : `s ${actionNames.map((n) => `"${n}"`).join(", ")}`} and set a default value of ${money(valueCents)}, applied to every conversion that does not send its own.`,
      "Tell the client the figure and where it came from before it goes on. It is worked out from their own customer value and close rate, it is an average rather than a measurement, and it is the number the platform will spend against.",
      "Leave the campaign alone for a fortnight afterwards. Changing what a conversion is worth changes what the bidding is optimising for, and it takes that long to settle.",
    ],
  };
}

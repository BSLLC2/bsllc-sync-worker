/*
 * COPY. The authority is the app's shared/deal-pipeline.ts, byte-for-byte —
 * the two repos cannot import from each other, and this is the same
 * arrangement shared/lead-cadence.ts already has. `npm run verify:wiring`
 * reads both files and fails on drift, because an importer filtering on one
 * list while the app reports against another is worse than either alone.
 * Change the app's copy and re-copy; never edit this one on its own.
 */
/**
 * Which HubSpot pipelines are a SALES pipeline — and what to do with the rest.
 *
 * WHY THIS EXISTS. The import inserted every deal in the payload, unfiltered,
 * and the sales board filled up with records that were never deals: "Space 3
 * Yoga — UI Design Freeze", $0, stage "Contract sent", 75% odds, expected
 * close a hundred-odd days ago, no owner, no activity. A design freeze is a
 * project milestone. Forty-six of them were sitting in the weighted forecast.
 *
 * WHAT THE SIGNAL ACTUALLY IS. They came from a second HubSpot pipeline, and
 * that pipeline was never deleted: it is id `26466870`, label "Contracts", and
 * it still holds all forty-six — design freezes, copy freezes, sign-offs,
 * foundations documents, onboarding charters. Every one of them reports its
 * pipeline id on the deal, so this is an EXACT rule, not a guess about names
 * or dollar amounts. Both worker importers already ask HubSpot for the
 * `pipeline` property and then throw the value away before the app sees it;
 * all this needed was for somebody to read it.
 *
 * WHY AN ALLOWLIST AND NOT A BLOCKLIST. A blocklist's failure is silent and
 * permanent: the next pipeline somebody adds in HubSpot floods the board and
 * nothing says so. An allowlist's failure is loud — an unrecognised pipeline
 * is skipped AND named, with its record count and its money, in the import's
 * own output. A filter that quietly eats a real deal is worse than the junk it
 * removes, so this one is never quiet.
 *
 * THREE THINGS THIS DELIBERATELY DOES NOT DO:
 *   • It never reads a deal's NAME. "Design Freeze" is a fine name for a real
 *     deal and a $0 amount is a fine value for one that has not been priced.
 *     Pattern-matching either would eventually eat a live opportunity.
 *   • A deal that reports NO pipeline at all is KEPT. An older worker that
 *     doesn't send the field must import exactly as it did before — absence of
 *     evidence is not a reason to drop somebody's deal.
 *   • It never deletes anything. Records already on the board are marked (see
 *     deals.excludedPipeline) so a person can find them and decide.
 *
 * THE UNDO IS AN ENV VAR, not a code change: CRM_IMPORT_PIPELINES=a,b,c
 * replaces the allowlist, and CRM_IMPORT_PIPELINES=* turns the filter off
 * entirely and imports every pipeline, exactly as before this existed.
 */

export interface KnownPipeline {
  /** HubSpot's `pipeline` property value. */
  id: string;
  /** The label HubSpot shows, so the report reads in words and not in ids. */
  label: string;
  /** One line: why it is, or is not, a place we sell from. */
  why: string;
}

/** The pipelines a real opportunity lives in. Anything here is imported. */
export const SALES_PIPELINES: readonly KnownPipeline[] = [
  {
    id: "default",
    label: "Sales Pipeline",
    why: "the board the team actually sells on — every open opportunity and the whole closed-won history",
  },
  {
    id: "81ee3345-1b0f-42aa-9e78-580614546602",
    label: "HubSpot Shared Selling Pipeline",
    why: "partner deal registrations — closed won/lost with real money on them, so they are sales records too",
  },
];

/**
 * Pipelines we have looked at and decided are not sales. Listing one changes
 * nothing about whether it is imported (the allowlist above decides that) — it
 * only means the report can say what the thing IS instead of printing a bare
 * id at somebody.
 */
export const NON_SALES_PIPELINES: readonly KnownPipeline[] = [
  {
    id: "26466870",
    label: "Contracts",
    why: "delivery sign-offs, not opportunities — design/copy/UI freezes, foundations documents, onboarding charters, protocol sign-offs. A milestone a client approved, filed as a deal.",
  },
];

export const DEFAULT_SALES_PIPELINE_IDS: readonly string[] = SALES_PIPELINES.map((p) => p.id);

/** The env var that widens or switches off the filter, named once. */
export const PIPELINE_ENV_VAR = "CRM_IMPORT_PIPELINES";

export interface AllowedPipelines {
  /** The ids that will be imported. Empty when `everything` is true. */
  ids: readonly string[];
  /** True when the filter is off and every pipeline imports. */
  everything: boolean;
  /** Where the list came from, for the import to print. */
  source: "default" | typeof PIPELINE_ENV_VAR;
}

/**
 * Read the allowlist. `raw` is the env var's value; undefined/blank means the
 * built-in list. A single `*` (or a list containing one) means import
 * everything — the full undo, with no deploy.
 */
export function resolveAllowedPipelines(raw: string | null | undefined): AllowedPipelines {
  const parts = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return { ids: DEFAULT_SALES_PIPELINE_IDS, everything: false, source: "default" };
  if (parts.includes("*")) return { ids: [], everything: true, source: PIPELINE_ENV_VAR };
  return { ids: parts, everything: false, source: PIPELINE_ENV_VAR };
}

export interface PipelineVerdict {
  /** Import it? */
  keep: boolean;
  /** The pipeline as reported, or null when the payload carried none. */
  pipelineId: string | null;
  /** Its HubSpot label if we know it, else the raw id, else "(no pipeline)". */
  label: string;
  /** One line explaining the verdict, for the report. */
  why: string;
}

const byId = new Map<string, KnownPipeline>(
  [...SALES_PIPELINES, ...NON_SALES_PIPELINES].map((p) => [p.id, p]),
);

/** Look a pipeline up by id — exported so a report can name one. */
export function knownPipeline(id: string | null | undefined): KnownPipeline | null {
  return id ? byId.get(id) ?? null : null;
}

/**
 * The whole decision, pure. `allowed` comes from resolveAllowedPipelines().
 */
export function pipelineVerdict(
  pipelineId: string | null | undefined,
  allowed: AllowedPipelines,
): PipelineVerdict {
  const id = pipelineId?.trim() || null;
  if (allowed.everything) {
    return { keep: true, pipelineId: id, label: knownPipeline(id)?.label ?? id ?? "(no pipeline)", why: `${PIPELINE_ENV_VAR}=* — the pipeline filter is off` };
  }
  if (!id) {
    // No pipeline on the record. Could be an older worker that doesn't send
    // the field, could be a payload written by hand. Either way, dropping a
    // deal because we were told nothing about it is the one failure mode this
    // filter must not have.
    return { keep: true, pipelineId: null, label: "(no pipeline)", why: "the payload carried no pipeline, so there is nothing to judge — imported, as before" };
  }
  if (allowed.ids.includes(id)) {
    const known = knownPipeline(id);
    return { keep: true, pipelineId: id, label: known?.label ?? id, why: known?.why ?? "on the allowlist" };
  }
  const known = knownPipeline(id);
  return {
    keep: false,
    pipelineId: id,
    label: known?.label ?? id,
    why: known?.why ?? "not a pipeline we sell out of, and not one anybody here has looked at — check it in HubSpot",
  };
}

// ── The report ───────────────────────────────────────────────────────────────

export interface SkippedDeal {
  hubspotId: string;
  name: string;
  amountCents: number;
  stage: string;
  verdict: PipelineVerdict;
  /** True when a deal by this hubspot id is already on the board here. */
  alreadyHere: boolean;
}

/** How many records of one pipeline get named before the list is summarised. */
export const SKIPPED_SAMPLE = 50;

const usd = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * The lines the import prints about what it did NOT import. Nothing is
 * discarded quietly: every skipped record is counted, its pipeline is named
 * with its label and its money, and the way to let it back in is printed with
 * it. Returns [] when nothing was skipped.
 */
export function summariseSkipped(skipped: readonly SkippedDeal[], allowed: AllowedPipelines, totalDeals: number): string[] {
  if (skipped.length === 0) return [];
  const groups: Record<string, SkippedDeal[]> = {};
  for (const s of skipped) {
    const k = s.verdict.pipelineId ?? "(no pipeline)";
    (groups[k] ??= []).push(s);
  }
  const ordered = Object.keys(groups).sort((a, b) => groups[b]!.length - groups[a]!.length);
  const lines: string[] = [];
  lines.push(`crm-import: ${skipped.length} of ${totalDeals} deal(s) were left out — they are not in a pipeline we sell out of.`);
  for (const id of ordered) {
    const rows = groups[id]!;
    const money = rows.reduce((n: number, r: SkippedDeal) => n + r.amountCents, 0);
    const label = rows[0]!.verdict.label;
    lines.push(`  ${label} (${id}) — ${rows.length} record(s), ${usd(money)}`);
    lines.push(`      ${rows[0]!.verdict.why}`);
    if (money > 0) {
      const withMoney = rows.filter((r: SkippedDeal) => r.amountCents > 0).sort((a: SkippedDeal, b: SkippedDeal) => b.amountCents - a.amountCents);
      lines.push(`      ${withMoney.length} of them carry a value — check these first: ${withMoney.slice(0, 5).map((r: SkippedDeal) => `${r.name} (${usd(r.amountCents)})`).join(", ")}`);
    }
    for (const r of rows.slice(0, SKIPPED_SAMPLE)) {
      lines.push(`      • ${r.hubspotId}  ${r.name} · ${r.stage} · ${usd(r.amountCents)}${r.alreadyHere ? "  [already on the board here]" : ""}`);
    }
    if (rows.length > SKIPPED_SAMPLE) lines.push(`      … and ${rows.length - SKIPPED_SAMPLE} more`);
  }
  const here = skipped.filter((s) => s.alreadyHere).length;
  lines.push(
    here > 0
      ? `  ${here} of them are already on the CRM board here. Nothing was deleted: they are marked "from a non-sales pipeline" at the foot of the pipeline, where they can be reviewed and removed with the bulk delete.`
      : `  None of them are on the CRM board here, so there is nothing to clean up.`,
  );
  lines.push(
    allowed.source === PIPELINE_ENV_VAR
      ? `  Allowlist came from ${PIPELINE_ENV_VAR}=${allowed.everything ? "*" : allowed.ids.join(",")}.`
      : `  If one of these should be imported, set ${PIPELINE_ENV_VAR}=${[...DEFAULT_SALES_PIPELINE_IDS, ordered[0]!].join(",")} (or ${PIPELINE_ENV_VAR}=* for every pipeline). No code change, no deploy.`,
  );
  return lines;
}

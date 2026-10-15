/**
 * One closed-deal tracker framework, one declared config per client.
 *
 * A person keeps a sheet of a client's sales (Smartsheet or Google Sheets). This
 * framework reads it by HEADER NAME, counts the deals that are ours and won, and
 * hands the dashboard monthly won revenue plus a summary. A client is one entry
 * in TRACKER_CONFIGS below. Pure: no network, no database, no clock.
 *
 * DPG's tracker (src/dpg-tracker.ts) predates this and stays on its own code so
 * its figures cannot move. `dpgParityConfig` expresses DPG's rules in this
 * framework, and src/verify-tracker.ts proves both readers give the same
 * counted, pending and refused rows on the same sheet.
 *
 * WHAT YOU EDIT. To point a client at a sheet, set the repository VARIABLES
 * (not secrets) <KEY>_TRACKER_SHEET (FRANKLIN_TRACKER_SHEET), TRACKER_<KEY>_SOURCE (smartsheet or
 * google_sheet), TRACKER_<KEY>_TAB (Google only) and TRACKER_<KEY>_KEPT_BY (us or
 * client). A heading the sheet calls something else is an alias added to the
 * role below; the diagnose run (workflow input diagnose=true) lists the headings
 * the sheet has and which role found its column.
 */

export type SourceKind = "smartsheet" | "google_sheet";
export type KeptBy = "us" | "client";

/**
 * The jobs a column can do. `status`, `amount`, `closedDate` and `source` decide
 * what counts. The rest are lead keys and context: they are read for counts and
 * for the click id on a won row, and never stored (no name, phone or email).
 */
export const ROLE_NAMES = [
  "status", "amount", "closedDate", "source", "confirmFlag", "firstContact",
  "gclid", "rowLabel", "type", "email", "phone", "formId", "name",
] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

export interface RoleSpec {
  /** Header texts that mean this role. Compared with case, spacing and punctuation folded. */
  aliases: readonly string[];
  required: boolean;
}

export interface SeedSpec {
  /** First and last closed day the one-time seed covers (the seed's own window). */
  from: string;
  through: string;
  /** What the seed holds in total (named wins included), in cents. For the reconciliation line only. */
  cents: number;
  label: string;
  /** The largest single win inside the seed, in cents, so the card can say one deal is most of it. Null: not known. */
  largestCents?: number | null;
}

/** A second way the same client's sheet may be laid out. The first layout that resolves wins. */
export interface LayoutSpec {
  name: string;
  roles: Partial<Record<RoleName, RoleSpec>>;
  /** Source words (folded) that mean ours in THIS layout. Empty: every row is ours. */
  ourSourceValues: readonly string[];
  /**
   * A layout where every row is ours must PROVE the sheet is that kind of sheet, or a renamed
   * source heading on the main log would drop it into this layout and count every customer's
   * RFQs as ours. `requireAny`: at least one of these headings must be present. `refuseIfAny`:
   * none of these headings may be present. Both compare folded headings.
   */
  requireAny?: readonly string[];
  refuseIfAny?: readonly string[];
}

export interface TrackerConfig {
  /** Short key; also the suffix of the repository variables. */
  key: string;
  /** The app's slug for the client; the sync contract resolves it. */
  clientSlug: string;
  /** The account's exact name, for the one-off that records the evidence note. */
  clientName: string;
  /** What the sheet is called in a sentence ("Franklin Brazing's RFQ and quote log"). A phrase, never a customer. */
  sheetLabel: string;
  source: SourceKind;
  /**
   * Null until the owner supplies it through the repository variable
   * <KEY>_TRACKER_SHEET (or TRACKER_<KEY>_SHEET_ID). It is never committed: it may be a
   * numeric id or a link (parseSheetRef). Not printed in any log.
   */
  sheetId: string | null;
  /** Google tab name; unused for Smartsheet. */
  tab: string | null;
  /** Who keeps and updates the sheet. Unknown for Franklin, so it is "us" until somebody says. */
  keptBy: KeptBy;
  /** Name of the layout `roles` describes. */
  layoutName: string;
  roles: Partial<Record<RoleName, RoleSpec>>;
  /** Other layouts the same client's sheet may have (the owner has two sheets and has not said which this is). */
  altLayouts: readonly LayoutSpec[];
  /** Status words (folded) that mean Won. A checked box reads as "true". */
  wonValues: readonly string[];
  /** Status words (folded) that are known not-won. Any other non-blank word is "other status". */
  knownNotWonValues: readonly string[];
  /** Source words (folded) that mean the deal came from our work. Empty: every row is ours. */
  ourSourceValues: readonly string[];
  /** The first closed day the FEED counts. Wins closed before it belong to the seed. */
  countedFrom: string;
  seed: SeedSpec | null;
  /** DPG-style per-deal fee. Null: no fee model. */
  fee: { perDealCents: number; capDeals: number } | null;
  /** A blank status with a closed date and an amount is pending (DPG) or ignored (a quote log). */
  blankStatusPending: boolean;
  rowLimit: number;
}

const norm = (s: unknown): string => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export const normHeader = norm;

export const FRANKLIN_SEED_AS_OF = "2025-12-30";
/** The seed's own figures (src/oneoff-seed-franklin-revenue.ts): $18,994 of ordinary wins plus the $1.8M named win. */
export const FRANKLIN_SEED_OTHER_CENTS = 18_994_00;
export const FRANKLIN_SEED_NAMED_CENTS = 1_800_000_00;
export const FRANKLIN_SEED_CENTS = FRANKLIN_SEED_OTHER_CENTS + FRANKLIN_SEED_NAMED_CENTS;

export const FRANKLIN: TrackerConfig = {
  key: "franklin",
  clientSlug: "franklin-brazing",
  clientName: "Franklin Brazing",
  sheetLabel: "Franklin Brazing's RFQ and quote log",
  source: "smartsheet",
  sheetId: null,
  tab: null,
  keptBy: "us",
  layoutName: "rfq_log",
  altLayouts: [
    // "Google Ads Form Submissions": one row per form fill, every row ours. Wins can only be counted
    // from it when the sheet also carries outcome columns; if it does not, the import says so by name.
    {
      name: "form_submissions",
      ourSourceValues: [],
      requireAny: ["form name", "form id", "entry id", "submission id", "form entry id", "timestamp", "submitted at", "submission time", "date submitted", "submission date", "form submitted"],
      refuseIfAny: ["rfq", "rfq number", "rfq no", "rfq id", "rfq date", "rfq status", "rfq source", "quote number", "quote no", "quote id", "quote status", "lead source", "source", "campaign", "origin", "award date", "po date", "po amount"],
      roles: {
        status: { required: true, aliases: ["status", "outcome", "result", "won", "closed won", "won lost", "converted", "deal status", "disposition"] },
        amount: { required: true, aliases: ["amount", "revenue", "sale amount", "closed amount", "job value", "order value", "deal value", "won amount", "order amount"] },
        closedDate: { required: true, aliases: ["closed date", "close date", "date closed", "won date", "date won", "won on", "order date", "closed on"] },
        firstContact: { required: false, aliases: ["timestamp", "submitted at", "submission time", "created at", "date submitted", "submission date", "form submitted", "first contact"] },
        gclid: { required: false, aliases: ["gclid", "google click id", "click id", "google ads click id"] },
        type: { required: false, aliases: ["form name", "form", "lead type", "type"] },
        rowLabel: { required: false, aliases: ["entry id", "submission id", "form id", "id"] },
        email: { required: false, aliases: ["email", "e mail", "email address", "contact email", "customer email", "primary email", "work email"] },
        phone: { required: false, aliases: ["phone", "phone number", "telephone", "contact phone", "customer phone", "mobile", "cell"] },
        formId: { required: false, aliases: ["form id", "entry id", "submission id"] },
        name: { required: false, aliases: ["name", "full name", "contact name", "company", "customer"] },
      },
    },
  ],
  roles: {
    status: { required: true, aliases: ["status", "rfq status", "quote status", "stage", "outcome", "result", "won lost", "won", "deal status", "disposition"] },
    amount: { required: true, aliases: ["amount", "won amount", "order amount", "order value", "po amount", "po value", "deal value", "sale amount", "revenue", "invoice amount"] },
    closedDate: { required: true, aliases: ["closed date", "close date", "date closed", "won date", "date won", "order date", "award date", "po date", "closed on", "date awarded"] },
    source: { required: true, aliases: ["rfq source", "lead source", "source", "campaign", "origin"] },
    firstContact: { required: false, aliases: ["rfq date", "date received", "received date", "rfq received", "first contact", "submission date", "date submitted"] },
    gclid: { required: false, aliases: ["gclid", "google click id", "click id", "google ads click id"] },
    rowLabel: { required: false, aliases: ["rfq", "rfq number", "rfq no", "rfq id", "quote number", "quote no", "quote id"] },
    email: { required: false, aliases: ["email", "e mail", "email address", "contact email", "customer email", "primary email", "work email"] },
    phone: { required: false, aliases: ["phone", "phone number", "telephone", "contact phone", "customer phone", "mobile", "cell"] },
    formId: { required: false, aliases: ["form id", "entry id", "submission id", "form entry id"] },
    name: { required: false, aliases: ["customer", "customer name", "company", "company name", "account", "contact name", "name"] },
  },
  wonValues: ["won", "closed won", "awarded", "order received", "po received", "yes", "true", "checked"],
  knownNotWonValues: ["lost", "closed lost", "declined", "no bid", "no quote", "cancelled", "canceled", "expired", "quoted", "open", "pending", "in progress", "not awarded", "withdrawn", "submitted", "new", "active", "no response", "dead", "on hold", "no", "false"],
  ourSourceValues: ["BS LLC AD CAMPAIGN"],
  // The seed covers closed days through 2025-12-30. The feed starts the next day, so no month is in both.
  countedFrom: "2025-12-31",
  seed: { from: "2024-01-01", through: FRANKLIN_SEED_AS_OF, cents: FRANKLIN_SEED_CENTS, label: "the RFQ log", largestCents: FRANKLIN_SEED_NAMED_CENTS },
  fee: null,
  blankStatusPending: false,
  rowLimit: 20_000,
};

/**
 * DPG's rules expressed here. It is NOT used at run time (DPG keeps its own
 * importer); it exists so verify-tracker can prove the framework reads the same
 * rows the same way DPG's reader does.
 */
export const dpgParityConfig = (windowStart: string): TrackerConfig => ({
  key: "dpg-parity",
  clientSlug: "diesel-power-group",
  clientName: "Diesel Power Group",
  sheetLabel: "the DPG tracker",
  source: "google_sheet",
  sheetId: null,
  tab: null,
  keptBy: "us",
  layoutName: "dpg",
  altLayouts: [],
  roles: {
    firstContact: { required: true, aliases: ["first contact"] },
    status: { required: true, aliases: ["status"] },
    closedDate: { required: true, aliases: ["closed date"] },
    amount: { required: true, aliases: ["amount"] },
    confirmFlag: { required: true, aliases: ["won in billing window"] },
    name: { required: false, aliases: ["name on file"] },
    type: { required: false, aliases: ["type"] },
    gclid: { required: false, aliases: ["ad click"] },
  },
  wonValues: ["won"],
  knownNotWonValues: [],
  ourSourceValues: [],
  countedFrom: windowStart,
  seed: null,
  fee: { perDealCents: 266_666, capDeals: 45 },
  blankStatusPending: true,
  rowLimit: 5_000,
});

export const TRACKER_CONFIGS: readonly TrackerConfig[] = [FRANKLIN];

// ── Repository variables ─────────────────────────────────────────────────────

const upper = (key: string) => key.toUpperCase().replace(/[^A-Z0-9]+/g, "_");

/**
 * What the owner gave us for "the sheet". Accepted, for either source: the
 * numeric id (Smartsheet) or the long code in the address (Google), or a link.
 *
 * A Smartsheet LINK is a permalink, and its last path segment is NOT the numeric
 * sheet id the API wants. It is resolved to the id at run time by listing the
 * sheets the token's user can see and matching on that segment (see
 * resolvePermalink in smartsheet.ts). Nothing here ever stores the resolved id.
 */
export type SheetRef =
  | { kind: "none" }
  | { kind: "id"; id: string }
  | { kind: "permalink"; token: string }
  | { kind: "unusable" };

export function parseSheetRef(raw: string | undefined | null, source: SourceKind): SheetRef {
  const v = (raw ?? "").trim();
  if (!v) return { kind: "none" };
  const url = v.match(/^https?:\/\/([^/?#]+)(\/[^?#]*)?/i);
  if (url) {
    const host = url[1]!.toLowerCase();
    const path = url[2] ?? "";
    if (/(^|\.)smartsheet(gov)?\.(com|eu|au)$/.test(host)) {
      const m = path.match(/^\/sheets\/([A-Za-z0-9]{10,80})\/?$/);
      return m ? { kind: "permalink", token: m[1]! } : { kind: "unusable" };
    }
    const g = path.match(/^\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/);
    return g ? { kind: "id", id: g[1]! } : { kind: "unusable" };
  }
  if (source === "smartsheet") {
    if (/^\d{6,20}$/.test(v)) return { kind: "id", id: v };
    if (/^[A-Za-z0-9]{20,80}$/.test(v)) return { kind: "permalink", token: v };
    return { kind: "unusable" };
  }
  return /^[A-Za-z0-9_-]{20,}$/.test(v) ? { kind: "id", id: v } : { kind: "unusable" };
}

export type Env = Record<string, string | undefined>;

/** The config with this deployment's repository variables applied. */
export function resolveConfig(base: TrackerConfig, env: Env = process.env): TrackerConfig {
  const k = upper(base.key);
  const src = env[`TRACKER_${k}_SOURCE`]?.trim().toLowerCase();
  const kept = env[`TRACKER_${k}_KEPT_BY`]?.trim().toLowerCase();
  return {
    ...base,
    source: src === "smartsheet" || src === "google_sheet" ? src : base.source,
    sheetId: (env[`TRACKER_${k}_SHEET_ID`] ?? env[`${k}_TRACKER_SHEET`])?.trim() || base.sheetId,
    tab: env[`TRACKER_${k}_TAB`]?.trim() || base.tab,
    keptBy: kept === "client" || kept === "us" ? kept : base.keptBy,
    rowLimit: /^\d{2,6}$/.test(env[`TRACKER_${k}_ROW_LIMIT`]?.trim() ?? "") ? Number(env[`TRACKER_${k}_ROW_LIMIT`]) : base.rowLimit,
    countedFrom: /^\d{4}-\d{2}-\d{2}$/.test(env[`TRACKER_${k}_COUNTED_FROM`]?.trim() ?? "") ? env[`TRACKER_${k}_COUNTED_FROM`]!.trim() : base.countedFrom,
  };
}

export const configByKey = (key: string): TrackerConfig | null => TRACKER_CONFIGS.find((c) => c.key === key || c.clientSlug === key) ?? null;

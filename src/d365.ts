import "dotenv/config";

/**
 * Dynamics 365 / Dataverse client for DPG Closed Won attribution.
 *
 * Attribution model (see docs/D365_CLOSED_WON_BRIEF.md):
 *   Opportunities carry NO source in this org and are NOT created via Lead
 *   conversion — reps create them straight against a Contact. So attribution
 *   comes from the Contact's `new_firsttouchsource` (a locked, auto-populated
 *   optionset), resolved via the Opportunity's `parentcontactid` lookup.
 *
 * The worker owns zero DB writes; the importer hands metrics to `npm run sync`.
 */

export interface D365Config {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  resourceUrl: string; // e.g. https://dpg-prod.crm.dynamics.com  (no trailing slash)
}

export function loadD365Config(): D365Config {
  const req = (n: string) => {
    const v = process.env[n];
    if (!v || !v.trim()) throw new Error(`Missing required env var ${n}.`);
    return v.trim();
  };
  return {
    tenantId: req("DYNAMICS_TENANT_ID"),
    clientId: req("DYNAMICS_CLIENT_ID"),
    clientSecret: req("DYNAMICS_CLIENT_SECRET"),
    resourceUrl: req("DYNAMICS_RESOURCE_URL").replace(/\/+$/, ""),
  };
}

// ── First Touch Source optionset (Contact.new_firsttouchsource) ──
export const FTS = {
  PAID_SEARCH: 100000001,
  ORGANIC_SEARCH: 100000002,
  GOOGLE_BUSINESS_PROFILE: 100000003,
  WEBSITE_FORM: 100000004,
  WEBSITE_PHONE_CALL: 100000005,
  SOCIAL_MEDIA: 100000006,
  EMAIL_CAMPAIGN: 100000007,
  REFERRAL_PROGRAM: 100000008,
  MANUAL_SALES_OUTREACH: 100000009,
  TRUCK_PAPER: 100000010,
  WORD_OF_MOUTH: 100000011,
  OTHER: 100000012,
} as const;

// Report grouping (option B): only channels BS LLC actually runs count as
// BS-LLC-driven. Referral / Truck Paper / Word of Mouth / Other are real
// sources but not BS LLC. Manual Sales Outreach is excluded from billing.
const BSLLC_DRIVEN = new Set<number>([
  FTS.PAID_SEARCH, FTS.ORGANIC_SEARCH, FTS.GOOGLE_BUSINESS_PROFILE,
  FTS.WEBSITE_FORM, FTS.WEBSITE_PHONE_CALL, FTS.SOCIAL_MEDIA, FTS.EMAIL_CAMPAIGN,
]);
const OTHER_TRACKED = new Set<number>([
  FTS.REFERRAL_PROGRAM, FTS.TRUCK_PAPER, FTS.WORD_OF_MOUTH, FTS.OTHER,
]);

// The field went live on this date with no historical backfill. A blank on a
// Contact created before then is "unknown (pre-field)", NOT manual — reported
// separately so early numbers read honestly rather than as "BS LLC drove none".
export const FIRST_TOUCH_GOLIVE = "2026-08-13";

export type Bucket = "bsllc" | "other" | "manual" | "unknown";

/**
 * Classify one Closed Won deal into a report bucket from its Contact.
 * @param source  new_firsttouchsource optionset value (number) or null/undefined
 * @param contactCreatedOn  Contact.createdon ISO string, or null when no Contact
 *                          could be resolved off the Opportunity.
 */
export function classify(source: number | null | undefined, contactCreatedOn: string | null): Bucket {
  if (source == null) {
    // Blank: unknown if the Contact predates the field going live (or if we
    // couldn't resolve a Contact at all); otherwise defensively not-attributed.
    if (!contactCreatedOn) return "unknown";
    return contactCreatedOn.slice(0, 10) < FIRST_TOUCH_GOLIVE ? "unknown" : "manual";
  }
  if (source === FTS.MANUAL_SALES_OUTREACH) return "manual";
  if (BSLLC_DRIVEN.has(source)) return "bsllc";
  if (OTHER_TRACKED.has(source)) return "other";
  // Unrecognized non-manual value → treat as other tracked (still non-manual).
  return "other";
}

// ── OAuth2 client-credentials token, cached until ~1 min before expiry ──
let cached: { token: string; exp: number } = { token: "", exp: 0 };

export async function getToken(cfg: D365Config): Promise<string> {
  const now = Date.now();
  if (cached.token && now < cached.exp - 60_000) return cached.token;
  const res = await fetch(`https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      scope: `${cfg.resourceUrl}/.default`,
    }),
  });
  if (!res.ok) throw new Error(`D365 token request failed (${res.status}): ${await res.text()}`);
  const j = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!j.access_token) throw new Error("D365 token response had no access_token.");
  cached = { token: j.access_token, exp: now + (j.expires_in ?? 3600) * 1000 };
  return cached.token;
}

export interface OppRow {
  opportunityid: string;
  name: string | null;
  actualvalue: number | null;
  actualclosedate: string | null;
  parentcontactid?: {
    contactid: string;
    createdon: string | null;
    new_firsttouchsource: number | null;
  } | null;
}

/**
 * Fetch every Closed Won Opportunity (statecode=1) with a value, expanding the
 * related Contact's createdon + first-touch source. Follows @odata.nextLink
 * paging and refreshes the token between pages if it's near expiry.
 */
export async function fetchClosedWon(cfg: D365Config): Promise<OppRow[]> {
  const select = "opportunityid,name,actualvalue,actualclosedate";
  const expand = "parentcontactid($select=contactid,createdon,new_firsttouchsource)";
  const filter = "statecode eq 1 and actualvalue ne null";
  let url =
    `${cfg.resourceUrl}/api/data/v9.2/opportunities` +
    `?$select=${select}&$expand=${expand}&$filter=${encodeURIComponent(filter)}`;

  const out: OppRow[] = [];
  while (url) {
    const token = await getToken(cfg);
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "OData-MaxVersion": "4.0",
        "OData-Version": "4.0",
        Prefer: "odata.maxpagesize=500",
      },
    });
    if (res.status === 403) {
      throw new Error(
        "D365 403 on opportunities — the service principal's security role in " +
          "dpg-prod likely lacks read access on Opportunity/Contact. Flag to the D365 admin.",
      );
    }
    if (!res.ok) throw new Error(`D365 query failed (${res.status}): ${await res.text()}`);
    const j = (await res.json()) as { value?: OppRow[]; ["@odata.nextLink"]?: string };
    out.push(...(j.value ?? []));
    url = j["@odata.nextLink"] ?? "";
  }
  return out;
}

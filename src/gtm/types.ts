/**
 * Google Tag Manager reader: the constants and the shapes it keeps.
 *
 * READ-ONLY, AND NARROW. The one scope this reader ever asks for is
 * `tagmanager.readonly`; every call is a GET. It reads the LIVE published version of a
 * container only (never a workspace draft) and keeps DECLARED FACTS: which tag types are
 * there, their event names and ids, whether each is paused and whether it has a firing
 * trigger. It never keeps a custom HTML body, a template's code, a variable's value, a
 * trigger's regular expression or any secret.
 *
 * EVERY FIELD NAME AND TAG TYPE BELOW IS WRITTEN FROM GOOGLE'S PUBLISHED TAG MANAGER
 * API v2 REFERENCE AS REMEMBERED. NONE WAS CHECKED AGAINST A LIVE CONTAINER. Each is
 * marked UNVERIFIED where it is decided, and the first dry run is the proof.
 */

export const GTM_BASE = "https://tagmanager.googleapis.com/tagmanager/v2";
/** The ONLY scope this reader asks for. A guard fails any other scope in src/gtm or read-gtm.ts. */
export const GTM_SCOPE = "https://www.googleapis.com/auth/tagmanager.readonly";
/** A container's public id, as the person types it in Admin, Connectors. */
export const GTM_PUBLIC_ID_RE = /^GTM-[A-Z0-9]{4,12}$/;

/** How many tags, triggers and variable names one container keeps. Over the tag cap the run says so. */
export const GTM_TAG_CAP = 500;
export const GTM_TRIGGER_CAP = 300;
export const GTM_VARIABLE_NAME_CAP = 60;
export const GTM_EVENT_NAME_CAP = 100;
export const GTM_STRING_MAX = 60;
/** A pause between calls, so one run stays inside Tag Manager's per-minute allowance (UNVERIFIED: the quota is read from the reference). */
export const GTM_PAUSE_MS = 1000;
export const GTM_TRIES = 3;

/** Why a read ended where it did, as stored beside the facts. */
export const GTM_ERROR_STATES = ["no_access", "not_listed", "api_disabled", "no_live_version", "bad_id", "error"] as const;
export type GtmErrorState = (typeof GTM_ERROR_STATES)[number];

/**
 * Tag type codes, exact matches only. UNVERIFIED against a live container.
 *   gaawc    Google Analytics: GA4 Configuration (parameter measurementId)
 *   googtag  the newer "Google tag" (parameter tagId: G- is analytics, AW- is ads)
 *   gaawe    Google Analytics: GA4 Event (parameters eventName, measurementIdOverride)
 *   awct     Google Ads Conversion Tracking (parameters conversionId, conversionLabel)
 *   gclidw   Conversion Linker
 *   html     Custom HTML          img      Custom Image
 *   cvt_*    a community template; matched by the template's gallery reference below
 *   ua       Universal Analytics (retired)   sp  Google Ads Remarketing
 */
export const TAG_TYPE = {
  ga4Config: "gaawc",
  googleTag: "googtag",
  ga4Event: "gaawe",
  adsConversion: "awct",
  conversionLinker: "gclidw",
  customHtml: "html",
  customImage: "img",
} as const;

/**
 * Community templates read as a known product only when the template's own gallery
 * reference matches EXACTLY (owner and repository, case-insensitive). A template that is
 * not in this table is a "custom tag", never guessed from its name. UNVERIFIED: these
 * owner and repository values are the ones I believe the vendors publish under; a wrong
 * one means that product reads as a custom tag, which is the safe direction.
 */
export const KNOWN_TEMPLATES: ReadonlyArray<{ kind: "clarity" | "metaPixel"; owner: string; repository: string }> = [
  { kind: "clarity", owner: "microsoft", repository: "clarity-gtm-template" },
  { kind: "metaPixel", owner: "facebookincubator", repository: "facebook-pixel-gtm-template" },
];

/** GTM's built-in trigger ids sit at the top of the range and are not listed in the `trigger` array. UNVERIFIED. */
export const BUILT_IN_TRIGGER_MIN = 2147479000;

export interface GtmGa4Config { measurementId: string | null; viaVariable: boolean; paused: boolean; fires: boolean }
export interface GtmGa4Event { event: string | null; paused: boolean; fires: boolean }
export interface GtmAdsConversion { conversionId: string | null; hasLabel: boolean; paused: boolean; fires: boolean }
export interface GtmCount { count: number; active: number }

export interface GtmFacts {
  v: 1;
  counts: { tags: number; paused: number; triggers: number; variables: number; truncated: boolean };
  ga4Configs: GtmGa4Config[];
  ga4Events: GtmGa4Event[];
  adsConversions: GtmAdsConversion[];
  conversionLinker: GtmCount;
  clarity: GtmCount;
  metaPixel: GtmCount;
  /** Custom HTML, custom image and any template this reader does not recognise. Counted, never read. */
  customTags: number;
  otherTags: number;
  triggers: Array<{ type: string; summary: string }>;
  variableNames: string[];
}

export interface GtmVersionOut {
  versionId: string | null;
  versionName: string | null;
  /** UNVERIFIED: the version's fingerprint read as epoch milliseconds, kept only when it is a plausible date. Null otherwise. */
  publishedAt: Date | null;
}

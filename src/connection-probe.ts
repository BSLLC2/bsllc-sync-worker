/**
 * Connection testing — the pure half.
 *
 * The app's "Test connection" button dispatches test-connections.yml, which
 * asks Google for the SMALLEST possible real read of one client's account and
 * writes the raw outcome into `connector_tests`. This module holds everything
 * in that job that can be decided without a network call or a database, so it
 * can be proved by `npm run verify-connection-probe` without touching a live
 * client account.
 *
 * ── The one rule about where classification lives ──
 * The dashboard classifies a stored result into a client-facing FIX at READ
 * time (its shared/connection-test.ts). The worker deliberately holds no copy
 * of that mapping: two copies in two repos drift, and a drifted mapping is
 * worse than none because it sends a client down a path the other side already
 * corrected. So the worker stores the API's error VERBATIM and nothing else.
 *
 * What IS here is narrower and doesn't overlap: an ours-vs-theirs verdict used
 * only for the JOB'S OWN LOG and exit summary. The job has to know the
 * difference for two reasons that have nothing to do with rendering a fix:
 *
 *   1. When the failure is ours — our Google API switched off, our
 *      service-account key dead, our quota spent — every client fails at once,
 *      and the run log must say that in those words instead of printing
 *      anything that reads like "the client needs to grant us access". An
 *      operator who reads the wrong thing here emails a whole portfolio.
 *   2. An error we don't recognise must be reported as unrecognised, not
 *      squeezed into the nearest-looking bucket. A confident wrong instruction
 *      costs more than no instruction.
 *
 * This file never produces client-facing wording, and nothing it decides is
 * written to the database. If that ever changes, the two repos are back to
 * having two mappings and the reason above applies again.
 */

/** What the probe found. Mirrors CONNECTION_TEST_OUTCOMES in the dashboard's
 *  shared/connection-test.ts — these four strings are the contract, and
 *  `connector_tests.outcome` may never hold anything else. */
export type ProbeOutcome = "running" | "pass" | "no_data" | "fail";

/** The connectors this job can probe. Same list as the dashboard's
 *  TESTABLE_SOURCES; anything else arriving in `sources` is refused rather
 *  than silently skipped, because a silently skipped source leaves a row
 *  running forever. */
export const PROBEABLE_SOURCES = ["gsc", "ga4", "google_ads"] as const;
export type ProbeableSource = (typeof PROBEABLE_SOURCES)[number];

export function isProbeableSource(s: string): s is ProbeableSource {
  return (PROBEABLE_SOURCES as readonly string[]).includes(s);
}

export const SOURCE_LABEL: Record<ProbeableSource, string> = {
  gsc: "Search Console",
  ga4: "Google Analytics (GA4)",
  google_ads: "Google Ads",
};

/** One finished probe, ready to be written to one `connector_tests` row. */
export interface ProbeResult {
  outcome: Exclude<ProbeOutcome, "running">;
  /** The API's text, unedited. Null on pass/no_data. */
  rawError: string | null;
  /** What else we established — for Search Console, the properties we CAN
   *  see, which is the difference between "wrong property" and "no grant".
   *  Rendered as one short paragraph in the dashboard, so keep it to a
   *  sentence or two. */
  detail: string | null;
  /** True only when we enumerated the accounts visible to us and the one we
   *  hold was NOT among them. Never a guess. */
  visibleElsewhere: boolean;
  /** Which call was made, so a result read a year from now doesn't need
   *  archaeology to know what "pass" meant. */
  probe: string;
}

// ── Error text ──────────────────────────────────────────────────────────────

/** How much of an API error we keep. Long enough for a stack of Google's JSON,
 *  short enough that an HTML error page doesn't become the row. */
export const MAX_RAW_ERROR = 4000;
/** `detail` is rendered as a paragraph next to the verdict, not as a log. */
export const MAX_DETAIL = 500;

/**
 * Unwrap whatever the caller threw into text worth storing.
 *
 * The google-ads-api client throws a GoogleAdsFailure object rather than an
 * Error, so `String(err)` gives "[object Object]" — the same trap index.ts
 * documents. Each entry carries an error_code
 * ({ authorization_error: "USER_PERMISSION_DENIED" }) plus a human message,
 * and the CODE is the part the dashboard's mapping keys on, so it has to
 * survive. Falls back to JSON so nothing is ever lost.
 */
export function formatProbeError(err: unknown): string {
  const text = (() => {
    if (typeof err === "string") return err;
    if (err && typeof err === "object") {
      const anyErr = err as { errors?: unknown; message?: unknown };
      if (Array.isArray(anyErr.errors) && anyErr.errors.length > 0) {
        return anyErr.errors
          .map((e) => {
            const ge = e as { error_code?: Record<string, unknown>; message?: string };
            const code = ge.error_code
              ? Object.entries(ge.error_code)
                  .map(([k, v]) => `${k}=${String(v)}`)
                  .join(",")
              : "";
            return [code, ge.message].filter(Boolean).join(" ");
          })
          .join(" | ");
      }
      if (err instanceof Error && err.message) return err.message;
      if (typeof anyErr.message === "string" && anyErr.message) return anyErr.message;
      try {
        return JSON.stringify(err);
      } catch {
        /* fall through */
      }
    }
    return String(err);
  })();
  return truncate(text.trim() || "(no error text)", MAX_RAW_ERROR);
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** An HTTP failure, as stored. The status code is kept because several of the
 *  dashboard's rules key on a bare 403/404/400 and a JSON body does not always
 *  repeat it; the body itself is passed through untouched. */
export function httpErrorText(status: number, body: string): string {
  return truncate(`HTTP ${status} ${body.trim()}`, MAX_RAW_ERROR);
}

// ── Ours vs theirs ──────────────────────────────────────────────────────────

/**
 * Who has to do something about this failure.
 *  ours    — our credential, our Cloud project, our quota, our network. Every
 *            client is failing this way right now. NEVER tell a client.
 *  client  — something in the client's account or in the id we hold for it.
 *  unknown — we do not recognise this error. Say exactly that; guess nothing.
 */
export type FailureScope = "ours" | "client" | "unknown";

export interface FailureVerdict {
  scope: FailureScope;
  /** A short machine-ish code for the log and the run summary. */
  code:
    | "api_disabled"
    | "our_credential"
    | "stored_id"
    | "quota"
    | "network"
    | "access_or_account"
    | "unrecognised";
  /** One line for the run log. Written for whoever is reading a failed
   *  Actions run — never for a client. */
  summary: string;
}

const has = (m: string, re: RegExp) => re.test(m);

/**
 * Classify a failure for the LOG only.
 *
 * Order matters, and it is the same order the dashboard uses at read time:
 * everything that is OURS is tested before anything that could be the
 * client's. Every one of our own failures also surfaces as a 403 and reads
 * exactly like "they didn't grant access" — getting this order wrong is how a
 * whole portfolio gets chased for a permission they already gave.
 */
export function classifyFailure(source: string, rawError: string | null | undefined): FailureVerdict {
  const raw = (rawError ?? "").trim();
  const noun = isProbeableSource(source) ? SOURCE_LABEL[source] : source;

  if (!raw) {
    return {
      scope: "unknown",
      code: "unrecognised",
      summary: `The ${noun} probe failed but captured no error text. That is a bug in the probe, not an answer about the client — do not act on it.`,
    };
  }

  // The Google API is switched off on OUR Cloud project. Google answers with a
  // 403 and "has not been used in project … or it is disabled" — the same
  // status code as a missing property grant. import-gsc-api.ts carries a
  // comment about the days this cost when it was read as a permission problem.
  if (has(raw, /has not been used in project|SERVICE_DISABLED|is disabled\b|accessNotConfigured/i)) {
    return {
      scope: "ours",
      code: "api_disabled",
      summary: `OURS: the ${noun} API is not enabled on our Google Cloud project. Every client fails identically until it is switched on. Do not contact any client about this.`,
    };
  }

  // Our own credential is dead — rotated key, disabled service account, an Ads
  // developer token that is not approved. Again a 40x that looks like theirs.
  if (
    has(
      raw,
      // "Missing required env var …" is how config.ts and adsEnv() report a
      // repo secret that was never set. That is our own credential missing, and
      // it is worth naming as such: without it the run reads as an unrecognised
      // error and somebody goes looking at the client's account.
      /invalid_grant|Invalid JWT|invalid_client|unauthorized_client|Service account not found|signature|deleted[_ ]client|ACCOUNT_DISABLED|DEVELOPER_TOKEN_(NOT_APPROVED|PROHIBITED|INVALID)|Missing GOOGLE_SERVICE_ACCOUNT_JSON|Missing required env var|not valid JSON|missing client_email/i,
    )
  ) {
    return {
      scope: "ours",
      code: "our_credential",
      summary: `OURS: the ${noun} read was rejected before any client permission was considered — our service-account key or API token is invalid, revoked or unapproved. Every client is failing at once. Do not send an access request off the back of this.`,
    };
  }

  // The id WE hold is unusable — a measurement id where the numeric GA4
  // property belongs, a malformed Search Console property, anything our own
  // probe refused before it ever called Google. The client's account is not
  // involved: this is a correction in Admin → Connectors, and reporting it as
  // client-side sends an AM to ask for something they already gave us. Narrow
  // on purpose — a 404 means the id names nothing that exists, which IS worth
  // asking the client about, so it stays in the client bucket below.
  if (has(raw, /probe check — no API call was made|INVALID_ARGUMENT|badRequest|Invalid site|Invalid property|\b400\b|malformed/i)) {
    return {
      scope: "ours",
      code: "stored_id",
      summary: `OURS (our record, not their account): the ${noun} id stored on this connector was rejected as unusable. Correct it in Admin → Connectors and re-test — do not ask the client to change a permission over this.`,
    };
  }

  if (has(raw, /RESOURCE_EXHAUSTED|rateLimitExceeded|userRateLimitExceeded|quota|\b429\b|Too Many Requests|QUOTA_ERROR/i)) {
    return {
      scope: "ours",
      code: "quota",
      summary: `OURS: Google is rate-limiting us on ${noun}. Nothing is wrong with the client's access. Re-test in a few minutes.`,
    };
  }

  if (
    has(
      raw,
      /ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|network|fetch failed|AbortError|The operation was aborted|\b50[023]\b|Service Unavailable|Internal error encountered/i,
    )
  ) {
    return {
      scope: "ours",
      code: "network",
      summary: `OURS (or Google's): the ${noun} request never got a real answer — a network error or a Google-side outage, not a permission. Re-test before concluding anything.`,
    };
  }

  // Theirs. Deliberately ONE coarse bucket: the exact fix (wrong property vs
  // no grant vs unaccepted link vs suspended account) is the dashboard's job at
  // read time, and duplicating that split here is precisely the drift this
  // module's header refuses.
  if (
    has(
      raw,
      /\b40[0349]\b|PERMISSION_DENIED|USER_PERMISSION_DENIED|NOT_ADS_USER|does not have sufficient permission|insufficient permission|Forbidden|NOT_FOUND|not found|INVALID_ARGUMENT|badRequest|Invalid site|Invalid property|siteUnverifiedUser|unverified|CUSTOMER_NOT_FOUND|INVALID_CUSTOMER_ID|CUSTOMER_NOT_ENABLED|ACCOUNT_SUSPENDED|CANCELLED|SUSPENDED|billing|BILLING_SETUP|payment|REQUESTED_METRICS_FOR_MANAGER|authorization_error|malformed|numeric/i,
    )
  ) {
    return {
      scope: "client",
      code: "access_or_account",
      summary: `Client-side: ${noun} refused or rejected the read for this account. The exact fix is worked out in the dashboard from the stored error — the AM sees it on the client's page.`,
    };
  }

  return {
    scope: "unknown",
    code: "unrecognised",
    summary: `UNRECOGNISED ${noun} error. We do not have a cause for this one. Send the stored error text to engineering — do not guess, and do not ask the client for anything.`,
  };
}

// ── Search Console: which property did they actually grant? ─────────────────

export interface GscSiteEntry {
  siteUrl: string;
  permissionLevel?: string;
}

/**
 * Normalise a Search Console property for comparison.
 *
 * The distinction that causes most of the wasted round trips: `example.com`
 * (a domain property, written `sc-domain:example.com`) and
 * `https://example.com/` (a URL-prefix property) are two SEPARATE properties,
 * and being added to one grants nothing on the other. So the two forms must
 * never compare equal — only casing, whitespace and a missing trailing slash
 * are normalised away.
 */
export function normalizeGscProperty(raw: string): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  if (/^sc-domain:/i.test(s)) return `sc-domain:${s.slice("sc-domain:".length).trim().toLowerCase().replace(/\/+$/, "")}`;
  // A URL-prefix property always ends in a slash in Search Console's own
  // listing; people paste it both ways.
  const lower = s.toLowerCase();
  return /^https?:\/\//.test(lower) ? (lower.endsWith("/") ? lower : `${lower}/`) : lower;
}

/** Permission levels that cannot read Search Analytics. An account added at
 *  this level HAS been granted something — saying "you never added us" to a
 *  client who did the work is a needless argument. */
export function isUnusableGscPermission(level: string | undefined | null): boolean {
  return /siteUnverifiedUser/i.test((level ?? "").trim());
}

export interface GscSiteAnalysis {
  /** Our property, if Search Console lists it for us at all. */
  found: GscSiteEntry | null;
  /** True only when the list came back non-empty and ours was absent. */
  visibleElsewhere: boolean;
  /** One short paragraph for the dashboard's `detail`. */
  detail: string;
}

/**
 * Compare the property we hold against the properties the service account can
 * actually see. This is the single most useful thing the whole test can say:
 * "we have Search Console access, just not to this property — here is what we
 * do have" turns a permission argument into a two-second correction.
 *
 * An EMPTY list must not read as "wrong property": it means we are on nothing
 * at all, which is a different conversation.
 */
export function analyzeGscSites(target: string, sites: GscSiteEntry[]): GscSiteAnalysis {
  const want = normalizeGscProperty(target);
  const found = sites.find((s) => normalizeGscProperty(s.siteUrl) === want) ?? null;

  if (found) {
    const level = found.permissionLevel ?? "unknown";
    return {
      found,
      visibleElsewhere: false,
      detail: truncate(
        isUnusableGscPermission(level)
          ? `Search Console does list this property for us, but at permissionLevel=${level} — an unverified user, which cannot read Search Analytics. Somebody did add us; the level is the problem, not the grant.`
          : `Search Console lists this property for us at permissionLevel=${level}, so the grant itself exists.`,
        MAX_DETAIL,
      ),
    };
  }

  if (sites.length === 0) {
    return {
      found: null,
      visibleElsewhere: false,
      detail: truncate(
        "Search Console lists NO properties at all for our service account, so this is not a wrong-property mix-up — we have not been added to anything.",
        MAX_DETAIL,
      ),
    };
  }

  // Cap the list: this renders as one paragraph on the client's page in the
  // dashboard, not as a log.
  const shown = sites.slice(0, 6).map((s) => s.siteUrl);
  const more = sites.length - shown.length;
  return {
    found: null,
    visibleElsewhere: true,
    detail: truncate(
      `Our service account can see ${sites.length} Search Console ${sites.length === 1 ? "property" : "properties"}, and this one is not among them: ${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""}. Note that sc-domain:example.com and https://example.com/ are separate properties — access to one grants nothing on the other.`,
      MAX_DETAIL,
    ),
  };
}

// ── GA4: the measurement-ID mix-up ──────────────────────────────────────────

export interface Ga4IdCheck {
  ok: boolean;
  /** The id to query, normalised. Empty when unusable. */
  id: string;
  kind: "numeric" | "measurement" | "universal" | "empty" | "other";
  /** Set when !ok — the text stored as the row's error. Phrased so it is
   *  obvious this came from our own check and not from Google. */
  probeError?: string;
  /** Set when there is something worth saying either way. */
  detail?: string;
}

/**
 * Decide whether a stored GA4 id is even worth sending to Google.
 *
 * GA4 wants the NUMERIC property id. The mix-up that costs a round trip is a
 * measurement id (`G-XXXXXXX`) — the code out of the tracking snippet, which
 * is what a client naturally reaches for and what an AM naturally pastes. It
 * is OURS to fix in Admin → Connectors, not something to email the client
 * about, and it is worth catching before the call rather than gambling on
 * whether Google answers 400 or 404 for a malformed path.
 *
 * `properties/123` is accepted and unwrapped: runReport builds the
 * `properties/` prefix itself, and the doubled path produced a bare 404 that
 * read as a dead connector rather than as a typo (see import-ga4.ts).
 */
export function checkGa4PropertyId(raw: string | null | undefined): Ga4IdCheck {
  const s = (raw ?? "").trim();
  if (!s) {
    return {
      ok: false,
      id: "",
      kind: "empty",
      probeError: "Invalid property id: no GA4 property id is stored for this connector (probe check — no API call was made).",
      detail: "Nothing to test against. Add the numeric GA4 Property ID in Admin → Connectors → GA4.",
    };
  }
  const bare = s.replace(/^properties\//i, "").trim();

  if (/^G-[A-Z0-9]+$/i.test(bare)) {
    return {
      ok: false,
      id: "",
      kind: "measurement",
      probeError: `Invalid property id "${bare}": that is a GA4 MEASUREMENT ID, not the numeric property id (probe check — no API call was made).`,
      detail:
        "This one is ours to fix, not the client's: a G- code is the measurement id out of the tracking snippet. GA4 access is granted at property level and covers every data stream, so the numeric Property ID (Admin → Property settings, digits only) is the id to store.",
    };
  }
  if (/^UA-/i.test(bare)) {
    return {
      ok: false,
      id: "",
      kind: "universal",
      probeError: `Invalid property id "${bare}": that is a Universal Analytics id, and UA properties stopped collecting data (probe check — no API call was made).`,
      detail: "Ours to fix: the client needs a GA4 property, and we need its numeric Property ID in Admin → Connectors → GA4.",
    };
  }
  if (!/^\d+$/.test(bare)) {
    return {
      ok: false,
      id: "",
      kind: "other",
      probeError: `Invalid property id "${bare}": a GA4 property id is digits only (probe check — no API call was made).`,
      detail: "Ours to fix in Admin → Connectors → GA4 — the numeric Property ID is under GA4 → Admin → Property settings.",
    };
  }
  return { ok: true, id: bare, kind: "numeric" };
}

// ── Google Ads: is the account even visible to our manager account? ─────────

/** Ads wants digits only; people paste the dashed form off the screen. */
export function adsCustomerId(raw: string | null | undefined): string {
  return (raw ?? "").replace(/[^0-9]/g, "");
}

export interface AdsVisibility {
  /** Account ids our manager account can see, digits only. */
  visibleIds: string[];
  /** Null when we could not enumerate — then we claim nothing. */
  listed: boolean;
}

export interface AdsVisibilityAnalysis {
  visibleElsewhere: boolean;
  detail: string;
}

/**
 * What our own manager account can see, turned into a sentence.
 *
 * The point: Google Ads does NOT use the shared service-account address at all.
 * An account reaches us either through a link to our manager account or as a
 * named user. The commonest failure by a distance is a link invitation that was
 * sent and never accepted — which is not a permission error and must not be
 * described as one, because the client's admin will look at their user list,
 * see nothing wrong, and tell us we are mistaken.
 *
 * Only the presence or absence of THIS account is reported. The other account
 * ids under our manager belong to other clients and have no business being
 * written into this client's row.
 */
export function analyzeAdsVisibility(customerId: string, vis: AdsVisibility): AdsVisibilityAnalysis {
  const want = adsCustomerId(customerId);
  if (!vis.listed) {
    return {
      visibleElsewhere: false,
      detail: truncate(
        "We could not list the accounts under our manager account on this run, so we cannot say whether this one is linked to us. Nothing here rules a link problem in or out.",
        MAX_DETAIL,
      ),
    };
  }
  const present = vis.visibleIds.some((id) => adsCustomerId(id) === want);
  if (present) {
    return {
      visibleElsewhere: false,
      detail: truncate(
        `Our manager account CAN see this ad account, so the link exists — whatever refused the read, it is not a missing link. Look at the state of the account itself (suspended, cancelled, unpaid billing) or at whether this id is a manager account rather than an ad account.`,
        MAX_DETAIL,
      ),
    };
  }
  return {
    visibleElsewhere: true,
    detail: truncate(
      `Our manager account can see ${vis.visibleIds.length} ad ${vis.visibleIds.length === 1 ? "account" : "accounts"}, and this one is not among them. The commonest cause by far is a link invitation that was sent but never ACCEPTED in the client's account — that is not a permission error and their user list will look perfectly normal. The other route is adding us as a named user; Google Ads never uses the shared service-account address.`,
      MAX_DETAIL,
    ),
  };
}

// ── Empty is not broken ─────────────────────────────────────────────────────

/**
 * The distinction the whole feature exists for: we got IN and the account
 * answered with nothing. A brand-new property is legitimately empty, and
 * sending a client another access request for that is the expensive mistake.
 * `no_data` is a successful read, and nothing downstream may treat it as a
 * permission failure.
 */
export function outcomeForRead(hasData: boolean): "pass" | "no_data" {
  return hasData ? "pass" : "no_data";
}

/** Did a reporting window actually contain anything? A row of zeros is as
 *  empty as no rows at all — see google-ads.ts, which treats an all-zero
 *  window as no_data rather than as a row of real zeros. */
export function windowHasData(values: Array<number | null | undefined>): boolean {
  return values.some((v) => Number(v ?? 0) > 0);
}

/**
 * The text stored on a row we had to close without an answer.
 *
 * It is a FIXED sentence, and that is deliberate. The dashboard classifies a
 * stored error by matching Google's vocabulary in it, so interpolating the
 * run's own status here is a trap: a cancelled run would have written the word
 * "cancelled" into the row, and the Google Ads rules read that as "the client's
 * ad account is cancelled or suspended" and hand the AM a sentence to send
 * them. A failure of OUR test would have been reported to the client as a
 * problem with their billing.
 *
 * So: nothing here matches any rule in the dashboard's mapping, which lands it
 * on "we don't recognise this — send it to engineering, don't ask the client",
 * with the raw text shown. That is the correct answer for a test that never
 * ran. The leading token is a stable hook if the dashboard ever wants to give
 * this case wording of its own.
 *
 * `verify-connection-probe` asserts this text stays clear of the whole
 * vocabulary; if you reword it, run that first.
 */
export const STRANDED_ERROR =
  "CONNECTION_TEST_DID_NOT_FINISH: the test run ended before Google answered for this connector, so there is no result. This is about our test run, not about the client's access.";

// ── Run summary ─────────────────────────────────────────────────────────────

export interface RunLine {
  source: string;
  outcome: ProbeOutcome;
  scope?: FailureScope;
}

/**
 * One line the operator can read at the bottom of a failed Actions run. It
 * names the ours-vs-theirs split explicitly, because that is the fact that
 * decides whether anybody contacts a client at all.
 */
export function summarizeRun(lines: RunLine[]): string {
  if (!lines.length) return "test-connections: nothing was probed.";
  const counts = { pass: 0, no_data: 0, fail: 0, running: 0 };
  let ours = 0;
  let unknown = 0;
  for (const l of lines) {
    counts[l.outcome] = (counts[l.outcome] ?? 0) + 1;
    if (l.outcome === "fail" && l.scope === "ours") ours++;
    if (l.outcome === "fail" && l.scope === "unknown") unknown++;
  }
  const parts = [
    `${lines.length} probed`,
    `${counts.pass} pass`,
    `${counts.no_data} no_data (access fine, account empty)`,
    `${counts.fail} fail`,
  ];
  if (counts.running) parts.push(`${counts.running} STILL RUNNING — a row was left open`);
  if (ours) parts.push(`${ours} of those failures are OURS, not the client's`);
  if (unknown) parts.push(`${unknown} unrecognised — for engineering, not the client`);
  return `test-connections: ${parts.join(" · ")}.`;
}

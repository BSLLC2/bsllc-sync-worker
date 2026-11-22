/**
 * DATA MANAGER API: the one door for sending offline click conversions to Google Ads.
 *
 * Google closed ConversionUploadService.UploadClickConversions to new integrations
 * ("New integrations for uploading click conversions should use the Data Manager API"),
 * so every upload from the OCH job was refused. This module builds the Data Manager
 * ingest request and reads its answer. The job (src/import-offline-conversions.ts)
 * decides WHICH conversions go; nothing here reads a database.
 *
 * UNVERIFIED LIVE. The request and response shapes below are written from the
 * published reference as remembered and have never been run against Google. The
 * first run is validate-only (validateOnly: true) and the job refuses to send until
 * a validate pass is on record. If Google answers a field name differently, this is
 * the one file to change.
 *
 * TEST SEAM. When DATA_MANAGER_FAKE_BASE is set (and only then) the token call and the
 * ingest call both go to that address. No workflow sets it.
 *
 * Nothing here prints a click id, a name, a phone or an address.
 *
 * USER IDENTIFIERS (R25, enhanced conversions for leads). A row may carry `userIdentifiers`, already SHA-256 hashed and
 * hex encoded by src/ads/user-identifiers.ts. They go on the event as `userData.userIdentifiers[]` (one of emailAddress /
 * phoneNumber per entry) and the request then says `encoding: "HEX"`. Field names checked against the published
 * reference (IngestEventsRequest.encoding, Event.userData, UserData.userIdentifiers, UserIdentifier) on 2026-11-22;
 * the HEX enum value is as documented but UNVERIFIED LIVE until a validate pass with identifiers comes back clean.
 */
import type { UserIdentifier } from "./user-identifiers.js";
export const DM_SCOPE = "https://www.googleapis.com/auth/datamanager";
export const DM_MAX_EVENTS_PER_REQUEST = 2000;
export const OFFLINE_TIME_ZONE = "America/New_York";

const fake = (): string | null => process.env.DATA_MANAGER_FAKE_BASE?.trim() || null;
export const dmBase = (): string => fake() ?? "https://datamanager.googleapis.com";
const tokenUrl = (): string => (fake() ? `${fake()}/token` : "https://oauth2.googleapis.com/token");

export interface DmRow {
  gclid: string; closed: string; valueDollars: number | null; transactionId: string;
  /** Hashed phone and email (src/ads/user-identifiers.ts), only when the client's gate allows. Never logged or stored. */
  userIdentifiers?: readonly UserIdentifier[];
}
export interface DmDestination { accountId: string; loginAccountId: string | null; actionId: string }

/** "-05:00" / "-04:00": the Eastern offset on a day, daylight saving included. */
export function tzOffsetOn(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  const name = new Intl.DateTimeFormat("en-US", { timeZone: OFFLINE_TIME_ZONE, timeZoneName: "shortOffset" }).formatToParts(d).find((p) => p.type === "timeZoneName")?.value ?? "GMT-5";
  const m = name.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  return m ? `${m[1]}${m[2]!.padStart(2, "0")}:${m[3] ?? "00"}` : "-05:00";
}
/** RFC 3339 with the offset: end of the admission day, so it is never before the click. */
export const eventTimestamp = (closed: string): string => `${closed.slice(0, 10)}T23:59:59${tzOffsetOn(closed.slice(0, 10))}`;

const digits = (s: string): string => (s ?? "").replace(/\D/g, "");

/** One ingest request. Chunked by the caller with chunk(). validateOnly sends nothing to the account. */
export function buildIngestBody(dest: DmDestination, rows: readonly DmRow[], validateOnly: boolean): Record<string, unknown> {
  const destination: Record<string, unknown> = {
    operatingAccount: { accountType: "GOOGLE_ADS", accountId: digits(dest.accountId) },
    productDestinationId: digits(dest.actionId),
  };
  if (dest.loginAccountId) destination.loginAccount = { accountType: "GOOGLE_ADS", accountId: digits(dest.loginAccountId) };
  const anyIds = rows.some((r) => (r.userIdentifiers?.length ?? 0) > 0);
  return {
    destinations: [destination],
    events: rows.map((r) => ({
      eventTimestamp: eventTimestamp(r.closed),
      transactionId: r.transactionId,
      adIdentifiers: { gclid: r.gclid },
      eventSource: "OTHER",
      ...(r.valueDollars != null && r.valueDollars > 0 ? { conversionValue: r.valueDollars, currency: "USD" } : {}),
      ...(r.userIdentifiers?.length ? { userData: { userIdentifiers: r.userIdentifiers.map((i) => ({ ...i })) } } : {}),
    })),
    ...(anyIds ? { encoding: "HEX" } : {}),
    validateOnly,
  };
}

export const chunk = <T>(xs: readonly T[], n = DM_MAX_EVENTS_PER_REQUEST): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

/** Strip anything that could be a click id or an address from text before it is printed. */
export const scrub = (s: string): string => s.replace(/[A-Za-z0-9_\-.]{24,}/g, "[token]").replace(/\S+@\S+/g, "[address]").slice(0, 240);

export interface DmAnswer { ok: boolean; status: number; requestId: string | null; reason: string | null; scopeProblem: boolean; closedApi: boolean }

/** Read an ingest answer. A 2xx with no error is accepted; anything else carries a scrubbed reason. */
export function interpret(status: number, body: unknown): DmAnswer {
  const b = (body && typeof body === "object" ? body : {}) as { requestId?: unknown; error?: { message?: unknown; status?: unknown; details?: unknown } };
  const requestId = typeof b.requestId === "string" ? b.requestId : null;
  if (status >= 200 && status < 300 && !b.error) return { ok: true, status, requestId, reason: null, scopeProblem: false, closedApi: false };
  const msg = typeof b.error?.message === "string" ? b.error.message : `HTTP ${status}`;
  const code = typeof b.error?.status === "string" ? b.error.status : "";
  return {
    ok: false, status, requestId,
    reason: scrub(`${code ? code + ": " : ""}${msg}`),
    scopeProblem: status === 401 || status === 403 || /scope|permission|PERMISSION_DENIED|UNAUTHENTICATED/i.test(`${code} ${msg}`),
    closedApi: false,
  };
}

/** An access token for the Data Manager scope. THROWS with a scrubbed message when Google refuses. */
export async function getAccessToken(env: Record<string, string | undefined>): Promise<string> {
  const refresh = env.DATA_MANAGER_REFRESH_TOKEN?.trim();
  if (refresh) {
    const id = env.GOOGLE_ADS_CLIENT_ID?.trim(), secret = env.GOOGLE_ADS_CLIENT_SECRET?.trim();
    if (!id || !secret) throw new Error("DATA_MANAGER_REFRESH_TOKEN is set but GOOGLE_ADS_CLIENT_ID or GOOGLE_ADS_CLIENT_SECRET is missing.");
    const res = await fetch(tokenUrl(), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: refresh, grant_type: "refresh_token" }) });
    const j = (await res.json().catch(() => null)) as { access_token?: string; error?: string; error_description?: string } | null;
    if (!res.ok || !j?.access_token) throw new Error(scrub(`Google refused the Data Manager token: ${j?.error ?? res.status} ${j?.error_description ?? ""}. The refresh token has to be granted the Data Manager scope (${DM_SCOPE}).`));
    return j.access_token;
  }
  const raw = env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) throw new Error("No Data Manager credential: set DATA_MANAGER_REFRESH_TOKEN (an OAuth refresh token granted the Data Manager scope) or provide GOOGLE_SERVICE_ACCOUNT_JSON.");
  const { accessToken } = await import("../och-google.js");
  const sa = JSON.parse(raw) as { client_email?: string; private_key?: string };
  const t = await accessToken(sa, DM_SCOPE);
  if (!t) throw new Error("Google gave no Data Manager token for the service account.");
  return t;
}

/** POST one ingest request. A write: never retried, so a request that may have landed is not sent twice. */
export async function ingest(token: string, body: Record<string, unknown>): Promise<DmAnswer> {
  const res = await fetch(`${dmBase()}/v1/events:ingest`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => null);
  return interpret(res.status, j);
}

/** Best-effort read of how many events Google took for a request. Counts only. Null when it cannot be read. */
export async function requestStatus(token: string, requestId: string): Promise<{ received: number | null; failed: number | null } | null> {
  try {
    const res = await fetch(`${dmBase()}/v1/requestStatus:retrieve?requestId=${encodeURIComponent(requestId)}`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const j = (await res.json()) as { requestStatusPerDestination?: { eventsIngestionStatus?: { recordCount?: string | number; failureRecordCount?: string | number } }[] };
    const s = j.requestStatusPerDestination?.[0]?.eventsIngestionStatus;
    const n = (v: unknown): number | null => (v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);
    return s ? { received: n(s.recordCount), failed: n(s.failureRecordCount) } : null;
  } catch { return null; }
}

/** A validate-only pass older than this does not authorise a send. Our own line. */
export const VALIDATION_FRESH_DAYS = 14;
export function validationAllows(validatedAt: string | null | undefined, now: Date): boolean {
  if (!validatedAt) return false;
  const t = Date.parse(validatedAt);
  return Number.isFinite(t) && now.getTime() - t >= 0 && now.getTime() - t <= VALIDATION_FRESH_DAYS * 86_400_000;
}

/** Why a conversion action may not be used. It must exist, be an upload action, be enabled and be SECONDARY. */
export function actionFault(a: { type?: unknown; status?: unknown; primary_for_goal?: unknown } | null | undefined, name: string): string | null {
  const is = (v: unknown, n: string, num: number) => v === n || v === num;
  if (!a) return `The conversion action "${name}" does not exist in the ad account. Create it in Google Ads as an offline, secondary action. This job never creates one: a new action can default to primary and change bidding.`;
  if (!is(a.type, "UPLOAD_CLICKS", 7)) return `"${name}" is not an upload-from-clicks action, so nothing is sent.`;
  if (!is(a.status, "ENABLED", 2)) return `"${name}" is not enabled, so nothing is sent.`;
  if (a.primary_for_goal !== false) return `"${name}" is not confirmed as a secondary action (primary_for_goal was ${a.primary_for_goal === true ? "true" : "not returned"}). Set it to secondary in Google Ads. This job never sends to a primary action.`;
  return null;
}

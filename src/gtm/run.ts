/**
 * One client's Tag Manager read, as a function of injected dependencies so a guard can
 * drive it against a pretend Tag Manager. Nothing here throws to the caller: every ending
 * is a status the dashboard can say in a sentence (src/signals/common.ts).
 *
 * The container id is the one a person typed in Admin, Connectors (source gtm). It is
 * matched EXACTLY against the containers the service account can see; it is never
 * derived from the client's website.
 */
import { HttpError, safeMessage } from "../page-behaviour/http.js";
import type { FetchLike } from "../page-behaviour/types.js";
import { signalRun, type SignalRunOut } from "../signals/common.js";
import { SECRET_NAMES } from "../signals/secrets.js";
import { getLiveVersion, isApiDisabled, isNoAccess, listContainers, parseLiveVersion, type ContainerListing } from "./api.js";
import { GTM_PUBLIC_ID_RE, GTM_TAG_CAP, type GtmErrorState, type GtmFacts, type GtmVersionOut } from "./types.js";

export interface GtmCtx { name: string; slug: string; /** The container public id as typed, or null. */ containerId: string | null }
/** The service account's containers, read once for the whole run. A failure is carried to every client, as its own status. */
export type Directory = { ok: true; byId: Map<string, ContainerListing> } | { ok: false; run: SignalRunOut; state: GtmErrorState };
export interface GtmDeps {
  fetch: FetchLike;
  /** Null when the service account secret is absent. */
  token: string | null;
  tokenProblem?: string | null;
  directory: () => Promise<Directory>;
  pauseMs?: number;
  secrets?: readonly string[];
}
export interface GtmResult {
  containerId: string | null;
  containerPath: string | null;
  version: GtmVersionOut;
  facts: GtmFacts | null;
  /** The state to store beside the facts; null for a clean read. */
  state: GtmErrorState | null;
  /** True where the read ended without a fresh set of facts. */
  failed: boolean;
  run: SignalRunOut;
}

const NO_VERSION: GtmVersionOut = { versionId: null, versionName: null, publishedAt: null };
const GRANT = "In Tag Manager, open Admin, then User management for the account or container, and add the Google service account with Read access.";

export async function loadDirectory(f: FetchLike, token: string, pauseMs: number, secrets: readonly string[]): Promise<Directory> {
  try {
    const byId = await listContainers(f, token, pauseMs);
    return { ok: true, byId };
  } catch (e) {
    if (isApiDisabled(e)) return { ok: false, state: "api_disabled", run: signalRun("gtm", "error", "The Tag Manager API is not switched on in the Google Cloud project the service account belongs to. Enable the Tag Manager API there, then run this again.") };
    if (e instanceof HttpError && (e.status === 401 || e.status === 403)) return { ok: false, state: "no_access", run: signalRun("gtm", "no_token", "Google did not accept the service account for Tag Manager. Check the GOOGLE_SERVICE_ACCOUNT_JSON secret.") };
    return { ok: false, state: "error", run: signalRun("gtm", "error", `Could not ask Tag Manager which containers the service account can see: ${safeMessage(e, secrets)}`) };
  }
}

export async function readGtmClient(ctx: GtmCtx, deps: GtmDeps): Promise<GtmResult> {
  const base = (run: SignalRunOut, state: GtmErrorState | null, failed: boolean, extra: Partial<GtmResult> = {}): GtmResult =>
    ({ containerId: ctx.containerId?.trim().toUpperCase() ?? null, containerPath: null, version: NO_VERSION, facts: null, state, failed, run, ...extra });
  const say = (e: unknown) => safeMessage(e, deps.secrets ?? []);
  const id = ctx.containerId?.trim().toUpperCase() ?? "";
  if (!id) return base(signalRun("gtm", "off", "No Tag Manager container is recorded for this account."), null, false);
  if (!GTM_PUBLIC_ID_RE.test(id)) return base(signalRun("gtm", "error", `"${ctx.containerId}" is not a Tag Manager container id. It looks like GTM- and letters or digits, shown at the top of the container in Tag Manager.`), "bad_id", true);
  if (!deps.token) {
    return base(signalRun("gtm", "no_token", deps.tokenProblem ?? `${SECRET_NAMES.serviceAccount} is not set on the worker, so no Tag Manager container was read.`), null, true);
  }
  const dir = await deps.directory();
  if (!dir.ok) return base(dir.run, dir.state, true);
  const hit = dir.byId.get(id);
  if (!hit) {
    const none = dir.byId.size === 0;
    return base(signalRun("gtm", "error", none
      ? `The service account can see no Tag Manager containers at all. ${GRANT}`
      : `The service account cannot see ${id}. ${GRANT}`), "not_listed", true);
  }
  let json: unknown;
  try {
    json = await getLiveVersion(deps.fetch, deps.token, hit.path, deps.pauseMs ?? 0);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) {
      // A container with no published version answers not found on the live endpoint. UNVERIFIED.
      return base(signalRun("gtm", "no_data", `${id} has no published version, so there is nothing live to read. Publish the container in Tag Manager.`), "no_live_version", false, { containerPath: hit.path });
    }
    if (isApiDisabled(e)) return base(signalRun("gtm", "error", "The Tag Manager API is not switched on in the Google Cloud project the service account belongs to."), "api_disabled", true, { containerPath: hit.path });
    if (isNoAccess(e)) return base(signalRun("gtm", "error", `The service account is not allowed to read ${id}. ${GRANT}`), "no_access", true, { containerPath: hit.path });
    return base(signalRun("gtm", "error", `Could not read the live version of ${id}: ${say(e)}`), "error", true, { containerPath: hit.path });
  }
  const { version, facts } = parseLiveVersion(json);
  const total = facts.ga4Configs.length + facts.ga4Events.length + facts.adsConversions.length;
  const capped = facts.counts.truncated;
  return base(
    signalRun("gtm", capped ? "capped" : "ok", capped ? `Only the first ${GTM_TAG_CAP} of ${facts.counts.tags} tags were read.` : null, { rows: facts.counts.tags, capped, totalFound: total }),
    null, false, { containerPath: hit.path, version, facts },
  );
}

/**
 * One client's page-behaviour read, with every source's own status.
 *
 * Takes a fetch and a token supplier, so the guard drives the real orchestration
 * with a pretend Google and no network or database. Returns rows and run statuses;
 * writing them is `store.ts`'s job.
 *
 * EVERY SOURCE ENDS AS A STATUS, NEVER AS SILENCE. `off` is "not switched on for
 * this account", `no_key` is a secret this worker lacks, `error` is a read that
 * failed (with a message that carries no key and no token), `capped` is "read the
 * busiest pages only", `no_data` is "the source answered and had nothing". The
 * dashboard turns each into one line, because "nothing there" and "never looked"
 * lead to opposite conclusions.
 */
import { ga4Windows, readGa4Events, readGa4Pages } from "./ga4.js";
import { gscWindows, readGscPages } from "./gsc.js";
import { psiRow, readCrux, readPsi, vitalRow } from "./vitals.js";
import { safeMessage } from "./http.js";
import { siteOrigin } from "./paths.js";
import {
  CRUX_PAGES, PSI_PAGES, type BehaviourRowOut, type EventRowOut, type FetchLike, type RunOut, type VitalRowOut,
} from "./types.js";

export interface ClientCtx {
  id: string;
  name: string;
  domain: string | null;
  ga4Property: string | null;
  gscProperty: string | null;
  /** Addresses the page reader actually reached, which show whether the site uses www. */
  observedUrls: string[];
}

export interface Deps {
  fetch: FetchLike;
  /** A token for one Google scope family. Throws with a plain message where it cannot mint one. */
  token: (scope: "analytics" | "webmasters") => Promise<string>;
  /** The one Google key for field data and the lab test. */
  googleKey: string | undefined;
  /** Today, UTC, as YYYY-MM-DD. */
  today: string;
  /** Wait between calls to the same API. Zero in the guard. */
  pauseMs?: number;
}

export interface ClientResult {
  behaviour: BehaviourRowOut[];
  events: EventRowOut[];
  vitals: VitalRowOut[];
  runs: RunOut[];
  /** True where a source needed the Google key and the worker has none. */
  needsKey: boolean;
}

const run = (source: RunOut["source"], status: RunOut["status"], detail: string | null, extra: Partial<RunOut> = {}): RunOut =>
  ({ source, status, detail, rows: 0, capped: false, totalFound: null, windowEnd: null, ...extra });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function readClientBehaviour(ctx: ClientCtx, deps: Deps): Promise<ClientResult> {
  const out: ClientResult = { behaviour: [], events: [], vitals: [], runs: [], needsKey: false };
  const secrets = [deps.googleKey];
  const say = (e: unknown) => safeMessage(e, secrets);

  /* ── analytics, by page ── */
  let keep: string[] | null = null;
  let ranked: Array<{ path: string; sessions: number }> = [];
  const gaw = ga4Windows(deps.today);
  if (!ctx.ga4Property) {
    out.runs.push(run("ga4_pages", "off", "No analytics property is connected for this account."));
    out.runs.push(run("events", "off", "No analytics property is connected for this account."));
  } else {
    let token: string | null = null;
    try { token = await deps.token("analytics"); } catch (e) {
      out.runs.push(run("ga4_pages", "error", say(e)));
      out.runs.push(run("events", "error", say(e)));
    }
    if (token) {
      try {
        const r = await readGa4Pages(deps.fetch, token, ctx.ga4Property, gaw);
        out.behaviour.push(...r.rows);
        keep = r.keep; ranked = r.ranked;
        const dropped = ["userEngagementDuration", "keyEvents"].filter((m) => !r.metrics.includes(m));
        const note = dropped.length ? `The property would not return ${dropped.join(" or ")}, so those figures are blank.` : null;
        if (r.totalFound === 0) out.runs.push(run("ga4_pages", "no_data", "The property had no visits in the window.", { windowEnd: gaw.current.end }));
        else if (r.capped) out.runs.push(run("ga4_pages", "capped", [`Read the ${r.keep.length} busiest pages of ${r.totalFound}.`, note].filter(Boolean).join(" "), { rows: r.rows.length, capped: true, totalFound: r.totalFound, windowEnd: gaw.current.end }));
        else out.runs.push(run("ga4_pages", "ok", note, { rows: r.rows.length, totalFound: r.totalFound, windowEnd: gaw.current.end }));
      } catch (e) { out.runs.push(run("ga4_pages", "error", say(e))); }
      try {
        const r = await readGa4Events(deps.fetch, token, ctx.ga4Property, gaw, keep ? new Set(keep) : null);
        out.events.push(...r.rows);
        const note = r.sectionsReadable ? null : "The property cannot split events by section yet, so a click cannot be placed in a section.";
        if (!r.rows.length) out.runs.push(run("events", "no_data", "No page views were counted in the window.", { windowEnd: gaw.current.end }));
        else out.runs.push(run("events", "ok", note, { rows: r.rows.length, windowEnd: gaw.current.end }));
      } catch (e) { out.runs.push(run("events", "error", say(e))); }
    }
  }

  /* ── Search Console, by page ── */
  const gsw = gscWindows(deps.today);
  if (!ctx.gscProperty) out.runs.push(run("gsc_pages", "off", "No Search Console property is connected for this account."));
  else {
    try {
      const token = await deps.token("webmasters");
      const r = await readGscPages(deps.fetch, token, ctx.gscProperty, gsw);
      out.behaviour.push(...r.rows);
      if (r.totalFound === 0) out.runs.push(run("gsc_pages", "no_data", "Search Console had no clicks in the window.", { windowEnd: gsw.current.end }));
      else if (r.capped || r.truncatedByApi) out.runs.push(run("gsc_pages", "capped", `Read the busiest pages${r.capped ? ` (${Math.min(r.totalFound, 100)} of ${r.totalFound})` : ""}${r.truncatedByApi ? ", and the answer hit the API's row limit" : ""}.`, { rows: r.rows.length, capped: true, totalFound: r.totalFound, windowEnd: gsw.current.end }));
      else out.runs.push(run("gsc_pages", "ok", null, { rows: r.rows.length, totalFound: r.totalFound, windowEnd: gsw.current.end }));
    } catch (e) { out.runs.push(run("gsc_pages", "error", say(e))); }
  }

  /* ── Chrome field data and the lab test ── */
  const origin = siteOrigin(ctx.domain, ctx.observedUrls);
  if (!origin) {
    out.runs.push(run("crux", "off", "No website is on the record for this account."));
    out.runs.push(run("psi", "off", "No website is on the record for this account."));
  } else if (!deps.googleKey) {
    out.needsKey = true;
    const d = "The Google key (CRUX_API_KEY) is not set on the worker, so nothing was read.";
    out.runs.push(run("crux", "no_key", d));
    out.runs.push(run("psi", "no_key", d));
  } else {
    const key = deps.googleKey;
    const pages = ranked.length ? ranked.map((r) => r.path) : ["/"];
    const fieldPages = pages.slice(0, CRUX_PAGES);
    const originCache = new Map<string, VitalRowOut>();
    let ok = 0, noData = 0, errors = 0;
    const calls: Array<[string, "PHONE" | "DESKTOP"]> = [];
    for (const p of fieldPages) for (const ff of ["PHONE", "DESKTOP"] as const) calls.push([p, ff]);
    for (const [path, ff] of calls) {
      let row: VitalRowOut;
      try {
        row = vitalRow(path, "crux_url", ff, await readCrux(deps.fetch, key, { url: `${origin}${path === "/" ? "/" : path}` }, ff));
      } catch (e) { row = vitalRow(path, "crux_url", ff, { error: say(e) }); }
      if (deps.pauseMs) await sleep(deps.pauseMs);
      if (row.state === "no_data") {
        // The page is too quiet to report. The whole site may not be: say so, as the whole site.
        if (!originCache.has(ff)) {
          try { originCache.set(ff, vitalRow("*", "crux_origin", ff, await readCrux(deps.fetch, key, { origin }, ff))); }
          catch (e) { originCache.set(ff, vitalRow("*", "crux_origin", ff, { error: say(e) })); }
        }
      }
      out.vitals.push(row);
      if (row.state === "ok") ok += 1; else if (row.state === "no_data") noData += 1; else errors += 1;
    }
    for (const r of originCache.values()) { out.vitals.push(r); if (r.state === "ok") ok += 1; }
    if (ok > 0) out.runs.push(run("crux", "ok", noData ? `${noData} page reading${noData === 1 ? "" : "s"} had too few visitors for Chrome to report.` : null, { rows: out.vitals.length, totalFound: fieldPages.length }));
    else if (errors > 0 && noData === 0) out.runs.push(run("crux", "error", out.vitals.find((v) => v.state === "error")?.detail ?? "Chrome's field data could not be read."));
    else out.runs.push(run("crux", "no_data", "Chrome has too few visitors on these pages to report.", { totalFound: fieldPages.length }));

    const labPages = pages.slice(0, PSI_PAGES);
    let psiOk = 0; let psiErr: string | null = null;
    for (const path of labPages) {
      let row: VitalRowOut;
      try { row = psiRow(path, await readPsi(deps.fetch, key, `${origin}${path}`)); }
      catch (e) { psiErr = say(e); row = psiRow(path, { error: psiErr }); }
      out.vitals.push(row);
      if (row.state === "ok") psiOk += 1;
    }
    if (psiOk > 0) out.runs.push(run("psi", "ok", "A lab test, not real visitors.", { rows: psiOk, totalFound: labPages.length }));
    else out.runs.push(run("psi", psiErr ? "error" : "no_data", psiErr ?? "The lab test returned no timing."));
  }
  return out;
}

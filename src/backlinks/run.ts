/**
 * One client's link audit read. Each PART is its own try: a part that fails or hits the cap is named and its earlier stored rows are
 * kept (the store writes a part only when it was read, see store.ts). A part that was not asked for is "skipped". Nothing here writes.
 *
 * ORDER (cheapest to the money that matters first): the summary, the referring sites, the lost sites, the spam-wording sites, the
 * anchors of the client's own site, the broken-link pages, then the competitor gap (two named competitors at least).
 */
import { CapReached, estimateCall, type DfsLike } from "./api.js";
import {
  DOMAIN_ROW_CAP, PAGE, SPAM_CHUNKS, anchorsRequest, brokenRequest, domainsRequest, estimateRead, gapRequest, lostRequest, parseAnchors, parseDomain,
  parseGap, parseSummary, parseTargets, spamAnchorRequest, summaryRequest,
} from "./read.js";
import type { AuditRead, DomainOut, PartState } from "./types.js";

export interface ReadInput { own: string; competitors: readonly string[]; domainCap?: number; capUsd: number }

export function planLine(i: ReadInput): { estimatedUsd: number; line: string } {
  const e = estimateRead({ domainCap: i.domainCap ?? DOMAIN_ROW_CAP, competitors: i.competitors.length });
  const usd = e.calls * estimateCall(0) + e.rows * (estimateCall(1) - estimateCall(0));
  return { estimatedUsd: Math.round(usd * 100) / 100, line: `${i.own}: about ${e.calls} requests and up to ${e.rows.toLocaleString("en-US")} rows, about $${usd.toFixed(2)} (cap $${i.capUsd.toFixed(2)}). The estimate is ours and unverified; the real cost is read from each answer.` };
}

export async function readAudit(dfs: DfsLike, i: ReadInput): Promise<AuditRead> {
  const domainCap = i.domainCap ?? DOMAIN_ROW_CAP;
  const plan = planLine(i);
  const out: AuditRead = {
    status: "ok", detail: null, summaries: [], domains: null, targets: null, anchors: null, gap: null,
    domainsState: "skipped", domainsRead: null, domainsTotal: null, anchorsState: "skipped", anchorsRead: null, targetsState: "skipped", targetsRead: null,
    gapState: "skipped", gapRead: null, spamState: "skipped", estimatedUsd: plan.estimatedUsd, spentUsd: 0,
  };
  const notes: string[] = [];
  let stopped = false;
  const guard = async <T,>(label: string, setState: (s: PartState) => void, f: () => Promise<T>): Promise<T | null> => {
    if (stopped) { setState("capped"); return null; }
    try { return await f(); } catch (e) {
      if (e instanceof CapReached) { stopped = true; setState("capped"); notes.push(`${label}: stopped at the spend cap`); return null; }
      setState("failed"); notes.push(`${label}: ${String(e instanceof Error ? e.message : e).slice(0, 120)}`); return null;
    }
  };
  const cents = (n: number) => Math.round(n * 1e4) / 1e4;

  // 1. The summary of the own site, and the competitors' (counts only).
  const before = dfs.spent;
  await guard("summary", () => undefined, async () => {
    const r = await dfs.task("/backlinks/summary/live", summaryRequest(i.own), 1);
    const s = parseSummary(r, i.own, "own", cents(dfs.spent - before));
    if (s) out.summaries.push(s);
  });
  for (const c of i.competitors.slice(0, 3)) {
    const b = dfs.spent;
    await guard(`summary of ${c}`, () => undefined, async () => {
      const s = parseSummary(await dfs.task("/backlinks/summary/live", summaryRequest(c), 1), c, "competitor", cents(dfs.spent - b));
      if (s) out.summaries.push(s);
    });
  }
  out.domainsTotal = out.summaries.find((s) => s.role === "own")?.referringDomains ?? null;

  // 2. The referring sites, paged by rank down to the cap. What was read before a stop is kept and marked capped.
  const rows: DomainOut[] = [];
  const byName = new Map<string, DomainOut>();
  await guard("referring sites", (s) => { out.domainsState = s; }, async () => {
    let offset = 0;
    let reachedEnd = false;
    while (offset < domainCap) {
      const res = await dfs.task("/backlinks/referring_domains/live", domainsRequest(i.own, offset), PAGE);
      const items: any[] = res?.[0]?.items ?? [];
      for (const it of items) { const d = parseDomain(it, false); if (d && !byName.has(d.refDomain)) { byName.set(d.refDomain, d); rows.push(d); } }
      if (items.length < PAGE) { reachedEnd = true; break; }
      offset += PAGE;
    }
    out.domainsState = rows.length === 0 ? "no_data" : reachedEnd ? "ok" : "capped";
  });
  out.domainsRead = rows.length || null;
  if (rows.length > 0 && out.domainsState === "failed") out.domainsState = "capped";

  // 3. Lost sites. A failure here is named and does not discard the live sites.
  await guard("lost sites", () => undefined, async () => {
    const res = await dfs.task("/backlinks/referring_domains/live", lostRequest(i.own), PAGE);
    for (const it of res?.[0]?.items ?? []) {
      const d = parseDomain(it, true);
      if (!d) continue;
      const cur = byName.get(d.refDomain);
      if (cur) { cur.lostDate = d.lostDate ?? cur.lostDate; continue; }
      byName.set(d.refDomain, d); rows.push(d);
    }
  });
  if (rows.length) out.domains = rows;

  // 4. Which sites use a spam wording.
  if (rows.length) {
    let any = false;
    const flagged = new Set<string>();
    for (const chunk of SPAM_CHUNKS) {
      const done = await guard("spam wordings", (s) => { out.spamState = s; }, async () => {
        const res = await dfs.task("/backlinks/backlinks/live", spamAnchorRequest(i.own, chunk), PAGE);
        for (const it of res?.[0]?.items ?? []) { const h = String(it?.domain_from ?? "").toLowerCase().replace(/^www\./, ""); if (h) flagged.add(h); }
        return true;
      });
      if (done) any = true; else break;
    }
    if (out.spamState !== "failed" && out.spamState !== "capped") out.spamState = any ? "ok" : "skipped";
    if (out.spamState === "ok") for (const d of rows) d.spamAnchor = flagged.has(d.refDomain);
  }

  // 5. Anchors of the own site only.
  await guard("anchors", (s) => { out.anchorsState = s; }, async () => {
    const res = await dfs.task("/backlinks/anchors/live", anchorsRequest(i.own), 100);
    out.anchors = parseAnchors(res?.[0]?.items ?? []);
    out.anchorsRead = out.anchors.length;
    out.anchorsState = out.anchors.length ? "ok" : "no_data";
  });

  // 6. Pages the links land on that are dead.
  await guard("pages links land on", (s) => { out.targetsState = s; }, async () => {
    const res = await dfs.task("/backlinks/backlinks/live", brokenRequest(i.own), PAGE);
    out.targets = parseTargets(res?.[0]?.items ?? [], i.own);
    out.targetsRead = out.targets.length;
    out.targetsState = out.targets.length ? "ok" : "no_data";
  });

  // 7. The competitor gap: two named competitors at least.
  if (i.competitors.length >= 2) {
    await guard("competitor gap", (s) => { out.gapState = s; }, async () => {
      const comps = i.competitors.slice(0, 3);
      const res = await dfs.task("/backlinks/domain_intersection/live", gapRequest(i.own, comps), PAGE);
      out.gap = parseGap(res?.[0]?.items ?? [], comps, i.own);
      out.gapRead = out.gap.length;
      out.gapState = out.gap.length ? "ok" : "no_data";
    });
  }

  out.spentUsd = cents(dfs.spent);
  const states = [out.domainsState, out.anchorsState, out.targetsState, out.gapState, out.spamState];
  if (!rows.length && !out.summaries.length && !out.anchors?.length) out.status = states.includes("failed") ? "error" : states.includes("capped") ? "capped" : "no_data";
  else out.status = states.includes("capped") ? "capped" : "ok";
  out.detail = notes.length ? notes.join("; ").slice(0, 280) : null;
  return out;
}

/**
 * One run over every eligible client: plan, state the cost, then (unless this is a dry run) read and write.
 *
 * THE COST GUARD. The plan is priced BEFORE any call. A plan over the run's budget is REFUSED whole and nothing is
 * read, so a run never starts something it cannot finish inside its budget. During a run, a domain is read only while
 * what has been spent plus one more domain's estimate stays inside the budget; past that the rest are `capped`, named,
 * and keep their earlier rows. A dry run prices the plan and reads nothing, whatever the budget.
 *
 * ELIGIBLE: an active, non-internal client with the search module and a recorded site that is a real hostname. The
 * competitors are the ones a person typed (at most three), never picked here.
 */
import { safeMessage } from "../page-behaviour/http.js";
import { fits, estimateLine, estimateUsd, mayRead, money } from "./cost.js";
import { hasNothing, readDomain } from "./dfs.js";
import { normaliseDomain } from "./competitors.js";
import { writeClientBacklinks, type Queryable } from "./store.js";
import type { BacklinkRole, ClientBacklinkResult, DfsCall, DomainRead } from "./types.js";

export interface ClientInput { id: string; name: string; site: string | null; moduleSeo: boolean; competitors: string[] }

export interface Plan { id: string; name: string; domains: Array<{ domain: string; role: BacklinkRole }>; off: string | null }

export function planClient(c: ClientInput): Plan {
  if (!c.moduleSeo) return { id: c.id, name: c.name, domains: [], off: "The search module is not switched on for this account." };
  const own = normaliseDomain(c.site ?? "");
  if (!own) return { id: c.id, name: c.name, domains: [], off: "No site address is recorded for this account, or it is not a hostname." };
  const comps = c.competitors.filter((d) => d !== own);
  return { id: c.id, name: c.name, domains: [{ domain: own, role: "own" }, ...comps.map((domain) => ({ domain, role: "competitor" as const }))], off: null };
}

export interface RunResult {
  lines: string[];
  casualties: string[];
  estimateUsd: number;
  spentUsd: number;
  /** Set when the plan was over budget and nothing was read. */
  refused: string | null;
  attempted: number;
  answered: number;
  summary: string;
}

export async function processBacklinks(opts: {
  clients: readonly ClientInput[];
  call: DfsCall | null;
  today: string;
  budgetUsd: number;
  dryRun: boolean;
  db: Queryable | null;
  now?: () => Date;
  secrets?: readonly string[];
}): Promise<RunResult> {
  const res: RunResult = { lines: [], casualties: [], estimateUsd: 0, spentUsd: 0, refused: null, attempted: 0, answered: 0, summary: "" };
  const plans = opts.clients.map(planClient);
  const live = plans.filter((p) => p.domains.length > 0);
  const total = live.reduce((n, p) => n + p.domains.length, 0);
  res.estimateUsd = estimateUsd(total);
  res.lines.push(estimateLine(total, live.length, opts.budgetUsd));
  for (const p of plans) if (p.off) res.lines.push(`${p.name}: off. ${p.off}`);
  for (const p of live) res.lines.push(`${opts.dryRun ? "(dry run) " : ""}${p.name}: ${p.domains.map((d) => (d.role === "own" ? d.domain : `${d.domain} (competitor)`)).join(", ")}`);

  if (!fits(total, opts.budgetUsd)) {
    res.refused = `The plan is estimated at ${money(res.estimateUsd)}, over the run's budget of ${money(opts.budgetUsd)}. Nothing was read. Raise BACKLINKS_RUN_BUDGET_CENTS, name fewer competitors or run one client.`;
    res.lines.push(res.refused);
    if (opts.dryRun) res.lines.push("(dry run) This is only a plan: nothing is read or written either way.");
    res.summary = `refused: ${money(res.estimateUsd)} estimated against ${money(opts.budgetUsd)}`;
    return res;
  }
  if (opts.dryRun) {
    res.summary = `dry run: ${total} domain${total === 1 ? "" : "s"}, ${money(res.estimateUsd)} estimated, nothing read`;
    return res;
  }
  if (!opts.call) {
    res.summary = "no key";
    return res;
  }
  const now = opts.now ?? (() => new Date());
  for (const p of live) {
    res.attempted += 1;
    const reads: DomainRead[] = [];
    let capped = false;
    let clientSpent = 0;
    for (const d of p.domains) {
      if (!mayRead(res.spentUsd, opts.budgetUsd)) { capped = true; break; }
      const r = await readDomain(opts.call, d.domain, d.role, opts.today, opts.secrets ?? []);
      reads.push(r);
      res.spentUsd = Math.round((res.spentUsd + r.costUsd) * 10000) / 10000;
      clientSpent += r.costUsd;
    }
    const own = reads.find((r) => r.role === "own");
    const failedParts = reads.flatMap((r) => r.failed.map((f) => `${r.domain} ${f}`));
    let status: ClientBacklinkResult["status"];
    let detail: string | null = null;
    if (!own) { status = "capped"; detail = "The run's budget was spent before this account was read, so it keeps its earlier rows."; }
    else if (own.summary == null && own.newLost == null && own.topDomains == null) { status = "error"; detail = `Nothing could be read for the account's own site. ${failedParts[0] ?? ""}`.trim(); }
    else if (hasNothing(own) && !own.newLost && !(own.topDomains && own.topDomains.length)) { status = "no_data"; detail = "The provider holds no links to this site."; }
    else if (capped) { status = "capped"; detail = "The run's budget was spent before every competitor was read; those keep their earlier rows."; }
    else status = "ok";
    if (status === "ok" && failedParts.length) detail = `Some parts could not be read and keep their earlier values: ${failedParts.slice(0, 3).join("; ")}.`;
    const out: ClientBacklinkResult = { status, detail, reads, estimatedUsd: estimateUsd(p.domains.length), spentUsd: Math.round(clientSpent * 10000) / 10000 };
    if (status === "ok" || status === "capped" || status === "no_data") res.answered += 1;
    else res.casualties.push(`${p.name}: ${detail ?? status}`);
    res.lines.push(`${p.name}: ${status}, ${reads.length} of ${p.domains.length} domains read, ${money(out.spentUsd)}${detail ? `. ${detail}` : ""}`);
    if (opts.db) {
      try {
        const w = await writeClientBacklinks(opts.db, p.id, out, opts.today, now());
        if (!w.ok) res.casualties.push(`${p.name}: the rows could not be written (${w.message})`);
      } catch (e) { res.casualties.push(`${p.name}: the rows could not be written (${safeMessage(e, opts.secrets ?? [])})`); }
    }
  }
  res.summary = `${res.attempted} account${res.attempted === 1 ? "" : "s"}: ${res.answered} read, ${res.casualties.length} with a problem, ${money(res.spentUsd)} spent of ${money(opts.budgetUsd)}`;
  return res;
}

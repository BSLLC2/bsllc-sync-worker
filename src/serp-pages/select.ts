/**
 * Which searches get their top results read, and which results.
 *
 * PURE. Facts in, a plan out. The reading is the expensive, slow, polite part of
 * this job, so it is aimed at the searches where knowing what ranks above the
 * client changes the work: a search sitting just off page one (a rewrite could
 * move it), and a search that used to rank and fell. Nothing else is read.
 *
 * The caps are OURS, not a rule of any search engine or site: how many searches a
 * client gets a week, how many pages a search reads, and how long a result already
 * read is reused before it is read again. They keep the load on other people's
 * websites small (a handful of requests a week per client) and they are printed in
 * the run so a change is a conversation.
 */

/** Searches per client per run. */
export const SERP_SEARCHES_PER_CLIENT = 12;
/** Results read per search: the top of the list that is not the client's. */
export const SERP_PAGES_PER_SEARCH = 3;
/** A page already read is reused, not fetched again, for this many days. */
export const SERP_REREAD_DAYS = 28;
/** Positions that count as "just off page one". */
export const PUSH_FROM = 11;
export const PUSH_TO = 20;
/** A search that used to rank this well, and fell by at least SLIP places or out, is a loss. */
export const LOST_FROM_RANK = 20;
export const SLIP_PLACES = 10;

export interface CheckPoint { at: Date; rank: number | null; failed: boolean }
export interface SearchFact { keyword: string; device: string; points: readonly CheckPoint[] }

export type Reason = "lost" | "push";
export interface Chosen { keyword: string; device: string; reason: Reason; rank: number | null; sort: number }

/** The searches to read, most useful first, cut at the per-client cap. */
export function chooseSearches(searches: readonly SearchFact[], cap = SERP_SEARCHES_PER_CLIENT): { chosen: Chosen[]; left: number } {
  const out: Chosen[] = [];
  for (const s of searches) {
    const ok = s.points.filter((p) => !p.failed);
    const latest = ok[ok.length - 1];
    if (!latest) continue;
    const older = ok.slice(0, -1).filter((p) => p.rank != null && p.rank <= LOST_FROM_RANK);
    const best = older.reduce<number | null>((m, p) => (m == null || (p.rank as number) < m ? (p.rank as number) : m), null);
    if (best != null && (latest.rank == null || latest.rank - best >= SLIP_PLACES)) {
      out.push({ keyword: s.keyword, device: s.device, reason: "lost", rank: latest.rank, sort: best });
    } else if (latest.rank != null && latest.rank >= PUSH_FROM && latest.rank <= PUSH_TO) {
      out.push({ keyword: s.keyword, device: s.device, reason: "push", rank: latest.rank, sort: latest.rank });
    }
  }
  out.sort((a, b) => (a.reason === b.reason ? a.sort - b.sort : a.reason === "lost" ? -1 : 1) || a.keyword.localeCompare(b.keyword));
  return { chosen: out.slice(0, cap), left: Math.max(0, out.length - cap) };
}

export interface ResultFact { position: number; url: string; domain: string }

const bare = (h: string) => h.toLowerCase().replace(/^www\./, "");

/** The results to read for one search: the first few that are not the client's own site. */
export function resultsToRead(results: readonly ResultFact[], ownDomain: string, perSearch = SERP_PAGES_PER_SEARCH): ResultFact[] {
  const own = bare(ownDomain);
  return results
    .filter((r) => { const d = bare(r.domain); return d !== own && !d.endsWith(`.${own}`); })
    .slice()
    .sort((a, b) => a.position - b.position)
    .slice(0, perSearch);
}

export function reusable(readAt: Date | null, now: Date, days = SERP_REREAD_DAYS): boolean {
  return readAt != null && now.getTime() - readAt.getTime() <= days * 86_400_000 && now.getTime() >= readAt.getTime();
}

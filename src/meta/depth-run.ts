/**
 * The whole read for one Meta ad account, as a function the CLI and the guard both call.
 * Keeping it here (and not inside the CLI) is what lets `verify-meta-depth` drive the
 * real code against a pretend Graph server and a real database.
 *
 * READ-ONLY: every request is a GET through src/meta/graph.ts.
 */
import type pg from "pg";
import {
  AD_DAY_FIELDS, AD_FIELDS, ADSET_FIELDS, CAMPAIGN_FIELDS, ENTITY_TYPES, MAX_AD_DAY_ROWS, MAX_ENTITIES_PER_TYPE, MAX_SEGMENT_ROWS,
  SEGMENT_BREAKDOWNS, SEGMENT_FIELDS, SEGMENT_KINDS, buildAdDayRows, buildSegmentRows, hasSpan, metaDaysWindow, normalizeAd, normalizeAdSet, normalizeCampaign,
  reconcileEntities, sliceWindow, type EntityType, type MetaEntityRow, type Part, type SegmentDayRow,
} from "./depth.js";
import { graphList, scrubToken } from "./graph.js";
import {
  applyEntityPlan, loadOpenEntities, loadSpan, recordMetaFailure, storeAdDays, storeSegmentDays,
} from "./depth-store.js";

export interface AccountRun {
  clientId: string; clientName: string; accountId: string;
  parts: Record<Part, { ok: boolean; rows: number; note: string }>;
  problems: string[];
}

const timeRange = (w: { start: string; end: string }) => JSON.stringify({ since: w.start, until: w.end });

async function readSlices(
  token: string, accountId: string, window: { start: string; end: string }, params: Record<string, string>, rowCeiling: number, pageCeiling?: number,
): Promise<{ rows: Record<string, unknown>[]; complete: boolean; why: string | null }> {
  const rows: Record<string, unknown>[] = [];
  for (const s of sliceWindow(window)) {
    const left = rowCeiling - rows.length;
    const r = await graphList(token, `${accountId}/insights`, { time_increment: "1", time_range: timeRange(s), ...params }, { rowCeiling: left, pageCeiling });
    rows.push(...r.rows);
    if (!r.complete) return { rows, complete: false, why: r.why };
  }
  return { rows, complete: true, why: null };
}

/** Read one account's three parts. Writes only when `write` is true; a part that fails or is cut writes a failure row and nothing else. */
export async function runAccount(
  c: pg.Client | null, token: string,
  t: { clientId: string; clientName: string; accountId: string }, today: string, opts: { days?: number; write: boolean; rowCeiling?: number; pageCeiling?: number },
): Promise<AccountRun> {
  const out: AccountRun = {
    ...t, problems: [],
    parts: { ad_days: { ok: false, rows: 0, note: "" }, segments: { ok: false, rows: 0, note: "" }, entities: { ok: false, rows: 0, note: "" } },
  };
  const fail = async (part: Part, why: string) => {
    const msg = scrubToken(why).slice(0, 240);
    out.parts[part] = { ok: false, rows: 0, note: msg };
    out.problems.push(`${t.clientName} ${part}: ${msg}`);
    if (opts.write && c) await recordMetaFailure(c, t.clientId, t.accountId, part, today, msg).catch(() => {});
  };

  // A first run (no good ad-day span) reads 60 days; a refresh re-reads 14, because conversions are attributed late.
  const prevAd = c ? await loadSpan(c, t.clientId, t.accountId, "ad_days").catch(() => null) : null;
  const firstRun = !(prevAd && prevAd.ok && hasSpan(prevAd));
  const window = metaDaysWindow(today, firstRun, opts.days);

  // ── ad days ──
  try {
    const r = await readSlices(token, t.accountId, window, { level: "ad", fields: AD_DAY_FIELDS }, opts.rowCeiling ?? MAX_AD_DAY_ROWS, opts.pageCeiling);
    if (!r.complete) throw new Error(`the ad-day read is not complete (${r.why}), so nothing was written`);
    const built = buildAdDayRows(r.rows);
    if (built.unplaceable > 0) throw new Error(`${built.unplaceable} ad-day row(s) could not be placed (no id, day or spend), so nothing was written`);
    out.parts.ad_days = { ok: true, rows: built.rows.length, note: `${window.start} to ${window.end}` };
    if (opts.write && c) await storeAdDays(c, t.clientId, t.accountId, built.rows, window);
  } catch (e) { await fail("ad_days", e instanceof Error ? e.message : String(e)); }

  // ── segments: placement, age, gender. ALL THREE or nothing: a part with one breakdown missing reads as a placement that never spent. ──
  try {
    const rows: SegmentDayRow[] = [];
    for (const kind of SEGMENT_KINDS) {
      const r = await readSlices(token, t.accountId, window, { level: "adset", fields: SEGMENT_FIELDS, breakdowns: SEGMENT_BREAKDOWNS[kind] }, opts.rowCeiling ?? MAX_SEGMENT_ROWS, opts.pageCeiling);
      if (!r.complete) throw new Error(`the ${kind} breakdown is not complete (${r.why}), so no segment was written`);
      const built = buildSegmentRows(r.rows, kind);
      if (built.unplaceable > 0) throw new Error(`${built.unplaceable} ${kind} row(s) could not be placed, so no segment was written`);
      rows.push(...built.rows);
    }
    out.parts.segments = { ok: true, rows: rows.length, note: `${window.start} to ${window.end}` };
    if (opts.write && c) await storeSegmentDays(c, t.clientId, t.accountId, rows, window);
  } catch (e) { await fail("segments", e instanceof Error ? e.message : String(e)); }

  // ── entities ──
  try {
    const edges: Array<[EntityType, string, string, (r: Record<string, unknown>) => MetaEntityRow | null]> = [
      ["campaign", "campaigns", CAMPAIGN_FIELDS, normalizeCampaign],
      ["adset", "adsets", ADSET_FIELDS, normalizeAdSet],
      ["ad", "ads", AD_FIELDS, normalizeAd],
    ];
    const read: MetaEntityRow[] = [];
    const complete: EntityType[] = [];
    const why: string[] = [];
    for (const [type, edge, fields, norm] of edges) {
      try {
        const r = await graphList(token, `${t.accountId}/${edge}`, { fields }, { rowCeiling: opts.rowCeiling ?? MAX_ENTITIES_PER_TYPE, pageCeiling: opts.pageCeiling });
        const rows = r.rows.map(norm);
        const placed = rows.filter((x): x is MetaEntityRow => x != null);
        read.push(...placed);
        if (r.complete && placed.length === rows.length) complete.push(type);
        else why.push(`${type}: ${r.complete ? "a row could not be placed" : r.why}`);
      } catch (e) {
        // A type that failed closes nothing of its own; the others still stand.
        why.push(`${type}: ${scrubToken(e instanceof Error ? e.message : String(e)).slice(0, 120)}`);
      }
    }
    if (complete.length === 0) throw new Error(`no entity type could be read in full (${why.join("; ")})`);
    out.parts.entities = { ok: complete.length === ENTITY_TYPES.length, rows: read.length, note: why.length ? `partial: ${why.join("; ")}` : `${read.length} entities` };
    if (why.length) out.problems.push(`${t.clientName} entities: ${why.join("; ")}`);
    if (opts.write && c) {
      const open = await loadOpenEntities(c, t.clientId, t.accountId);
      const plan = reconcileEntities({ open, read, on: today, completeTypes: complete });
      await applyEntityPlan(c, t.clientId, t.accountId, plan, today, read.length, out.parts.entities.note);
    }
  } catch (e) { await fail("entities", e instanceof Error ? e.message : String(e)); }

  return out;
}

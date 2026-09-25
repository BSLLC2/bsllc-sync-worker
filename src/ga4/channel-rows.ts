/**
 * The per-channel half of the GA4 import: a dimensioned report in, one row per
 * channel per month out.
 *
 * Its own file because src/import-ga4.ts ends in a main() call, so anything
 * defined there can only be exercised by running the importer against a real
 * property. `npm run verify-ga4-channels` drives everything here with no
 * database, no network and no GA4 access.
 *
 * ── WHAT WAS BLIND ─────────────────────────────────────────────────────────
 *
 * This importer asked GA4 for `yearMonth` and nothing else and wrote three
 * keys: sessions, conversions, revenue. One number a month for a whole site.
 * So nothing in the dashboard could say which SOURCE of a client's traffic
 * produced any of it, for one client or for all of them — and no reading of
 * return on spend by marketing channel was possible anywhere.
 *
 * It surfaced by hand: a GA4 Explore report on one client showed paid social
 * sending several times the visits paid search did over 28 days and producing
 * no purchases, while paid search produced nine. We run that channel for them.
 * Those figures were read off a live screen by a person; nothing in this
 * repository measured them and no fixture here is a record of them.
 *
 * ── TWO REPORTS, NOT ONE. THIS IS THE LOAD-BEARING DECISION ────────────────
 *
 * The obvious change is to put the channel dimension on the report that
 * already runs and add the rows back up for the totals. DO NOT. GA4's totals
 * are not always the sum of a dimensioned breakdown of themselves: sampling,
 * thresholding and its own "(other)" bucket each move them. Deriving the three
 * existing keys from a channel breakdown would therefore change every
 * sessions, conversion and revenue figure the dashboard shows, on every
 * client, with nothing failing anywhere. The aggregate call in import-ga4.ts
 * is untouched, and the breakdown is a SECOND call whose rows never feed it.
 *
 * The two live in different places for the same reason: the aggregate goes to
 * metric_snapshots as it always has, and these go to client_channel_metrics
 * (app schema v201), which nothing that reads the blended keys touches.
 *
 * ── WHAT A CHANNEL'S NOUGHT MEANS ──────────────────────────────────────────
 *
 * The rule the aggregate already follows (metric-evidence.ts): GA4 answers 0
 * both for "nobody converted" and for "no key event is configured", and never
 * says which. Evidence is a PROPERTY-WIDE fact, so the window used here is the
 * property's own, handed in from the aggregate call rather than recomputed —
 * one channel converting once is what makes every other channel's nought a
 * real nought. Without it, a whole channel reading would be measuring the
 * absence of a key event on the property.
 *
 * ── THE LABEL IS WHATEVER GOOGLE SAID ──────────────────────────────────────
 *
 * No mapping, no renaming, no slug, no folding an unfamiliar label into the
 * one it most resembles — the failure ads/structure-snapshot.ts refuses with
 * UNRECOGNISED. The channel is a COLUMN in the app's table, so it is stored
 * verbatim and never parsed back out of anything. Google's default grouping is
 * a closed set it occasionally adds to; a label this build has never seen is
 * data, and it lands under its own name.
 */

/**
 * How many months back the breakdown asks for, counting the current one.
 *
 * NOTHING IS BACKFILLED, and this is where that decision lives. The aggregate
 * call re-reads from --since (2023 by default) on every run because it is three
 * rows a month; a channel breakdown multiplies that by however many channels a
 * property reports, so the same "read everything, every time" would write the
 * whole of a client's history into client_channel_metrics the first time this
 * shipped. That is a backfill, and a backfill is somebody's decision rather
 * than a side effect of a deploy.
 *
 * Three is the smallest window that is CORRECT. GA4 restates a month for some
 * days after it closes, so the month just gone has to stay in the window long
 * enough for its final figures to land — two months is the minimum for that,
 * and the third is slack for a run that was down for a fortnight. The write is
 * an upsert keyed on (client, source, period, channel), so a month inside the
 * window is rewritten and never duplicated.
 *
 * `--channel-months=N` widens it, which is how a backfill is performed when
 * somebody decides to: one call per property either way, N months of rows.
 * `--channel-months=0` turns the breakdown off entirely.
 */
export const DEFAULT_CHANNEL_MONTHS = 3;

/**
 * The start date the breakdown asks from, as YYYY-MM-DD.
 *
 * Never earlier than the aggregate's own `since`: a window that reached back
 * past what the rest of the import reads would put months in one table that
 * have no counterpart in the other.
 */
export function channelSince(months: number, aggregateSince: string, now: Date): string {
  if (months <= 0) return "";
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
  const ymd = first.toISOString().slice(0, 10);
  return aggregateSince && aggregateSince > ymd ? aggregateSince : ymd;
}

/** One month of one channel, on its way to the dashboard's sync contract. */
export interface ChannelMetricRow {
  client_id: string;
  source: "ga4";
  external_id: string;
  /** YYYY-MM. */
  period: string;
  /** Verbatim, as the platform reported it. */
  channel: string;
  /** Null is unanswered, never a nought. */
  sessions: number | null;
  conversions: number | null;
  revenue_cents: number | null;
}

/**
 * More distinct channel groups than this and the property is reporting
 * something other than the default grouping — a custom one, or a dimension
 * that is not a channel at all. None of it is written, and the run says so.
 * Google's default set is nineteen labels; the headroom is for what it adds.
 */
export const MAX_CHANNELS = 40;

/** The longest label the app's table stores. Copied here so a row that would
 *  be refused on arrival is named by the run that produced it instead of
 *  disappearing into a sync summary. See shared/channel-metrics.ts. */
export const CHANNEL_LABEL_MAX = 120;

/** What one property's breakdown produced, for the run's own output. */
export interface ChannelOutcome {
  rows: ChannelMetricRow[];
  channels: number;
  months: number;
  /** Labels that cannot be stored, named and never trimmed to fit. */
  refusedLabels: string[];
  /** Rows GA4 returned that carried no usable month. */
  droppedRows: number;
  /** Why nothing was written, when nothing was. */
  refused: string | null;
}

/** "202609" or "2026-09" → "2026-09", else null. */
export function periodFromYearMonth(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (/^\d{6}$/.test(s)) {
    const month = Number(s.slice(4, 6));
    if (month < 1 || month > 12) return null;
    return `${s.slice(0, 4)}-${s.slice(4, 6)}`;
  }
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(s)) return s;
  return null;
}

/** Has this property ever reported a non-zero figure for the metric? One is
 *  enough. Kept in step with metric-evidence.ts, which decides the same thing
 *  for the blended keys. */
function everReported(window: Array<number | null | undefined>): boolean {
  return window.some((v) => typeof v === "number" && Number.isFinite(v) && v > 0);
}

/** The value to write, given what the whole property shows. */
function evidenced(value: number, window: Array<number | null | undefined>): number | null {
  if (!Number.isFinite(value)) return null;
  if (value > 0) return value;
  return everReported(window) ? value : null;
}

/**
 * One property's channel breakdown.
 *
 * `report` is the GA4 runReport body for dimensions [yearMonth,
 * sessionDefaultChannelGroup] and metrics [sessions, <conversions>,
 * totalRevenue], in that order — the order is the contract between this and
 * the call that makes it, and both live in import-ga4.ts.
 *
 * `convWindow` and `revWindow` are the PROPERTY's own histories from the
 * aggregate call, handed in so the evidence rule cannot say one thing about
 * the site and another about a channel of it.
 */
export function channelRows(
  report: unknown,
  opts: {
    clientId: string;
    propertyId: string;
    convWindow: Array<number | null | undefined>;
    revWindow: Array<number | null | undefined>;
  },
): ChannelOutcome {
  const body = (report ?? {}) as { rows?: unknown[] };
  const raw: any[] = Array.isArray(body.rows) ? body.rows : [];
  const out: ChannelOutcome = {
    rows: [], channels: 0, months: 0, refusedLabels: [], droppedRows: 0, refused: null,
  };

  const labels = new Set<string>();
  for (const row of raw) {
    const label = String(row?.dimensionValues?.[1]?.value ?? "").trim();
    if (label) labels.add(label);
  }
  if (labels.size > MAX_CHANNELS) {
    out.refused =
      `${labels.size} distinct channel labels, past the ${MAX_CHANNELS} a default channel grouping can produce — ` +
      `this property is reporting something else and none of it was written`;
    return out;
  }

  const months = new Set<string>();
  const seen = new Set<string>();
  const refused = new Set<string>();
  for (const row of raw) {
    const period = periodFromYearMonth(row?.dimensionValues?.[0]?.value);
    const label = String(row?.dimensionValues?.[1]?.value ?? "").trim();
    if (!period) { out.droppedRows++; continue; }
    // A label with nothing in it, or longer than the column stores, is NAMED
    // and dropped. Trimming it to fit would merge two channels into one row on
    // the other side — the unique key ends in the channel — and the merged
    // figure would then read as a measurement of one of them.
    if (!label) { refused.add("(an empty label)"); continue; }
    if (label.length > CHANNEL_LABEL_MAX) { refused.add(`${label.slice(0, 40)}… (${label.length} characters)`); continue; }
    // GA4 can return the same (month, channel) pair only once, but a malformed
    // report or a future dimension order change could. The first one wins and
    // the rest are dropped rather than overwriting it, because two rows for one
    // key means the report is not what this code was told it is.
    const key = `${period}\u0000${label}`;
    if (seen.has(key)) { out.droppedRows++; continue; }
    seen.add(key);

    const sessions = Number(row?.metricValues?.[0]?.value ?? 0);
    const conversions = Number(row?.metricValues?.[1]?.value ?? 0);
    const revenue = Number(row?.metricValues?.[2]?.value ?? 0);
    months.add(period);
    out.rows.push({
      client_id: opts.clientId,
      source: "ga4",
      external_id: opts.propertyId,
      period,
      channel: label,
      sessions: Number.isFinite(sessions) ? sessions : null,
      conversions: evidenced(conversions, opts.convWindow),
      revenue_cents: (() => {
        const cents = evidenced(Math.round(revenue * 100), opts.revWindow);
        return cents;
      })(),
    });
  }
  out.channels = new Set(out.rows.map((r) => r.channel)).size;
  out.months = months.size;
  out.refusedLabels = Array.from(refused);
  return out;
}

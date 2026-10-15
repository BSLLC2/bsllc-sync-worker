/**
 * What the four newer readers share: one per-account status table, one place a
 * pretend server can stand in for the real one, one Google token door.
 *
 * The readers are Search Console URL Inspection, Google Business Profile
 * performance, Bing Webmaster Tools and the CallTrackingMetrics call log. Each is
 * its own job with its own workflow and heartbeat. They share this file because
 * "what a run of a source can end as" must mean the same thing in all four, and
 * because the app reads one status table (`signal_runs`) for all of them.
 *
 * EVERY SOURCE ENDS AS A STATUS, NEVER AS SILENCE. `off` is "not switched on for
 * this account", `no_key` / `no_token` is a secret this worker lacks, `error` is a
 * read that failed (with a message that carries no key and no token), `capped` is
 * "read part of it, by our own cap or the source's", `no_data` is "the source
 * answered and had nothing". The dashboard turns each into one line, because
 * "nothing there" and "never looked" lead to opposite conclusions.
 *
 * THE TEST SEAM. When SIGNALS_FAKE_BASE is set (and only then) every call to one of
 * the four services goes to that address, under /gsc, /gbp, /bing or /ctm, and a
 * Google token is asked of `<base>/token`. No workflow sets it, and each reader's
 * guard fails if one does.
 */
import type { Queryable } from "../page-behaviour/store.js";

export const SIGNAL_SOURCES = ["gsc_inspect", "gbp", "bing", "ctm"] as const;
export type SignalSource = (typeof SIGNAL_SOURCES)[number];

/** What a run of one source can end as. The same words as `seo_ux_runs`. */
export const SIGNAL_STATUSES = ["ok", "off", "no_key", "no_token", "error", "capped", "no_data"] as const;
export type SignalStatus = (typeof SIGNAL_STATUSES)[number];

export interface SignalRunOut {
  source: SignalSource;
  status: SignalStatus;
  detail: string | null;
  rows: number;
  capped: boolean;
  totalFound: number | null;
  windowEnd: string | null;
}

export const signalRun = (source: SignalSource, status: SignalStatus, detail: string | null, extra: Partial<SignalRunOut> = {}): SignalRunOut =>
  ({ source, status, detail, rows: 0, capped: false, totalFound: null, windowEnd: null, ...extra });

/** Literal column list on purpose: the app's `verify:wiring` reads it against shared/schema.ts both ways. */
export const INSERT_SIGNAL_RUN = `INSERT INTO signal_runs
  (client_id, source, status, detail, rows, capped, total_found, window_end, ran_at)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
 ON CONFLICT (client_id, source) DO UPDATE SET
   status = EXCLUDED.status, detail = EXCLUDED.detail, rows = EXCLUDED.rows, capped = EXCLUDED.capped,
   total_found = EXCLUDED.total_found, window_end = EXCLUDED.window_end, ran_at = EXCLUDED.ran_at`;

export async function writeSignalRun(c: Queryable, clientId: string, r: SignalRunOut, at: Date): Promise<void> {
  await c.query(INSERT_SIGNAL_RUN, [clientId, r.source, r.status, r.detail, r.rows, r.capped, r.totalFound, r.windowEnd, at]);
}

/* ── the test seam ── */

export const signalsFakeBase = (): string | null => process.env.SIGNALS_FAKE_BASE?.trim() || null;

/** The address to call: the real one, or the pretend server's path for the same service. */
export function serviceUrl(service: "gsc" | "gbp" | "bing" | "ctm" | "oauth", real: string): string {
  const fake = signalsFakeBase();
  if (!fake) return real;
  const u = new URL(real);
  return `${fake.replace(/\/+$/, "")}/${service}${u.pathname}${u.search}`;
}

/* ── small helpers every reader uses ── */

export const ymd = (d: Date): string => d.toISOString().slice(0, 10);
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** A string field from an API answer: trimmed, cut, and null where it is not a non-empty string. */
export function text(v: unknown, max = 300): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}
/** A number from an API answer, or null. A string of digits is a number; anything else is not. */
export function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

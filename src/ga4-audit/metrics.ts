/**
 * ONE DEFINITION PER METRIC, and one way to print a figure.
 *
 * Every section of the report takes its figures from these definitions, so two
 * sections cannot mean different things by the same word. The glossary is printed
 * once at the top of the report.
 *
 * LABELS. Every figure is labelled "confirmed from data" (read from Google, or an
 * exact sum or ratio of figures read from Google) or "inference" (a reading we
 * made: a cause, a classification, a projection, an expectation). A table column
 * has to say which, and `column()` refuses to build one without it.
 */
export type Basis = "confirmed from data" | "inference";
export type Unit = "count" | "percent" | "seconds" | "position" | "ratio" | "text";

export interface Column { key: string; title: string; basis: Basis; unit: Unit }

export function column(key: string, title: string, basis: Basis, unit: Unit = "count"): Column {
  if (basis !== "confirmed from data" && basis !== "inference") throw new Error(`Column "${title}" has no basis label.`);
  return { key, title, basis, unit };
}

export interface Table {
  id: string;
  title: string;
  /** The date range or ranges every figure in the table covers. Required. */
  range: string;
  /** What was left out of the table, in words. Required ("none" is an answer). */
  filter: string;
  columns: Column[];
  rows: Array<Record<string, string | number | null | undefined>>;
  note?: string;
}

export function table(t: Table): Table {
  if (!t.range.trim()) throw new Error(`Table "${t.title}" has no date range.`);
  if (!t.filter.trim()) throw new Error(`Table "${t.title}" has no filter statement.`);
  if (t.columns.length === 0) throw new Error(`Table "${t.title}" has no columns.`);
  return t;
}

/* ───────────────────── the definitions ───────────────────── */

export interface Definition { term: string; means: string }
export const DEFINITIONS: Definition[] = [
  { term: "Session", means: "One visit to the site, as Google Analytics counts it. Not a person: one person can make many." },
  { term: "Engaged session", means: "A visit that lasted at least 10 seconds, or had a form submit event or a key event, or viewed two or more pages." },
  { term: "Engagement rate", means: "Engaged sessions divided by sessions. Our figure, worked out from those two counts." },
  { term: "Average engagement time", means: "Seconds the page was in front of the visitor, summed, divided by sessions (per session). The per-active-user figure is shown where it matters." },
  { term: "Form submit event", means: "One firing of the form_submit event. It is NOT an enquiry, a lead or a conversion. It also fires on the homepage advisor search and the advisor directory, and it counts repeats and failed tries." },
  { term: "Real traffic", means: "Sessions left after the exclusions named beside each figure. Our rule, not Google's." },
  { term: "Complete month", means: "A calendar month that has fully ended. Only complete months are compared." },
  { term: "Page-based session", means: "A session that viewed a given page at any point, not only one that started there. One session can count on several pages, so page figures do not add up to the site total." },
  { term: "Landing page", means: "The first page of a session." },
];

/* ───────────────────── arithmetic ───────────────────── */

/** a / b, or null when b is missing or zero. Never a nought standing in for "cannot divide". */
export const ratio = (a: number | null | undefined, b: number | null | undefined): number | null =>
  a == null || b == null || b === 0 ? null : a / b;

export const sum = (xs: Array<number | null | undefined>): number => xs.reduce<number>((n, x) => n + (x ?? 0), 0);

/** Change of `now` against `before` as a fraction, or null when there is nothing to compare with. */
export const change = (now: number | null, before: number | null): number | null =>
  now == null || before == null || before === 0 ? null : (now - before) / before;

/* ───────────────────── printing ───────────────────── */

const group = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export function fmt(v: number | string | null | undefined, unit: Unit): string {
  if (v == null || v === "") return "n/a";
  if (typeof v === "string") return v;
  if (!Number.isFinite(v)) return "n/a";
  switch (unit) {
    case "count": return group(v);
    case "percent": return `${(v * 100).toFixed(1)}%`;
    case "position": return v.toFixed(1);
    case "ratio": return v.toFixed(2);
    case "seconds": {
      const s = Math.round(v);
      return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
    }
    case "text": return String(v);
  }
}

/** "+12.3%" or "-4.0%" or "n/a". */
export function fmtChange(c: number | null): string {
  if (c == null || !Number.isFinite(c)) return "n/a";
  return `${c >= 0 ? "+" : "-"}${Math.abs(c * 100).toFixed(1)}%`;
}

/** A single labelled figure for prose: "37,863 sessions (confirmed from data; Jan 1 to Sep 30, 2026; ...)". */
export function stat(value: number | null, unit: Unit, noun: string, basis: Basis, range: string, filter: string): string {
  if (!range.trim() || !filter.trim()) throw new Error(`A figure for "${noun}" has no range or filter.`);
  return `${fmt(value, unit)}${noun ? ` ${noun}` : ""} (${basis}; ${range}; ${filter})`;
}

/**
 * A sheet, as the framework sees it: headings, and rows of text. Both sources
 * (Smartsheet, Google Sheets) are turned into this before anything is decided,
 * so one reader serves both. Pure.
 */
import { normHeader, ROLE_NAMES, type LayoutSpec, type RoleName, type TrackerConfig } from "./config.js";

export interface Table {
  headers: string[];
  /** Smartsheet column type for each heading, when the source says (TEXT_NUMBER, DATE, PICKLIST, CHECKBOX ...). */
  types: (string | null)[];
  hidden: boolean[];
  /** A picklist's declared options (the column's definition, not row values). Null for any other column. */
  options: (string[] | null)[];
  rows: string[][];
  /** The row number a person sees in the sheet, one per row. */
  rowNumbers: number[];
  /** What the source says the sheet holds, when it says. Null: unknown. */
  totalRows: number | null;
}

export interface RoleFound { index: number; header: string }
export interface RoleProblem { role: RoleName; headers: string[] }
export type Resolution =
  | { ok: true; found: Partial<Record<RoleName, RoleFound>>; ambiguousOptional: RoleProblem[] }
  | { ok: false; reason: "missing" | "duplicate"; missing: RoleName[]; duplicate: RoleProblem[]; found: Partial<Record<RoleName, RoleFound>> };

/** The lead-key roles: what a sheet of LEADS (not outcomes) carries. */
const LEAD_ROLES: readonly RoleName[] = ["gclid", "email", "phone", "formId", "firstContact", "name"];

export interface LayoutResolution {
  /** The layout that resolved, or the closest one when none did. */
  layout: string;
  /** The config to read with: the chosen layout's roles and source words. */
  cfg: TrackerConfig;
  res: Resolution;
  /** Every layout tried, with how it came out. For the diagnose report. */
  tried: { layout: string; ok: boolean; found: number; missing: RoleName[]; duplicate: RoleProblem[] }[];
  /** None resolved, no outcome column was found, and lead columns were: the sheet lists leads, not sales. */
  leadListOnly: boolean;
}

/** Tries the primary layout and then each alternative; the first that resolves wins. */
export function resolveLayouts(headers: readonly string[], base: TrackerConfig): LayoutResolution {
  const layouts: LayoutSpec[] = [{ name: base.layoutName, roles: base.roles, ourSourceValues: base.ourSourceValues }, ...base.altLayouts];
  const present = new Set(headers.map(normHeader));
  const gateFails = (l: LayoutSpec) =>
    (l.requireAny ? !l.requireAny.some((h) => present.has(normHeader(h))) : false) ||
    (l.refuseIfAny ? l.refuseIfAny.some((h) => present.has(normHeader(h))) : false);
  const tried: LayoutResolution["tried"] = [];
  let best: { layout: (typeof layouts)[number]; cfg: TrackerConfig; res: Resolution; n: number } | null = null;
  for (const l of layouts) {
    const cfg: TrackerConfig = { ...base, layoutName: l.name, roles: l.roles, ourSourceValues: l.ourSourceValues };
    const res = resolveRoles(headers, cfg);
    const n = Object.keys(res.found).length;
    if (gateFails(l)) {
      // This layout does not describe the sheet. It never resolves and is never the "closest" one.
      tried.push({ layout: l.name, ok: false, found: n, missing: [], duplicate: [] });
      continue;
    }
    tried.push({ layout: l.name, ok: res.ok, found: n, missing: res.ok ? [] : res.missing, duplicate: res.ok ? [] : res.duplicate });
    if (res.ok) return { layout: l.name, cfg, res, tried, leadListOnly: false };
    if (!best || n > best.n) best = { layout: l, cfg, res, n };
  }
  if (!best) {
    // Every layout was gated out (the first is never gated; kept for safety).
    const l = layouts[0]!;
    const cfg: TrackerConfig = { ...base, layoutName: l.name, roles: l.roles, ourSourceValues: l.ourSourceValues };
    best = { layout: l, cfg, res: resolveRoles(headers, cfg), n: 0 };
  }
  const b = best;
  const outcomes: RoleName[] = ["status", "amount", "closedDate"];
  const leadListOnly = outcomes.every((r) => !b.res.found[r]) && LEAD_ROLES.filter((r) => b.res.found[r]).length >= 2;
  return { layout: b.layout.name, cfg: b.cfg, res: b.res, tried, leadListOnly };
}

/** Roles claim columns in this order; a column serves one role only. */
const CLAIM_ORDER: readonly RoleName[] = ["status", "amount", "closedDate", "source", "confirmFlag", "firstContact", "gclid", "rowLabel", "type", "email", "phone", "formId", "name"];

export function resolveRoles(headers: readonly string[], cfg: TrackerConfig): Resolution {
  const claimed = new Set<number>();
  const found: Partial<Record<RoleName, RoleFound>> = {};
  const missing: RoleName[] = [];
  const duplicate: RoleProblem[] = [];
  const ambiguousOptional: RoleProblem[] = [];
  const normed = headers.map(normHeader);
  for (const role of CLAIM_ORDER) {
    const spec = cfg.roles[role];
    if (!spec) continue;
    const want = new Set(spec.aliases.map(normHeader));
    const hits = normed.map((h, i) => (h && want.has(h) && !claimed.has(i) ? i : -1)).filter((i) => i >= 0);
    if (hits.length === 1) { claimed.add(hits[0]!); found[role] = { index: hits[0]!, header: headers[hits[0]!]! }; }
    else if (hits.length === 0) { if (spec.required) missing.push(role); }
    else if (spec.required) duplicate.push({ role, headers: hits.map((i) => headers[i]!) });
    else ambiguousOptional.push({ role, headers: hits.map((i) => headers[i]!) });
  }
  if (missing.length) return { ok: false, reason: "missing", missing, duplicate, found };
  if (duplicate.length) return { ok: false, reason: "duplicate", missing, duplicate, found };
  return { ok: true, found, ambiguousOptional };
}

/** The role names the sheet's headings did not match, in config order. Used by the diagnose report only. */
export const unresolvedRoles = (found: Partial<Record<RoleName, RoleFound>>, cfg: TrackerConfig): RoleName[] =>
  ROLE_NAMES.filter((r) => cfg.roles[r] && !found[r]);

// ── Cells ────────────────────────────────────────────────────────────────────

/** "$60,910.40", "60910.4" and " 1,200 " all read; anything else (a negative, nought, "#REF!") is null. */
export function parseAmountCents(v: unknown): number | null {
  const s = String(v ?? "").trim().replace(/[$,\s]/g, "");
  if (!s || !/^\d+(\.\d{1,4})?$/.test(s)) return null;
  const cents = Math.round(Number(s) * 100);
  return Number.isFinite(cents) && cents > 0 ? cents : null;
}

/**
 * A closed date from an ISO date or datetime, or a typed US date. Impossible
 * dates (13/45/2025) are null, never rolled forward. Month-first for slashes.
 */
export function parseDay(v: unknown): string | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  let y: number, m: number, d: number;
  let hit = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:$|[T\s])/);
  if (hit) { y = Number(hit[1]); m = Number(hit[2]); d = Number(hit[3]); }
  else if ((hit = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})$/))) {
    m = Number(hit[1]); d = Number(hit[2]); y = Number(hit[3]); if (y < 100) y += 2000;
  } else return null;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
  const back = new Date(Date.UTC(y, m - 1, d));
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** A click id is an opaque token. Anything with a space, comma, quote or control character is not one. */
export const isClickId = (v: string): boolean => /^[A-Za-z0-9_\-.]{8,200}$/.test(v);

/** A row label is shown on the card. Only a short, number-bearing reference (an RFQ number) may be one: a name never is. */
export function safeLabel(v: string): string | null {
  const t = v.replace(/\s+/g, " ").trim();
  if (!t || t.length > 20 || !/\d/.test(t) || t.split(" ").length > 2) return null;
  return /^[A-Za-z0-9#._\-/ ]+$/.test(t) ? t : null;
}

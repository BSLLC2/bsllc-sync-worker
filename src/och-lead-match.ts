/**
 * Tying an admission on OCH's board to a lead we hold — pure, so the path can
 * be proved without a database.
 *
 * This is the RESCUE. The Referent cell is hand-typed, and intake often write
 * the clinical partner who processed a case rather than how the patient first
 * found OCH, so an admission we really sourced can read as somebody else's.
 * Matching the admission back to a lead in `web_inquiries` catches those. It is
 * the only thing that does, which is why it lives in one tested place instead
 * of inline in a 500-line importer: on 2026-09-15 lifetime attribution moved
 * 51 → 49 and it took two workflow logs to say whether this path had gone
 * quiet or had simply stopped counting something it should never have counted.
 *
 * TWO INDEXES, because "we have this person's enquiry" and "we know which
 * channel produced it" are different claims:
 *
 *   attributing — a live capture AND observed channel evidence (a gclid, or a
 *                 marketing utm_source/utm_medium). Only these can make an
 *                 admission ours.
 *   all         — every lead we hold, including rows a person typed in from
 *                 the client's own export. Those prove an enquiry happened and
 *                 nothing about a channel (lead-provenance.ts), so they never
 *                 attribute — but a reader asking "did we have this person at
 *                 all" deserves a real answer instead of a dash that also
 *                 means "we have never heard of them".
 */
import { phone10, lastDobKey } from "./lead-keys.js";
import { provenanceOf } from "./lead-provenance.js";

/**
 * The "is this a marketing channel" word-set applied to a lead's OWN
 * utm_source/utm_medium — the sibling of och-attribution.ts's list, which
 * reads the sheet's hand-typed Referent instead. A gclid alone already implies
 * paid search, so any gclid counts whatever the utm text says.
 */
export const ATTRIBUTABLE_UTM_WORDS = new Set([
  "google", "adwords", "ads", "ppc", "sem", "cpc", "search",
  "web", "webform", "website", "online", "form", "organic",
  "facebook", "fb", "meta", "instagram", "ig", "social", "paid", "gbp", "gmb",
]);

/** A `web_inquiries` row, reduced to what a match needs. No name, no email. */
export interface LeadRow {
  phone: string | null;
  dob: string | null;
  lastName: string | null;
  gclid: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  rawJson: string | null;
  submittedAt: Date;
}

export type LeadEvidence = "gclid" | "utm" | "none";

export interface Lead {
  submittedAt: Date;
  /** What the row observed about the channel. "none" can never attribute. */
  evidence: LeadEvidence;
  utm: string;
  /** Typed in from the client's own export: a real lead, no channel evidence. */
  typedIn: boolean;
}

interface Keyed { byPhone: Map<string, Lead[]>; byLastDob: Map<string, Lead[]> }

export interface LeadIndex {
  /** Live captures carrying channel evidence — the only ones that attribute. */
  attributing: Keyed;
  /** Every lead we hold, whatever its provenance. Proves an enquiry only. */
  all: Keyed;
  counts: { total: number; typedIn: number; attributing: number };
}

const emptyKeyed = (): Keyed => ({ byPhone: new Map(), byLastDob: new Map() });
function add(into: Keyed, row: LeadRow, lead: Lead): void {
  const p = phone10(row.phone);
  if (p) into.byPhone.set(p, [...(into.byPhone.get(p) ?? []), lead]);
  const ld = lastDobKey(row.lastName, row.dob);
  if (ld) into.byLastDob.set(ld, [...(into.byLastDob.get(ld) ?? []), lead]);
}

export function buildLeadIndex(rows: LeadRow[]): LeadIndex {
  const index: LeadIndex = { attributing: emptyKeyed(), all: emptyKeyed(), counts: { total: 0, typedIn: 0, attributing: 0 } };
  for (const row of rows) {
    const typedIn = provenanceOf(row.rawJson) === "backfilled";
    const hasGclid = !!row.gclid?.trim();
    const utmWords = `${row.utmSource ?? ""} ${row.utmMedium ?? ""}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const utmAttributable = utmWords.some((w) => ATTRIBUTABLE_UTM_WORDS.has(w));
    const lead: Lead = {
      submittedAt: row.submittedAt,
      // A typed-in row asserts no channel even when its columns carry one: the
      // export it came from never held a click. Excluded BY PROVENANCE, not by
      // the columns happening to look empty.
      evidence: typedIn ? "none" : hasGclid ? "gclid" : utmAttributable ? "utm" : "none",
      utm: [row.utmSource, row.utmMedium].filter((x) => x?.trim()).join("/"),
      typedIn,
    };
    index.counts.total++;
    if (typedIn) index.counts.typedIn++;
    add(index.all, row, lead);
    if (lead.evidence !== "none") {
      index.counts.attributing++;
      add(index.attributing, row, lead);
    }
  }
  return index;
}

/**
 * A lead only explains an admission that came AFTER it and reasonably soon
 * after it — an enquiry from a year earlier does not make this month's
 * professional referral ours.
 */
export const MATCH_WINDOW_DAYS = 180;

export function leadWithin(list: Lead[] | undefined, admittedOn: Date): Lead | null {
  if (!list?.length) return null;
  const t = admittedOn.getTime();
  return list.find((l) => l.submittedAt.getTime() <= t + 86_400_000 && l.submittedAt.getTime() >= t - MATCH_WINDOW_DAYS * 86_400_000) ?? null;
}

export type MatchVia = "web_inquiry_phone" | "web_inquiry_dob" | null;

export interface LeadVerdict {
  /** The lead that makes this admission ours, if any. */
  attributing: Lead | null;
  via: MatchVia;
  /** Any lead we hold for this person, attributing or not. */
  known: Lead | null;
}

/** Match one admission against the index: phone first, then lastname+DOB. */
export function matchAdmission(index: LeadIndex, keys: { phone: string | null; lastDob: string | null }, admittedOn: Date): LeadVerdict {
  const pick = (k: Keyed): { lead: Lead | null; via: MatchVia } => {
    const byPhone = keys.phone ? leadWithin(k.byPhone.get(keys.phone), admittedOn) : null;
    if (byPhone) return { lead: byPhone, via: "web_inquiry_phone" };
    const byDob = keys.lastDob ? leadWithin(k.byLastDob.get(keys.lastDob), admittedOn) : null;
    return byDob ? { lead: byDob, via: "web_inquiry_dob" } : { lead: null, via: null };
  };
  const attributing = pick(index.attributing);
  const known = attributing.lead ?? pick(index.all).lead;
  return { attributing: attributing.lead, via: attributing.via, known };
}

/** How the readout says what a lead proves, in a person's words. */
export function leadLine(v: LeadVerdict): string {
  if (v.attributing) return v.attributing.evidence === "gclid" ? "our lead, ad click" : "our lead, captured form";
  if (v.known?.typedIn) return "our lead, typed in";
  if (v.known) return "our lead, no tracking";
  return "—";
}

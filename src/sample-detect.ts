/**
 * Does a CRM record belong to the client's business, or to the demo data the
 * platform shipped with?
 *
 * WHY THIS IS NOT A WORD LIST
 * ---------------------------
 * It was one, and the word list is what failed. `looksLikeSample()` matched a
 * catalogue of stock company names against a record's name, its contact's
 * name and their email. An org whose stock records carried none of those
 * three words in any of those three fields therefore read as entirely
 * genuine — and roughly 60% of that org's twelve-month "revenue" was demo
 * data flowing through the attribution chain as real money. The list is one
 * signal here now, and the one trusted least: it can only ever catch the
 * records somebody remembered to name.
 *
 * WHAT IS ACTUALLY KNOWABLE
 * -------------------------
 * Nothing here can ask a CRM "is this row demo data" — no platform we read
 * answers that question, so THE HONEST ANSWER IS THAT WE OFTEN CANNOT TELL.
 * What is visible is HOW a row arrived. Business happens one record at a
 * time, at the time it happens. Demo data is written in one shot and dated
 * backwards across years so the charts look populated. That shape — a batch
 * of records committed inside a single minute, carrying business dates spread
 * over a long history, often stamped by the platform's own import machinery —
 * is visible without knowing a single name.
 *
 * It is also the shape of a client migrating their own real history, which is
 * precisely why this produces SUSPICION, not exclusion. Two lanes:
 *
 *   confirmed — we are sure (a catalogue name). Never counted, as before.
 *   suspect   — it arrived like an import. STILL COUNTED, and said out loud
 *               on every figure it is inside, until a person rules on it.
 *               Silently dropping a client's real revenue is the same size of
 *               mistake as silently counting demo data, in the other
 *               direction. So neither is done quietly.
 *
 * Pure: no network, no database, no clock. `npm run verify-zero-vs-nothing`.
 */

// ── The catalogue (a convenience, never the whole detector) ──
// Stock demo COMPANIES, the obvious manual test names, and — added after the
// miss — the stock demo PRODUCT catalogue. The demo records that defeated this
// list were identifiable by what was sold, not by who bought it: the buyers
// were ordinary personal names, and the line items were a coffee-machine
// catalogue sitting in a business that sells nothing of the kind. A product
// term is a fact about the row; "this product does not fit this client" is an
// inference from outside the data and is deliberately not attempted.
//
// Everything here is a CONFIRMED match and is therefore excluded from every
// total, so each entry has to be distinctive enough that a real business could
// not legitimately have it in a deal name. Generic terms live in
// SAMPLE_PRODUCT_HINTS below and only raise suspicion.
const SAMPLE_NAME_WORDS = [
  // Companies.
  "fabrikam", "contoso", "litware", "adventure works", "alpine ski", "coho winery", "fourth coffee", "blue yonder", "city power",
  "northwind", "trey research", "a. datum", "adatum", "humongous insurance", "lucerne publishing", "margie's travel", "proseware",
  "school of fine art", "southridge video", "tailspin", "wide world importers", "wingtip", "woodgrove", "relecloud", "bellows college",
  "best for you organics", "munson", "sample", "test lead", "test opportunity", "example.com",
  // The stock product catalogue, by SKU name. Distinctive on purpose.
  "cafe a-100", "cafe a-200", "cafe a-300", "cafe duo", "cafe standard", "cafe supreme", "cafe roma", "cafe la vazza",
];
/** Matched on the SKU family rather than one model number, so a demo catalogue
 *  that ships another size is caught without waiting for the next miss. */
const SAMPLE_NAME_PATTERNS = [/\bcafe [a-z]-\d{3}\b/];

/** Generic enough that a real business could plausibly sell it. Never a
 *  confirmed match — it raises SUSPICION, which counts the row and asks a
 *  person, rather than deleting revenue on the strength of a common noun. */
const SAMPLE_PRODUCT_HINTS = ["espresso machine", "coffee maker", "coffee beans"];

/** Lowercased and stripped of diacritics, so "Café" and "Cafe" are one thing
 *  and the catalogue can be written once, unaccented. */
const normalize = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

/** True when any of the supplied fields names a known stock/demo record. */
export function matchesSampleName(...fields: (string | null | undefined)[]): boolean {
  const text = normalize(fields.filter(Boolean).join(" "));
  return SAMPLE_NAME_WORDS.some((w) => text.includes(w)) || SAMPLE_NAME_PATTERNS.some((re) => re.test(text));
}

/** True when the record mentions something the demo catalogue sells, in terms
 *  too ordinary to be proof on their own. */
export function mentionsSampleProduct(...fields: (string | null | undefined)[]): boolean {
  const text = normalize(fields.filter(Boolean).join(" "));
  return SAMPLE_PRODUCT_HINTS.some((w) => text.includes(w));
}

// ── Shape-based detection ──

/** One CRM record, reduced to the facts that say how it ARRIVED. Every field
 *  past `id` is optional: a CRM that cannot answer one of them contributes
 *  nothing on that axis rather than producing a guess. */
export interface CrmRecordShape {
  id: string;
  /** Names / emails, for the catalogue check above. */
  text?: (string | null | undefined)[];
  /** When the row was WRITTEN to the CRM. Full timestamp, not a date — the
   *  minute is the whole point. Null where the platform does not expose it. */
  writtenAt?: string | null;
  /** Who or what wrote it (a createdby/owner id). Batches are per-actor. */
  writtenBy?: string | null;
  /** Dynamics stamps this on any row that arrived through a data import. */
  importSequenceNumber?: number | null;
  /** A creation date the import OVERRODE — i.e. the row is backdated. */
  overriddenCreatedOn?: string | null;
  /** The record's own business date (created-on as displayed, close date). */
  businessDate?: string | null;
}

export interface SampleVerdict {
  /** We are sure. Never counted anywhere. */
  confirmed: boolean;
  /** It arrived like an import. Counted, and said out loud until ruled on. */
  suspect: boolean;
  /** One plain sentence naming what was actually seen. */
  reason: string | null;
}

const CLEAN: SampleVerdict = { confirmed: false, suspect: false, reason: null };

/** A batch smaller than this is just a busy minute. Six is deliberately low:
 *  a stock sample install plants dozens, and a web form that fires six times
 *  in one minute still will not trip the rule below, because those records
 *  are not backdated. */
export const BULK_BATCH_MIN = 6;
/** Business dates spread wider than this inside one written-in-a-minute batch
 *  is backdating. Half a year: a real same-minute burst (a form, a bulk stage
 *  change, an overnight integration) carries today's dates, not 2019's. */
export const BACKDATE_SPREAD_DAYS = 180;

const minuteOf = (iso: string): string => iso.slice(0, 16); // YYYY-MM-DDTHH:MM
const dayNumber = (d: string): number | null => {
  const t = Date.parse(`${d.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(t) ? Math.round(t / 86_400_000) : null;
};

/**
 * Classify a whole set of records together — the batch signal only exists
 * across records, so a per-record function could never see it.
 *
 * Returns entries only for records with something to say; anything absent is
 * clean. Feed it every record pulled for one client and CRM in the same pass,
 * leads and opportunities together: a sample install plants both, and keeping
 * them in one pool is what gets a small entity over BULK_BATCH_MIN.
 */
export function detectSampleRecords(records: CrmRecordShape[]): Map<string, SampleVerdict> {
  const out = new Map<string, SampleVerdict>();

  // 1. Batches: records written to the CRM inside the same minute by the same
  //    actor. This is the only signal that needs the whole set.
  const batches = new Map<string, CrmRecordShape[]>();
  for (const r of records) {
    if (!r.writtenAt) continue;
    const key = `${minuteOf(r.writtenAt)}|${r.writtenBy ?? ""}`;
    const list = batches.get(key);
    if (list) list.push(r);
    else batches.set(key, [r]);
  }

  for (const [, batch] of batches) {
    if (batch.length < BULK_BATCH_MIN) continue;
    const stamped = batch.filter((r) => r.importSequenceNumber != null || r.overriddenCreatedOn).length;
    const days = batch.map((r) => (r.businessDate ? dayNumber(r.businessDate) : null)).filter((d): d is number => d != null);
    const spread = days.length > 1 ? Math.max(...days) - Math.min(...days) : 0;
    const backdated = spread > BACKDATE_SPREAD_DAYS;
    // A batch is only suspect when it also looks BACKDATED. Written-all-at-once
    // on its own is an integration doing its job; written all at once and
    // dated across years is a history being manufactured.
    if (!stamped && !backdated) continue;
    const why = [
      `${batch.length} records were written to the CRM inside the same minute`,
      backdated ? `carrying business dates spread over ${(spread / 365).toFixed(1)} years` : null,
      stamped ? `${stamped} of them stamped by the CRM's own data import` : null,
    ].filter(Boolean).join(", ");
    const reason = `${why} — the shape of a bulk import, not of business happening. Could be demo data the platform shipped with, or the client's own history migrated in; nothing here can tell those apart.`;
    for (const r of batch) out.set(r.id, { confirmed: false, suspect: true, reason });
  }

  // 2. Per-record signals. A row that was both imported AND backdated is the
  //    same shape as the batch above, seen one record at a time — worth
  //    saying even when too few of its siblings came through this query.
  for (const r of records) {
    if (matchesSampleName(...(r.text ?? []))) {
      out.set(r.id, { confirmed: true, suspect: false, reason: "Named after a stock sample/demo record." });
      continue;
    }
    if (out.has(r.id)) continue;
    if (mentionsSampleProduct(...(r.text ?? []))) {
      out.set(r.id, {
        confirmed: false,
        suspect: true,
        reason: "Names something the CRM's stock demo catalogue sells, in words an ordinary business could also use — too common to exclude on, common enough to check.",
      });
      continue;
    }
    if (r.importSequenceNumber != null && r.overriddenCreatedOn) {
      out.set(r.id, {
        confirmed: false,
        suspect: true,
        reason: "Written by a CRM data import and backdated to a creation date it did not have — an imported row, not one this business created here.",
      });
    }
  }

  return out;
}

/** Convenience for callers that hold a verdict map. */
export const verdictFor = (m: Map<string, SampleVerdict>, id: string): SampleVerdict => m.get(id) ?? CLEAN;

/** The one line a run prints when anything is suspected. Deliberately blunt:
 *  a quiet count in a log nobody reads is how this went unnoticed the first
 *  time. Names no client and no record — the caller has the context. */
export function suspicionLine(count: number, valueCents: number, total: number): string | null {
  if (count <= 0) return null;
  const usd = "$" + Math.round(valueCents / 100).toLocaleString("en-US");
  const share = total > 0 ? ` (${Math.round((count / total) * 100)}% of the records pulled)` : "";
  return `⚠ ${count} record(s)${share} worth ${usd} look like imported data rather than business done here. They are still counted; the figures they are inside say so until somebody rules on them.`;
}

/**
 * What the audit run prints about everything it dropped or routed on purpose.
 *
 * Pure. An accounting in, lines out. Every sentence a person reads in the run's
 * output about a finding that did NOT appear is in this file, so there is one
 * place to ask whether a drop was named.
 *
 * WHY IT EXISTS. Ruleset 9 makes findings reflect what was done in the account,
 * and the price of that is findings that stop appearing. A recommendation that
 * disappears with nobody told is indistinguishable from a bug in the rule, so
 * each kind of drop is counted where it happens (`AuditAccounting` in rules.ts)
 * and said here, naming what caused it: the negative that blocks a query, the
 * service a held-back search belongs to, the budget the client approved.
 *
 * A drop that did not happen prints nothing — a line on every account saying
 * nothing was dropped is a line people learn to scroll past — EXCEPT the one
 * thing that was not even read, which is said on every account.
 */
import type { AuditAccounting } from "./rules.js";
import { blockedPromotionLine, negativeSourcesUnreadLine, AD_GROUP_NEGATIVES_NOT_READ, type NegativeMatchType } from "./negative-match.js";
import { allCoreHeldLine } from "./service-relevance.js";
import { keywordLandingLine } from "./traffic-readiness.js";

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export function accountingLines(a: AuditAccounting): string[] {
  const out: string[] = [];

  // 1. Converting queries a negative already blocks.
  const byCampaign = new Map<string, typeof a.promotionsBlocked>();
  for (const b of a.promotionsBlocked) byCampaign.set(b.campaignName, [...(byCampaign.get(b.campaignName) ?? []), b]);
  for (const [name, rows] of byCampaign) {
    const per = new Map<string, { text: string; matchType: NegativeMatchType; count: number }>();
    for (const r of rows) {
      const k = `${r.by.matchType}|${r.by.text}`;
      const e = per.get(k);
      if (e) e.count += 1; else per.set(k, { text: r.by.text, matchType: r.by.matchType, count: 1 });
    }
    out.push(blockedPromotionLine(name, rows.length, Array.from(per.values())));
  }
  if (!a.negativesRead) {
    out.push("Negatives could not be read for this account, so no converting query was dropped as already blocked.");
  } else if (a.negativeSourcesUnread.length) {
    out.push(negativeSourcesUnreadLine(a.negativeSourcesUnread));
  }
  out.push(AD_GROUP_NEGATIVES_NOT_READ);

  // 2. Landing pages: keywords let through.
  for (const l of a.landing) {
    out.push(`${l.campaignName}: ${l.cleared ? "landing-page row cleared" : "landing-page row kept"}. ${keywordLandingLine(l.counts)}`);
  }

  // 3. Core searches held back from the negative list.
  const heldBy = new Map<string, typeof a.coreSearchesNotBlocked>();
  for (const h of a.coreSearchesNotBlocked) heldBy.set(h.campaignName, [...(heldBy.get(h.campaignName) ?? []), h]);
  for (const [name, rows] of heldBy) {
    const services = Array.from(new Set(rows.map((r) => r.block.service))).slice(0, 4).map((s) => `"${s}"`).join(", ");
    out.push(`${name}: ${rows.length} core search${rows.length === 1 ? "" : "es"} not proposed as negatives (${services}). They are listed under the row.`);
  }
  for (const w of a.wasteRowsNotRaised) out.push(allCoreHeldLine(w.campaignName, w.terms, w.costMicros));

  // 4. Budget rows marked for the client's own decision.
  for (const b of a.budgetRoutedToClient) {
    out.push(`${b.campaignName}: budget row marked for the client's budget decision — the account's budgets add up to about ${usd(b.accountMonthlyCents)} a month against ${usd(b.approvedMonthlyCents)} approved.`);
  }

  // 5. Targets held back.
  for (const t of a.targetHeld) {
    out.push(`${t.campaignName}: no cost target proposed — ${t.conversions % 1 === 0 ? t.conversions : t.conversions.toFixed(1)} conversions a month${t.strategy ? ` on ${t.strategy.replace(/_/g, " ").toLowerCase()}` : ""}, so it stays as it is.`);
  }

  // 6. Keywords on a recorded competitor name, set aside from the quality-score count.
  for (const c of a.competitorKeywords) {
    out.push(`${c.campaignName}: ${c.count} keyword${c.count === 1 ? "" : "s"} on a recorded competitor name left out of the quality-score count and judged on cost per conversion instead.`);
  }

  // 7. Keywords whose spend has stopped: the row stays, and claims no saving.
  const stoppedBy = new Map<string, typeof a.keywordsStopped>();
  for (const k of a.keywordsStopped) stoppedBy.set(k.campaignName, [...(stoppedBy.get(k.campaignName) ?? []), k]);
  for (const [name, rows] of stoppedBy) {
    const newest = rows.map((r) => r.lastSpendOn).sort().pop();
    out.push(`${name}: ${rows.length} keyword${rows.length === 1 ? "" : "s"} with no spend for over two weeks, kept as a low row with no saving claimed (the newest took spend on ${newest}).`);
  }
  return out;
}

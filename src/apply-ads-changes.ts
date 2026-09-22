#!/usr/bin/env tsx
import "dotenv/config";
import { readFileSync } from "node:fs";
import pg from "pg";
import { GoogleAdsApi } from "google-ads-api";
import { loadConfig, digitsOnly } from "./config.js";

/**
 * Applies a reviewed change set to one Google Ads account.
 *
 * This is deliberately NOT a general-purpose mutation tool. It supports a fixed,
 * narrow set of operations -- campaign daily budget, campaign-level negative
 * keywords (add and remove), keyword-level final URLs, and detaching assets.
 * Every mutate is validated with validate_only before it is applied, and the
 * prior value of anything changed is recorded so the change can be reversed.
 *
 * Guards, all of which abort the run rather than proceed:
 *   - budget moves are capped in both percent and absolute dollars
 *   - negatives matching a protected pattern are refused (a partner or brand
 *     term blocked by accident is far more expensive than the spend it saves)
 *   - a negative already present is skipped, not duplicated
 *   - ad copy is out of scope entirely: OCH runs under LegitScript certification
 *     and ad text changes can put it at risk
 *
 * TWO CALLERS, ONE IMPLEMENTATION. `applyChangeSet` below is exported so the
 * findings pipeline (src/ads-apply-approved.ts, driven by a human pressing
 * Approve in the dashboard) runs through exactly these guards rather than
 * growing a second, laxer mutation path. The CLI entry point is a thin wrapper
 * over the same function.
 *
 *   npm run apply-ads-changes -- --file=data/och-ads-changes.json            (dry run)
 *   npm run apply-ads-changes -- --file=data/och-ads-changes.json --apply    (live)
 */

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;

/** A budget may not more than double, nor move more than $100/day, in one run. */
export const MAX_BUDGET_FACTOR = 2;
export const MAX_BUDGET_DELTA_USD = 100;

/**
 * One data exclusion may cover at most fourteen days. This is the PLATFORM'S
 * ceiling, not ours, and it is enforced here as well as at detection because
 * this function is the last thing standing between a proposal and a live
 * account. Triangulated from Google's own help pages, which this sandbox
 * cannot open — see src/ads/tracking-outage.ts for the provenance.
 */
export const MAX_DATA_EXCLUSION_DAYS = 14;

/** Enums arrive as integers over REST, so record the readable name in rollback. */
const MATCH_TYPE_NAME: Record<string, string> = { "2": "EXACT", "3": "PHRASE", "4": "BROAD" };

export interface ChangeSet {
  client: string;
  note?: string;
  protectedPatterns?: string[];
  /** URLs known to be failing policy review. Refuse to point anything at them. */
  brokenUrls?: string[];
  /** `fromDailyMicros` is the live budget this proposal was COMPUTED FROM.
   *  `newDailyUsd` is a frozen dollar figure rather than a delta, so it is the
   *  only thing that lets the apply path tell a current +25% step from a
   *  week-old one somebody has since overtaken. Optional on the type because
   *  a hand-written change set has no audit behind it; absent means the
   *  staleness guard below refuses the item. */
  budgets?: { campaign: string; newDailyUsd: number; fromDailyMicros?: number; reason: string }[];
  campaignNegatives?: { campaign: string; matchType: string; reason: string; keywords: string[] }[];
  removeCampaignNegatives?: { campaign: string; reason: string; keywords: string[] }[];
  keywordFinalUrls?: { reason: string; map: { keyword: string; url: string }[] }[];
  removeAssets?: { assetId: string; label: string; reason: string }[];
  /**
   * Tell Smart Bidding to ignore conversion data over a stated date range.
   *
   * THE ONLY MUTATION HERE THAT CHANGES WHAT THE PLATFORM LEARNS RATHER THAN
   * WHAT IT SERVES, and it is the one whose failure mode is invisible: an
   * exclusion over the wrong dates throws away real conversions and no metric
   * on any screen goes red. So it carries one guard the others do not —
   * `observedConversionsInRange` is what the day-by-day series said was in
   * those dates when the proposal was worked out, and the account is re-read
   * over the same dates before anything is written. Conversions arrive days
   * after the click, so a range that was empty on Monday can have filled in by
   * Friday, and excluding it then is the expensive direction to be wrong in.
   *
   * `campaigns` is a list of campaign RESOURCE NAMES: `scope` is set to
   * CAMPAIGN so the exclusion says exactly what it touches. `campaignNames`
   * rides along for the log and the refusal messages only.
   */
  dataExclusions?: {
    name: string;
    /** "yyyy-MM-dd HH:mm:ss", account time. */
    startDateTime: string;
    endDateTime: string;
    campaigns: string[];
    campaignNames: string[];
    observedConversionsInRange: number;
    reason: string;
  }[];
}

/**
 * Structured prior values, captured before each mutate.
 *
 * The CLI has always PRINTED a reversal plan; this is the machine-readable
 * counterpart, so `rollbackChangeSet` can actually put things back instead of
 * a person retyping what the log said. Nothing is applied unless a prior value
 * for it was captured first -- an irreversible change is not one we make.
 */
export type PriorValue =
  | { kind: "budget"; campaign: string; budgetResourceName: string; amountMicros: number }
  | { kind: "negatives_added"; campaign: string; resourceNames: string[] }
  | { kind: "negatives_removed"; campaign: string; campaignResourceName: string; keywords: { text: string; matchType: string }[] }
  | { kind: "keyword_final_urls"; keyword: string; resourceName: string; finalUrls: string[] }
  | { kind: "asset_detached"; assetId: string; label: string; level: string; resourceName: string }
  | { kind: "data_exclusion_created"; name: string; startDateTime: string; endDateTime: string; resourceNames: string[] };

export interface ApplyOutcome {
  /** Human-readable reversal steps, exactly as the CLI has always printed them. */
  rollback: string[];
  /** Machine-readable prior values for programmatic rollback. */
  priorValues: PriorValue[];
  /** What the platform returned, per operation. */
  results: { op: string; detail: unknown }[];
  /** Everything printed, so a caller can store the transcript on a finding. */
  log: string[];
}

/** Resolve a client name to its mapped Google Ads customer id. */
export async function resolveCustomerId(databaseUrl: string, clientName: string): Promise<{ customerId: string; clientName: string }> {
  const pgc = new pg.Client({ connectionString: databaseUrl });
  await pgc.connect();
  try {
    const { rows } = await pgc.query<{ name: string; external_id: string }>(
      `SELECT c.name, cm.external_id FROM clients c
         JOIN connector_mappings cm ON cm.client_id = c.id AND cm.source='google_ads' AND cm.enabled = true
        WHERE cm.external_id IS NOT NULL AND btrim(cm.external_id) <> ''`);
    const want = slugify(clientName);
    const hit = rows.find((r) => slugify(r.name).startsWith(want));
    if (!hit) throw new Error(`No mapped Google Ads account for "${clientName}". Have: ${rows.map((r) => slugify(r.name)).join(", ")}`);
    return { customerId: digitsOnly(hit.external_id), clientName: hit.name };
  } finally {
    await pgc.end();
  }
}

/** Open a Customer handle, falling back to no login_customer_id for accounts
 *  that aren't under the MCC. Shared by every ads script. */
export async function openCustomer(api: GoogleAdsApi, cfg: { loginCustomerId: string; refreshToken: string }, customerId: string): Promise<any> {
  try {
    const c = api.Customer({ customer_id: customerId, login_customer_id: cfg.loginCustomerId, refresh_token: cfg.refreshToken });
    await c.query(`SELECT customer.id FROM customer LIMIT 1`);
    return c;
  } catch {
    return api.Customer({ customer_id: customerId, refresh_token: cfg.refreshToken });
  }
}

/**
 * The guarded mutation path. Every operation validate_only's first; `apply`
 * false stops there. Guards throw rather than skip, because a change set that
 * contains one refused item is a change set nobody has properly reviewed.
 */
export async function applyChangeSet(
  customer: any,
  customerId: string,
  cs: ChangeSet,
  opts: { apply: boolean; onLog?: (line: string) => void } = { apply: false },
): Promise<ApplyOutcome> {
  const apply = opts.apply;
  const log: string[] = [];
  const say = (line: string) => { log.push(line); (opts.onLog ?? console.log)(line); };

  const protectedPatterns = (cs.protectedPatterns ?? []).map((p) => p.toLowerCase());
  const rollback: string[] = [];
  const priorValues: PriorValue[] = [];
  const results: { op: string; detail: unknown }[] = [];

  // ── Campaign daily budgets ───────────────────────────────────────────────
  for (const b of cs.budgets ?? []) {
    const rows = await customer.query(`
      SELECT campaign.id, campaign.name, campaign.status,
             campaign_budget.resource_name, campaign_budget.amount_micros
        FROM campaign
       WHERE campaign.name = '${b.campaign.replace(/'/g, "\\'")}' AND campaign.status = 'ENABLED'`);
    if (!rows.length) { say(`  ⚠ budget: no enabled campaign named "${b.campaign}" — skipped`); continue; }

    const cur = Number(rows[0].campaign_budget?.amount_micros ?? 0);
    const next = Math.round(b.newDailyUsd * 1_000_000);
    if (cur === next) { say(`  ·  budget: "${b.campaign}" already ${usd(cur)} — no change`); continue; }

    // ── Staleness guard ──────────────────────────────────────────────────
    // The two guards below bound how far a budget may move UP. Neither bounds
    // a move DOWN, and `newDailyUsd` is a dollar figure frozen when the audit
    // ran — not a delta. So a finding raised against a $100/day campaign
    // proposes $125 forever, and if somebody raised that campaign to $300 in
    // the meantime, approving it writes $300 back down to $125: under 2x, and
    // a negative delta, so both guards pass and it reads in the log as a clean
    // apply. That is the exact case a subcontractor working an account between
    // Monday audits produces.
    //
    // So the item is refused unless the live budget is still the one this
    // proposal was computed from. SKIPPED rather than thrown: a throw aborts
    // the whole change set, and one stale item should not cost the others. An
    // item that skips captures no prior value, which the adapter reports as a
    // null and ads-apply-approved treats as a hard failure — the finding goes
    // back to `proposed` rather than being marked applied. That is the honest
    // outcome: the next audit re-detects it against the real number, and the
    // dashboard's own "Check now" makes that minutes rather than a week.
    //
    // ABSENT is refused too, not waved through. A change set with no recorded
    // starting point cannot prove it is current, and "prior values captured or
    // the change refused" is the rule this path already lives by. Findings
    // detected before this shipped carry no `fromDailyMicros`; re-running the
    // audit rewrites change_payload_json in place (see ads/store.ts) and they
    // become approvable again.
    const from = b.fromDailyMicros;
    if (from == null) {
      say(`  ⚠ budget: "${b.campaign}" carries no recorded starting budget — refused.`);
      say(`     Re-run the findings audit ("Check now" on the Ads tab) so the proposal is worked out from today's number.`);
      continue;
    }
    // A cent of tolerance, because the platform normalises the amount it
    // stores. Anything wider would start waving through a real change.
    if (Math.abs(cur - from) > 10_000) {
      say(`  ⚠ budget: "${b.campaign}" was ${usd(from)}/day when this was worked out and is ${usd(cur)}/day now — refused.`);
      say(`     Somebody has moved it since. Applying ${usd(next)} would overwrite their change with a stale figure.`);
      continue;
    }

    if (next > cur * MAX_BUDGET_FACTOR) throw new Error(`Guard: ${usd(cur)} → ${usd(next)} on "${b.campaign}" exceeds ${MAX_BUDGET_FACTOR}x.`);
    if ((next - cur) / 1_000_000 > MAX_BUDGET_DELTA_USD) throw new Error(`Guard: ${usd(cur)} → ${usd(next)} on "${b.campaign}" exceeds $${MAX_BUDGET_DELTA_USD}/day.`);

    const payload = [{ resource_name: rows[0].campaign_budget.resource_name, amount_micros: next }];
    await customer.campaignBudgets.update(payload, { validate_only: true });
    say(`  ✅ budget: "${b.campaign}" ${usd(cur)} → ${usd(next)}/day — validated`);
    say(`     ${b.reason}`);
    if (apply) {
      const res = await customer.campaignBudgets.update(payload);
      say(`     APPLIED`);
      rollback.push(`campaign budget "${b.campaign}": set amount_micros back to ${cur} (${usd(cur)}/day)`);
      priorValues.push({ kind: "budget", campaign: b.campaign, budgetResourceName: rows[0].campaign_budget.resource_name, amountMicros: cur });
      results.push({ op: "budgets", detail: res });
    }
  }

  // ── Campaign-level negative keywords ─────────────────────────────────────
  for (const n of cs.campaignNegatives ?? []) {
    const rows = await customer.query(`
      SELECT campaign.id, campaign.resource_name, campaign.name
        FROM campaign
       WHERE campaign.name = '${n.campaign.replace(/'/g, "\\'")}' AND campaign.status = 'ENABLED'`);
    if (!rows.length) { say(`  ⚠ negatives: no enabled campaign named "${n.campaign}" — skipped`); continue; }
    const campaignRn = rows[0].campaign.resource_name;

    const existingRows = await customer.query(`
      SELECT campaign_criterion.keyword.text
        FROM campaign_criterion
       WHERE campaign_criterion.negative = TRUE
         AND campaign_criterion.type = 'KEYWORD'
         AND campaign.id = ${rows[0].campaign.id}`);
    const existing = new Set(existingRows.map((r: any) => (r.campaign_criterion?.keyword?.text ?? "").toLowerCase()));

    const toAdd: string[] = [];
    for (const kw of n.keywords) {
      const k = kw.toLowerCase().trim();
      const clash = protectedPatterns.find((p) => k.includes(p) || p.includes(k));
      if (clash) throw new Error(`Guard: negative "${kw}" collides with protected pattern "${clash}". Refusing the whole run.`);
      if (existing.has(k)) { say(`  ·  negative: "${kw}" already on "${n.campaign}" — skipped`); continue; }
      toAdd.push(kw);
    }
    if (!toAdd.length) { say(`  ·  negatives: nothing new for "${n.campaign}"`); continue; }

    const payload = toAdd.map((kw) => ({
      campaign: campaignRn,
      negative: true,
      keyword: { text: kw, match_type: n.matchType },
    }));
    await customer.campaignCriteria.create(payload, { validate_only: true });
    say(`  ✅ negatives: ${toAdd.length} ${n.matchType} on "${n.campaign}" — validated`);
    say(`     ${toAdd.map((k) => `"${k}"`).join(", ")}`);
    say(`     ${n.reason}`);
    if (apply) {
      const res: any = await customer.campaignCriteria.create(payload);
      const names: string[] = (res?.results ?? []).map((r: any) => r.resource_name).filter(Boolean);
      say(`     APPLIED — ${names.length} criteria created`);
      for (const rn of names) rollback.push(`negative keyword: remove ${rn}`);
      priorValues.push({ kind: "negatives_added", campaign: n.campaign, resourceNames: names });
      results.push({ op: "campaignNegatives", detail: res });
    }
  }

  // ── Remove campaign-level negative keywords ──────────────────────────────
  // The counterpart to adding them. A negative that turns out to block traffic the
  // client actually wants is more expensive than the spend it saved, so removal
  // needs to be as easy as addition -- and recorded the same way.
  for (const n of cs.removeCampaignNegatives ?? []) {
    const rows = await customer.query(`
      SELECT campaign.id, campaign.name, campaign.resource_name
        FROM campaign
       WHERE campaign.name = '${n.campaign.replace(/'/g, "\\'")}' AND campaign.status = 'ENABLED'`);
    if (!rows.length) { say(`  ⚠ remove negatives: no enabled campaign named "${n.campaign}" — skipped`); continue; }

    const want = new Set(n.keywords.map((k) => k.toLowerCase().trim()));
    const existing = await customer.query(`
      SELECT campaign_criterion.resource_name, campaign_criterion.keyword.text,
             campaign_criterion.keyword.match_type
        FROM campaign_criterion
       WHERE campaign_criterion.negative = TRUE
         AND campaign_criterion.type = 'KEYWORD'
         AND campaign.id = ${rows[0].campaign.id}`);
    const hits = existing.filter((r: any) => want.has(String(r.campaign_criterion?.keyword?.text ?? "").toLowerCase()));
    const missing = Array.from(want).filter((k) => !hits.some((h: any) => String(h.campaign_criterion.keyword.text).toLowerCase() === k));
    for (const m of missing) say(`  ·  remove negative: "${m}" not present on "${n.campaign}" — nothing to do`);
    if (!hits.length) continue;

    const names = hits.map((h: any) => h.campaign_criterion.resource_name);
    await customer.campaignCriteria.remove(names, { validate_only: true });
    say(`  ✅ remove negatives: ${hits.length} from "${n.campaign}" — validated`);
    say(`     ${hits.map((h: any) => `"${h.campaign_criterion.keyword.text}"`).join(", ")}`);
    say(`     ${n.reason}`);
    if (apply) {
      const res = await customer.campaignCriteria.remove(names);
      say(`     APPLIED`);
      const restored: { text: string; matchType: string }[] = [];
      for (const h of hits as any[]) {
        const mt = MATCH_TYPE_NAME[String(h.campaign_criterion.keyword.match_type)] ?? String(h.campaign_criterion.keyword.match_type);
        rollback.push(`negative "${h.campaign_criterion.keyword.text}": re-add to "${n.campaign}" as ${mt}`);
        restored.push({ text: h.campaign_criterion.keyword.text, matchType: mt });
      }
      priorValues.push({ kind: "negatives_removed", campaign: n.campaign, campaignResourceName: rows[0].campaign.resource_name, keywords: restored });
      results.push({ op: "removeCampaignNegatives", detail: res });
    }
  }

  // ── Keyword-level final URLs ─────────────────────────────────────────────
  // A keyword's own final URL overrides the ad's, so this lands the click on the
  // page that answers the search without touching ad copy — which matters here:
  // editing an ad resubmits it for policy review, and this account has an open
  // certificate question we do not want to trip.
  for (const group of cs.keywordFinalUrls ?? []) {
    const rows = await customer.query(`
      SELECT ad_group_criterion.resource_name, ad_group_criterion.keyword.text,
             ad_group_criterion.final_urls, campaign.name, ad_group.name
        FROM ad_group_criterion
       WHERE ad_group_criterion.type = 'KEYWORD'
         AND ad_group_criterion.negative = FALSE
         AND ad_group_criterion.status = 'ENABLED'
         AND ad_group.status = 'ENABLED'
         AND campaign.status = 'ENABLED'`);
    const byText = new Map<string, any>();
    for (const r of rows) byText.set(String(r.ad_group_criterion?.keyword?.text ?? "").toLowerCase(), r);

    const payload: any[] = [];
    for (const m of group.map) {
      if ((cs.brokenUrls ?? []).some((b) => m.url.startsWith(b))) {
        throw new Error(`Guard: "${m.url}" is on the broken-URL list. Refusing the whole run.`);
      }
      const row = byText.get(m.keyword.toLowerCase());
      if (!row) { say(`  ⚠ keyword url: no enabled keyword "${m.keyword}" — skipped`); continue; }
      const cur: string[] = row.ad_group_criterion?.final_urls ?? [];
      if (cur.length === 1 && cur[0] === m.url) { say(`  ·  keyword url: "${m.keyword}" already → ${m.url}`); continue; }
      say(`  ✅ keyword url: "${m.keyword}" ${cur.length ? cur.join(", ") : "(inherits ad)"} → ${m.url}`);
      payload.push({ resource_name: row.ad_group_criterion.resource_name, final_urls: [m.url], _kw: m.keyword, _cur: cur });
    }
    if (!payload.length) { say(`  ·  keyword urls: nothing to change`); continue; }
    say(`     ${group.reason}`);
    const clean = payload.map(({ _kw, _cur, ...rest }) => rest);
    await customer.adGroupCriteria.update(clean, { validate_only: true });
    say(`     validated (${clean.length})`);
    if (apply) {
      const res = await customer.adGroupCriteria.update(clean);
      say(`     APPLIED`);
      for (const p of payload) {
        rollback.push(p._cur.length
          ? `keyword "${p._kw}": restore final_urls to ${p._cur.join(", ")}`
          : `keyword "${p._kw}": clear final_urls so it inherits the ad again (${p.resource_name})`);
        priorValues.push({ kind: "keyword_final_urls", keyword: p._kw, resourceName: p.resource_name, finalUrls: p._cur });
      }
      results.push({ op: "keywordFinalUrls", detail: res });
    }
  }

  // ── Detach assets ────────────────────────────────────────────────────────
  // Removes the asset's links (campaign / ad group / account level) rather than
  // the asset itself — Google keeps assets around, and detaching is what stops
  // it serving. Reversible by re-linking the same asset id.
  for (const a of cs.removeAssets ?? []) {
    const rn = `customers/${customerId}/assets/${a.assetId}`;
    const links: { resource_name: string; level: string }[] = [];
    for (const [table, field, level] of [
      ["campaign_asset", "campaign_asset", "campaign"],
      ["ad_group_asset", "ad_group_asset", "ad group"],
      ["customer_asset", "customer_asset", "account"],
    ] as const) {
      const rows = await customer.query(
        `SELECT ${field}.resource_name FROM ${table} WHERE ${field}.asset = '${rn}' AND ${field}.status != 'REMOVED'`);
      for (const r of rows) links.push({ resource_name: (r as any)[field].resource_name, level });
    }
    if (!links.length) { say(`  ·  asset "${a.label}" (${a.assetId}): not linked anywhere — nothing to do`); continue; }
    say(`  ✅ detach asset: "${a.label}" from ${links.length} place(s) — ${links.map((l) => l.level).join(", ")}`);
    say(`     ${a.reason}`);
    for (const l of links) {
      const linkApi = l.level === "campaign" ? customer.campaignAssets : l.level === "ad group" ? customer.adGroupAssets : customer.customerAssets;
      await linkApi.remove([l.resource_name], { validate_only: true });
      if (apply) {
        await linkApi.remove([l.resource_name]);
        rollback.push(`asset "${a.label}": re-link asset ${a.assetId} at ${l.level} level (was ${l.resource_name})`);
        priorValues.push({ kind: "asset_detached", assetId: a.assetId, label: a.label, level: l.level, resourceName: l.resource_name });
      }
    }
    say(apply ? `     APPLIED` : `     validated`);
  }

  // ── Data exclusions ──────────────────────────────────────────────────────
  // Tells Smart Bidding to ignore conversion data over a stated past range.
  // Nothing about spend, targeting or ads changes — only which days the model
  // is allowed to learn from. That makes this the one operation whose damage
  // is invisible on every screen, so it carries four guards rather than two,
  // and each of them SKIPS the item rather than throwing: one refused
  // exclusion must not cost the rest of a change set, and an item that skips
  // captures no prior value, which the caller already treats as a failure.
  for (const x of cs.dataExclusions ?? []) {
    const startDay = String(x.startDateTime ?? "").slice(0, 10);
    const endDay = String(x.endDateTime ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDay) || !/^\d{4}-\d{2}-\d{2}$/.test(endDay)) {
      say(`  ⚠ data exclusion: "${x.name}" carries no readable date range — refused.`);
      continue;
    }

    // GUARD 1 — the platform's own ceiling. Enforced here as well as at
    // detection because this function is the last thing before a live write.
    const days = Math.round((Date.parse(`${endDay}T00:00:00Z`) - Date.parse(`${startDay}T00:00:00Z`)) / 86_400_000) + 1;
    if (days < 1) { say(`  ⚠ data exclusion: "${x.name}" ends before it starts — refused.`); continue; }
    if (days > MAX_DATA_EXCLUSION_DAYS) {
      say(`  ⚠ data exclusion: ${startDay} → ${endDay} is ${days} days and the platform allows at most ${MAX_DATA_EXCLUSION_DAYS} — refused.`);
      continue;
    }

    // GUARD 2 — the range must already be over. A data exclusion is a
    // retrospective correction; one whose end is in the future is telling the
    // model to ignore days that have not happened, which is a different tool
    // (a seasonality adjustment) and a different decision.
    const today = new Date().toISOString().slice(0, 10);
    if (endDay >= today) {
      say(`  ⚠ data exclusion: "${x.name}" ends ${endDay}, which is not yet over — refused.`);
      say(`     Excluding days that have not happened is a forward-looking change and is not what this is.`);
      continue;
    }

    // GUARD 3 — THE STALENESS GUARD, and the reason this operation exists
    // with more care than the others. The range was chosen from a day-by-day
    // series read when the audit ran. Conversions arrive days after the click
    // and the platform backfills them into the click's own date, so a stretch
    // that recorded nothing on Monday can hold real conversions by Friday.
    // Excluding it then discards signal that is genuinely there, on an account
    // that is usually short of it, and no metric anywhere would show it.
    const nowRows = await customer.query(`
      SELECT metrics.conversions, metrics.all_conversions
        FROM customer
       WHERE segments.date BETWEEN '${startDay}' AND '${endDay}'`);
    const nowConversions = nowRows.reduce(
      (t: number, r: any) => t + Number(r.metrics?.conversions ?? 0), 0);
    const wasConversions = Number(x.observedConversionsInRange ?? 0);
    // A whole conversion of tolerance. `conversions` is a float and the
    // platform splits one across clicks, so demanding an exact match would
    // refuse a range that has not moved at all.
    if (nowConversions > wasConversions + 1) {
      say(`  ⚠ data exclusion: ${startDay} → ${endDay} held ${wasConversions.toFixed(1)} conversion(s) when this was worked out and holds ${nowConversions.toFixed(1)} now — refused.`);
      say(`     Those days have filled in since. Excluding them now would throw away conversions the account really recorded.`);
      continue;
    }

    // GUARD 4 — an overlapping exclusion already on the account is skipped
    // rather than duplicated, the same way an existing negative is. Two
    // exclusions over one range is not twice as much anything; it is a second
    // row somebody has to reason about and a second slot out of the 500 an
    // account may hold.
    const existing = await customer.query(`
      SELECT bidding_data_exclusion.resource_name, bidding_data_exclusion.name,
             bidding_data_exclusion.start_date_time, bidding_data_exclusion.end_date_time
        FROM bidding_data_exclusion`);
    const clash = existing.find((r: any) => {
      const s2 = String(r.bidding_data_exclusion?.start_date_time ?? "").slice(0, 10);
      const e2 = String(r.bidding_data_exclusion?.end_date_time ?? "").slice(0, 10);
      return s2 && e2 && s2 <= endDay && e2 >= startDay;
    });
    if (clash) {
      say(`  ·  data exclusion: ${startDay} → ${endDay} overlaps "${clash.bidding_data_exclusion?.name}" already on the account — skipped, not duplicated`);
      continue;
    }

    // Every campaign is re-resolved by its resource name and dropped if it is
    // no longer live. A proposal a week old can name a campaign somebody has
    // since paused, and scoping an exclusion to one does nothing while reading
    // in the log as a clean apply.
    const wanted = new Set(x.campaigns);
    const liveRows = wanted.size
      ? await customer.query(`
          SELECT campaign.resource_name, campaign.name
            FROM campaign WHERE campaign.status = 'ENABLED'`)
      : [];
    const live = liveRows
      .map((r: any) => String(r.campaign?.resource_name ?? ""))
      .filter((rn: string) => wanted.has(rn));
    const gone = x.campaigns.filter((rn) => !live.includes(rn));
    for (const rn of gone) {
      const idx = x.campaigns.indexOf(rn);
      say(`  ⚠ data exclusion: campaign "${x.campaignNames[idx] ?? rn}" is no longer live — dropped from the scope`);
    }
    if (!live.length) {
      say(`  ⚠ data exclusion: "${x.name}" names no live campaign any more — refused.`);
      continue;
    }

    const payload = [{
      name: x.name,
      // CAMPAIGN scope, so the exclusion states exactly what it covers. The
      // enum is sent by name; the client library accepts either form and the
      // name is the one a person reading this file can check.
      scope: "CAMPAIGN",
      start_date_time: x.startDateTime,
      end_date_time: x.endDateTime,
      campaigns: live,
      description: x.reason.slice(0, 500),
    }];
    await customer.biddingDataExclusions.create(payload, { validate_only: true });
    say(`  ✅ data exclusion: ${startDay} → ${endDay} (${days} day${days === 1 ? "" : "s"}) on ${live.length} campaign(s) — validated`);
    say(`     ${x.reason}`);
    if (apply) {
      const res: any = await customer.biddingDataExclusions.create(payload);
      const names: string[] = (res?.results ?? []).map((r: any) => r.resource_name).filter(Boolean);
      say(`     APPLIED — ${names.length} exclusion created`);
      for (const rn of names) rollback.push(`data exclusion "${x.name}": remove ${rn}`);
      priorValues.push({
        kind: "data_exclusion_created", name: x.name,
        startDateTime: x.startDateTime, endDateTime: x.endDateTime, resourceNames: names,
      });
      results.push({ op: "dataExclusions", detail: res });
    }
  }

  return { rollback, priorValues, results, log };
}

/**
 * Put back what `applyChangeSet` changed, from its recorded prior values.
 *
 * Asset re-linking is the one kind this cannot do on its own: re-attaching an
 * asset needs the original link's field type and settings, which the detach
 * response does not carry. It is reported as manual rather than silently
 * skipped, because a rollback that quietly does nothing is worse than one that
 * says it needs a person.
 */
export async function rollbackChangeSet(
  customer: any,
  priorValues: PriorValue[],
  opts: { apply: boolean; onLog?: (line: string) => void } = { apply: false },
): Promise<{ restored: string[]; manual: string[]; log: string[] }> {
  const log: string[] = [];
  const say = (line: string) => { log.push(line); (opts.onLog ?? console.log)(line); };
  const restored: string[] = [];
  const manual: string[] = [];

  for (const pv of priorValues) {
    switch (pv.kind) {
      case "budget": {
        const payload = [{ resource_name: pv.budgetResourceName, amount_micros: pv.amountMicros }];
        await customer.campaignBudgets.update(payload, { validate_only: true });
        say(`  ✅ restore budget "${pv.campaign}" → ${usd(pv.amountMicros)}/day — validated`);
        if (opts.apply) { await customer.campaignBudgets.update(payload); say(`     RESTORED`); }
        restored.push(`budget "${pv.campaign}" → ${usd(pv.amountMicros)}/day`);
        break;
      }
      case "negatives_added": {
        if (!pv.resourceNames.length) break;
        await customer.campaignCriteria.remove(pv.resourceNames, { validate_only: true });
        say(`  ✅ remove ${pv.resourceNames.length} negatives added to "${pv.campaign}" — validated`);
        if (opts.apply) { await customer.campaignCriteria.remove(pv.resourceNames); say(`     RESTORED`); }
        restored.push(`removed ${pv.resourceNames.length} negatives from "${pv.campaign}"`);
        break;
      }
      case "negatives_removed": {
        const payload = pv.keywords.map((k) => ({
          campaign: pv.campaignResourceName, negative: true,
          keyword: { text: k.text, match_type: k.matchType },
        }));
        await customer.campaignCriteria.create(payload, { validate_only: true });
        say(`  ✅ re-add ${payload.length} negatives to "${pv.campaign}" — validated`);
        if (opts.apply) { await customer.campaignCriteria.create(payload); say(`     RESTORED`); }
        restored.push(`re-added ${payload.length} negatives to "${pv.campaign}"`);
        break;
      }
      case "keyword_final_urls": {
        const payload = [{ resource_name: pv.resourceName, final_urls: pv.finalUrls }];
        await customer.adGroupCriteria.update(payload, { validate_only: true });
        say(`  ✅ restore final URLs for "${pv.keyword}" → ${pv.finalUrls.length ? pv.finalUrls.join(", ") : "(inherits ad)"} — validated`);
        if (opts.apply) { await customer.adGroupCriteria.update(payload); say(`     RESTORED`); }
        restored.push(`final URLs for "${pv.keyword}"`);
        break;
      }
      case "data_exclusion_created": {
        if (!pv.resourceNames.length) break;
        await customer.biddingDataExclusions.remove(pv.resourceNames, { validate_only: true });
        say(`  ✅ remove data exclusion "${pv.name}" (${pv.startDateTime.slice(0, 10)} → ${pv.endDateTime.slice(0, 10)}) — validated`);
        if (opts.apply) { await customer.biddingDataExclusions.remove(pv.resourceNames); say(`     RESTORED`); }
        restored.push(`removed data exclusion "${pv.name}", so bidding counts those days again`);
        break;
      }
      case "asset_detached": {
        say(`  ⚠ asset "${pv.label}" (${pv.assetId}) was detached at ${pv.level} level — re-linking needs the original field type, so this one is manual.`);
        manual.push(`Re-link asset ${pv.assetId} ("${pv.label}") at ${pv.level} level.`);
        break;
      }
    }
  }
  return { restored, manual, log };
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const file = argv.find((a) => a.startsWith("--file="))?.slice(7);
  if (!file) throw new Error("Pass --file=<path to change set json>.");
  const cs: ChangeSet = JSON.parse(readFileSync(file, "utf8"));

  const cfg = loadConfig();
  const api = new GoogleAdsApi({ client_id: cfg.clientId, client_secret: cfg.clientSecret, developer_token: cfg.developerToken });
  const { customerId, clientName } = await resolveCustomerId(cfg.databaseUrl, cs.client);
  const customer = await openCustomer(api, cfg, customerId);

  console.log(`\n${clientName} [${customerId}] — ${apply ? "APPLYING" : "DRY RUN (nothing will be changed)"}`);
  if (cs.note) console.log(`${cs.note}\n`);

  const { rollback } = await applyChangeSet(customer, customerId, cs, { apply });

  console.log(apply ? `\n── To reverse ──` : `\n── Dry run complete. Re-run with --apply to make these changes. ──`);
  for (const r of rollback) console.log(`  ${r}`);
  if (apply && !rollback.length) console.log(`  (nothing was changed)`);
  console.log("");
}

// Only run the CLI when this file is the entry point — importing it from the
// findings pipeline must not kick off a change set run.
const isEntry = process.argv[1] && /apply-ads-changes\.[tj]s$/.test(process.argv[1]);
if (isEntry) {
  main().catch((e) => {
    const msg = e?.errors?.map((x: any) => x.message).join("; ") || (e instanceof Error ? e.message : String(e));
    console.error(msg);
    process.exit(1);
  });
}

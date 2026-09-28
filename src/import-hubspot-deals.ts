#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { resolveAllowedPipelines, pipelineVerdict, PIPELINE_ENV_VAR } from "./deal-pipeline";
import { dealStatus, dealStageLabel, dealClosedAt, type DealStatus } from "./hubspot-deal-status";
import { randomUUID } from "node:crypto";

/**
 * Syncs HubSpot deals into the app's `deals` table (and the companies they
 * hang off), so the in-app pipeline mirrors HubSpot while the team is still
 * mid-transition. Idempotent: upserts by hubspot_id, safe to run on a schedule.
 *
 * ── A DEAL CLOSED IN HUBSPOT NOW CLOSES HERE (2026-09-28).
 *
 * This is the path that actually runs — 11:00 and 23:00 UTC, twice a day —
 * and until today it could not close a deal at all. Two lines did it:
 * `salesDeals.filter(isOpen)` threw every closed deal out of the write set
 * before anything was written, and all three write paths then hardcoded
 * `status='open'`. So a deal marked Closed Lost in HubSpot stayed open in the
 * app until somebody ran the MANUAL import (src/import-hubspot.ts) by hand,
 * and every reading that rests on "this deal is settled" — a forecast, a
 * follow-up list, a commission — was only as current as the last time a
 * person pressed a button.
 *
 * What changed, and the three lines it does NOT cross:
 *
 *   • Won / lost / open is decided in ONE place for both importers in this
 *     repo, src/hubspot-deal-status.ts, so they cannot mean different things
 *     by "lost". A deal that rule REFUSES to read (HubSpot says closed and
 *     nothing says which way) is left exactly as it is and NAMED.
 *   • A DEAL ALREADY CLOSED IN THE APP IS STILL NEVER TOUCHED. The
 *     `existing.status !== "open"` guard below predates this and stays: this
 *     run can close a deal, and can never reopen one or overwrite an outcome
 *     recorded here.
 *   • A CLOSED DEAL THAT IS NOT ON THE BOARD HERE IS NOT CREATED. That is
 *     history, and inserting history is a backfill — hundreds of won/lost
 *     rows appearing in one run and moving every revenue figure with nobody
 *     pressing anything. The count is printed instead; the manual import is
 *     what loads history, deliberately and by hand.
 *
 * A deal this run closes does NOT generate a revenue schedule, because no
 * importer ever has — that is storage.updateDeal's Closed Won hook and it
 * only fires when a person moves the deal in the app. Same on both importers;
 * unchanged here.
 *
 * The deployed app makes no third-party calls (per the working agreement); this
 * worker is the external sync process that writes to Postgres.
 *
 * Env: HUBSPOT_TOKEN (private-app token with crm.objects.deals.read,
 *      crm.objects.companies.read, crm.objects.owners.read, and
 *      crm.pipelines.read), DATABASE_URL.
 *
 *   npm run import-hubspot-deals
 *   npm run import-hubspot-deals -- --dry-run
 */
const HS = "https://api.hubapi.com";

function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function hs<T = any>(path: string, token: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${HS}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 429 && attempt < 6) { await sleep(1000 * (attempt + 1)); continue; }
    if (!res.ok) throw new Error(`HubSpot ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json() as Promise<T>;
  }
}
async function hsPost<T = any>(path: string, token: string, body: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${HS}${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (res.status === 429 && attempt < 6) { await sleep(1000 * (attempt + 1)); continue; }
    if (!res.ok) throw new Error(`HubSpot POST ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json() as Promise<T>;
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Map an open HubSpot stage label onto the app's 4 open stages (won/lost are
// decided by stage metadata, not label).
function mapOpenStage(label: string): string {
  const l = label.toLowerCase();
  if (/qualif/.test(l)) return "Qualified to buy";
  if (/decision|bought|buy-in|bought-in/.test(l)) return "Decision maker bought-in";
  if (/contract|signed|negoti|develop/.test(l)) return "Contract sent";
  if (/pitch|present|proposal|appointment|demo|scheduled/.test(l)) return "Project pitched";
  return "Qualified to buy";
}

interface StageInfo { label: string; isClosed: boolean; probability: number }

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const token = env("HUBSPOT_TOKEN");

  // 1) Pipelines → stageId → {label, isClosed, probability}
  const pipes = await hs<{ results: Array<{ label: string; stages: Array<{ id: string; label: string; metadata: Record<string, string> }> }> }>("/crm/v3/pipelines/deals", token);
  const stageMap = new Map<string, StageInfo>();
  for (const p of pipes.results) for (const s of p.stages) {
    stageMap.set(s.id, { label: s.label, isClosed: s.metadata?.isClosed === "true", probability: Number(s.metadata?.probability ?? "0") });
  }

  // 2) Owners → id → name
  const ownerMap = new Map<string, string>();
  let ownerAfter: string | undefined;
  do {
    const q: { results: Array<{ id: string; firstName?: string; lastName?: string; email?: string }>; paging?: { next?: { after?: string } } } =
      await hs(`/crm/v3/owners?limit=100${ownerAfter ? `&after=${ownerAfter}` : ""}`, token);
    for (const o of q.results) ownerMap.set(o.id, [o.firstName, o.lastName].filter(Boolean).join(" ").trim() || o.email || "");
    ownerAfter = q.paging?.next?.after;
  } while (ownerAfter);

  // 3) Page through all deals with their company association.
  // hs_is_closed_won / hs_is_closed are HubSpot's own calculated booleans and
  // are rung 1 of src/hubspot-deal-status.ts — the same two the manual
  // importer has always read. The stage metadata fetched above is rung 2, for
  // a deal HubSpot answers neither flag for.
  //
  // hs_lastmodifieddate is fetched and deliberately NOT read. Last-writer-wins
  // between HubSpot and the app is a real design about clock skew across a
  // batch, not a condition to bolt on; what holds an app decision here is
  // deals.pipeline_set_at, which is a fact about who moved a field rather than
  // a race between two clocks.
  const props = ["dealname", "amount", "dealstage", "pipeline", "closedate", "hubspot_owner_id", "closed_lost_reason_deal", "hs_is_closed_won", "hs_is_closed", "hs_lastmodifieddate", "notes_last_updated"];
  type HsDeal = { id: string; properties: Record<string, string>; associations?: { companies?: { results?: Array<{ id: string }> } } };
  const deals: HsDeal[] = [];
  let after: string | undefined;
  do {
    const q: { results: HsDeal[]; paging?: { next?: { after?: string } } } =
      await hs(`/crm/v3/objects/deals?limit=100&associations=companies&properties=${props.join(",")}${after ? `&after=${after}` : ""}`, token);
    deals.push(...q.results);
    after = q.paging?.next?.after;
  } while (after);
  console.log(`import-hubspot-deals — pulled ${deals.length} deals, ${stageMap.size} stages, ${ownerMap.size} owners${dryRun ? " (dry-run)" : ""}`);

  // 4) Batch-resolve company names for all associated company ids.
  const companyIds = Array.from(new Set(deals.map((d) => d.associations?.companies?.results?.[0]?.id).filter(Boolean) as string[]));
  const companyName = new Map<string, string>();
  for (let i = 0; i < companyIds.length; i += 100) {
    const chunk = companyIds.slice(i, i + 100);
    const r = await hsPost<{ results: Array<{ id: string; properties: { name?: string } }> }>("/crm/v3/objects/companies/batch/read", token, { properties: ["name"], inputs: chunk.map((id) => ({ id })) });
    for (const c of r.results) companyName.set(c.id, c.properties?.name ?? "");
  }

  // Only deals from a SALES pipeline. This importer is the scheduled path
  // (11:00 and 23:00 UTC) and writes raw SQL straight into `deals`, so the
  // app's crm-import filter never sees these rows — without this, forty-six
  // delivery sign-offs from the "Contracts" pipeline keep arriving in the
  // sales forecast as $0 deals however many times somebody deletes them.
  // src/deal-pipeline.ts is a byte-for-byte copy of the app's authority; the
  // rule reads the pipeline id and nothing else, and a deal reporting no
  // pipeline is kept.
  const allowed = resolveAllowedPipelines(process.env[PIPELINE_ENV_VAR]);
  const skipped = new Map<string, { label: string; why: string; names: string[] }>();
  const salesDeals = deals.filter((d) => {
    const v = pipelineVerdict(d.properties.pipeline ?? null, allowed);
    if (v.keep) return true;
    const key = v.pipelineId ?? "(none)";
    const entry = skipped.get(key) ?? { label: v.label, why: v.why, names: [] };
    entry.names.push(`${d.properties.dealname || "(unnamed)"} [${d.id}]`);
    skipped.set(key, entry);
    return false;
  });

  // Never silently. A filter nobody can see the effect of is how a real deal
  // goes missing without anyone noticing for a quarter.
  if (skipped.size > 0) {
    const total = Array.from(skipped.values()).reduce((n, e) => n + e.names.length, 0);
    console.log(`  Skipped ${total} deal(s) from ${skipped.size} non-sales pipeline(s) (${PIPELINE_ENV_VAR}=* imports everything):`);
    for (const [id, e] of skipped) {
      console.log(`    ${e.label} (${id}) — ${e.names.length}: ${e.why}`);
      for (const n of e.names.slice(0, 20)) console.log(`      · ${n}`);
      if (e.names.length > 20) console.log(`      … and ${e.names.length - 20} more`);
    }
  }

  // ── What each deal's outcome is, decided once, before anything is written.
  //
  // src/hubspot-deal-status.ts is the rule and both importers in this repo read
  // it. A deal it refuses to read is closed with nothing saying which way; that
  // deal is left exactly as the app already holds it and is named at the end of
  // the run, because guessing "lost" takes a real win off the board and out of
  // every revenue figure that reads it.
  type Classified = { d: HsDeal; status: DealStatus; stage: string };
  const classified: Classified[] = [];
  const unreadableClose: string[] = [];
  for (const d of salesDeals) {
    const si = stageMap.get(d.properties.dealstage ?? "");
    const reading = dealStatus({
      isClosedWon: d.properties.hs_is_closed_won,
      isClosed: d.properties.hs_is_closed,
      // An unresolved stage is NOT an open stage and is NOT a closed one —
      // null, so the rule falls through rather than reading a gap in what we
      // fetched as a fact about the deal. Same call the old `isOpen` made.
      stageIsClosed: si ? si.isClosed : null,
      stageProbability: si ? si.probability : null,
    });
    if (reading.status === null) {
      unreadableClose.push(`    · ${d.properties.dealname || "(unnamed)"} [${d.id}] — ${reading.why}`);
      continue;
    }
    classified.push({
      d,
      status: reading.status,
      stage: dealStageLabel(reading.status, mapOpenStage(si?.label ?? "")),
    });
  }
  const openCount = classified.filter((c) => c.status === "open").length;
  const closedCount = classified.length - openCount;

  if (dryRun) {
    console.log(`  ${openCount} open · ${closedCount} closed (won/lost) to reconcile, of ${salesDeals.length} from a sales pipeline and ${deals.length} pulled; ${companyIds.length} companies referenced`);
    if (unreadableClose.length) {
      console.log(`  ${unreadableClose.length} deal(s) HubSpot calls closed with nothing saying won or lost — left alone:`);
      for (const line of unreadableClose) console.log(line);
    }
    console.log(`  A closed deal not already on the board here would be REPORTED, not created — history is the manual import's job.`);
    return;
  }

  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    // 5) Upsert companies (by hubspot_id, else by lower(name)) → app company id.
    const appCompanyId = new Map<string, string>(); // hubspotCompanyId → app id
    for (const hsCoId of companyIds) {
      const name = (companyName.get(hsCoId) || "").trim();
      if (!name) continue;
      let id: string | undefined;
      const byHs = await c.query<{ id: string }>(`SELECT id FROM companies WHERE hubspot_id = $1 LIMIT 1`, [hsCoId]);
      if (byHs.rows[0]) id = byHs.rows[0].id;
      if (!id) {
        const byName = await c.query<{ id: string }>(`SELECT id FROM companies WHERE lower(name) = lower($1) LIMIT 1`, [name]);
        if (byName.rows[0]) { id = byName.rows[0].id; await c.query(`UPDATE companies SET hubspot_id = $1 WHERE id = $2 AND hubspot_id IS NULL`, [hsCoId, id]); }
      }
      if (!id) {
        id = randomUUID();
        await c.query(`INSERT INTO companies (id, name, hubspot_id, notes) VALUES ($1, $2, $3, 'Imported from HubSpot')`, [id, name, hsCoId]);
      }
      appCompanyId.set(hsCoId, id);
    }

    // 6) Upsert by hubspot_id. A deal already closed in the APP is never
    //    touched; a deal open here and closed in HubSpot is now closed here;
    //    a closed deal that is not here at all is reported, never created.
    let created = 0, updated = 0, closedHere = 0, leftClosed = 0;
    const heldLines: string[] = [];
    const closedNotHere: string[] = [];
    // The app owns the schema (its ensureSchema runs on boot), and this job can
    // run before a deploy that added a column has been booted by a request. So
    // ask once rather than assume: without pipeline_set_at this behaves exactly
    // as it did before the hold existed, instead of failing the whole import on
    // a column that is about to appear.
    const hasHold = (await c.query<{ n: string }>(
      `SELECT 1 AS n FROM information_schema.columns WHERE table_name = 'deals' AND column_name = 'pipeline_set_at' LIMIT 1`,
    )).rows.length > 0;
    if (!hasHold) console.log("  deals.pipeline_set_at is not there yet — not holding anything this run (the app adds it on boot).");
    for (const { d, status, stage } of classified) {
      const p = d.properties;
      const amountCents = p.amount ? Math.round(Number(p.amount) * 100) : 0;
      const closeDate = p.closedate ? p.closedate.slice(0, 10) : null;
      const closedAt = dealClosedAt(status, closeDate);
      // Only meaningful on a lost deal, and it travels with the status for the
      // same reason closed_at does: writing one and holding the other leaves a
      // row that contradicts itself. A Closed lost with no reason is a row
      // nobody can analyse, which is what this job now has to produce rows of.
      const lostReason = status === "lost" ? (p.closed_lost_reason_deal || null) : null;
      const ownerName = p.hubspot_owner_id ? (ownerMap.get(p.hubspot_owner_id) || null) : null;
      const hsCoId = d.associations?.companies?.results?.[0]?.id;
      const companyId = hsCoId ? (appCompanyId.get(hsCoId) ?? null) : null;
      const lastContacted = p.notes_last_updated ? new Date(p.notes_last_updated) : null;
      const name = (p.dealname || "Untitled deal").trim();

      // Only touch a deal if it's new, or the existing one is still OPEN — never
      // reopen or overwrite a deal already marked won/lost in the app. This is
      // the guard that predates the close carrying across, and it is what keeps
      // an outcome recorded HERE safe from one recorded in HubSpot.
      const existing = await c.query<{ id: string; status: string; pipeline_set_at: Date | null; pipeline_set_by: string | null }>(
        hasHold
          ? `SELECT id, status, pipeline_set_at, pipeline_set_by FROM deals WHERE hubspot_id = $1 LIMIT 1`
          : `SELECT id, status, NULL::timestamptz AS pipeline_set_at, NULL::text AS pipeline_set_by FROM deals WHERE hubspot_id = $1 LIMIT 1`,
        [d.id],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].status !== "open") { leftClosed++; continue; } // leave closed app deals alone
        // ── A decision somebody made in the app is held here too (app v192).
        //
        // The status guard above was only ever half the rule: it stops this
        // run reopening a deal marked won or lost, and then overwrites stage,
        // amount, close date and owner on every deal that is still open. So a
        // stage moved on the app's pipeline board went back to HubSpot's
        // answer twice a day, silently -- the same defect the app's own
        // crm-import.ts had, one status along.
        //
        // deals.pipeline_set_at is stamped by the app's storage.updateDeal
        // when a person there actually MOVES one of those fields. It is NULL
        // on every deal nobody has touched, which is the ordinary state of an
        // imported deal, so those take HubSpot's values exactly as before.
        //
        // Per field rather than skipping the row, so name, company, source and
        // last-contacted keep refreshing on a held deal.
        const held = existing.rows[0].pipeline_set_at !== null;
        // status and closed_at are under the same hold as the other four: a
        // deal somebody here moved (including one they moved to Closed won)
        // keeps its outcome, and closed_at follows status so a held-open deal
        // never carries a close stamp and a held win never loses one.
        await c.query(
          hasHold
            ? `UPDATE deals SET name=$1, company_id=COALESCE($2, company_id),
                 stage        = CASE WHEN pipeline_set_at IS NULL THEN $3 ELSE stage END,
                 status       = CASE WHEN pipeline_set_at IS NULL THEN $4 ELSE status END,
                 amount_cents = CASE WHEN pipeline_set_at IS NULL THEN $5 ELSE amount_cents END,
                 close_date   = CASE WHEN pipeline_set_at IS NULL THEN $6 ELSE close_date END,
                 owner_name   = CASE WHEN pipeline_set_at IS NULL THEN $7 ELSE owner_name END,
                 closed_at    = CASE WHEN pipeline_set_at IS NULL THEN $8::timestamptz ELSE closed_at END,
                 closed_lost_reason = CASE WHEN pipeline_set_at IS NULL THEN $9 ELSE closed_lost_reason END,
                 source=COALESCE(source,'hubspot'), last_contacted_at=$10 WHERE id=$11`
            : `UPDATE deals SET name=$1, company_id=COALESCE($2, company_id), stage=$3, status=$4, amount_cents=$5,
                 close_date=$6, owner_name=$7, closed_at=$8::timestamptz, closed_lost_reason=$9,
                 source=COALESCE(source,'hubspot'), last_contacted_at=$10 WHERE id=$11`,
          [name, companyId, stage, status, amountCents, closeDate, ownerName, closedAt, lostReason, lastContacted, existing.rows[0].id],
        );
        if (held) {
          // Named, never counted silently: a hold nobody can see is the same
          // silence one field along.
          heldLines.push(`  · ${name} [${d.id}] — ${existing.rows[0].pipeline_set_by ?? "somebody in the app"} moved it; HubSpot says ${status}, stage "${stage}", ${(amountCents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })}, owner ${ownerName ?? "(none)"}`);
        } else if (status !== "open") {
          closedHere++;
        }
        updated++;
      } else if (status === "open") {
        await c.query(
          `INSERT INTO deals (id, name, company_id, stage, status, amount_cents, close_date, owner_name,
             source, hubspot_id, last_contacted_at)
           VALUES ($1,$2,$3,$4,'open',$5,$6,$7,'hubspot',$8,$9)`,
          [randomUUID(), name, companyId, stage, amountCents, closeDate, ownerName, d.id, lastContacted],
        );
        created++;
      } else {
        // A closed deal this board has never held. Reported, never inserted:
        // see the header — that is history, and a run that silently created
        // hundreds of won/lost rows would move every revenue figure in the app
        // with nobody having pressed anything.
        closedNotHere.push(`  · ${name} [${d.id}] — ${status}${closeDate ? ` ${closeDate}` : ""}, ${(amountCents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })}`);
      }
    }
    if (heldLines.length) {
      console.log(`\nHeld ${heldLines.length} deal(s) at the value somebody set in the app — HubSpot's is shown beside each.`);
      console.log(`Nothing else on these rows was held: name, company, source and last-contacted all refreshed.`);
      for (const line of heldLines) console.log(line);
    }
    if (closedNotHere.length) {
      console.log(`\n${closedNotHere.length} closed deal(s) HubSpot holds that are not on the board here — NOT imported.`);
      console.log(`That is history, and loading history is the manual import's job (npm run import-hubspot), so a person does it deliberately rather than a schedule moving every revenue figure overnight.`);
      for (const line of closedNotHere.slice(0, 20)) console.log(line);
      if (closedNotHere.length > 20) console.log(`  … and ${closedNotHere.length - 20} more`);
    }
    if (unreadableClose.length) {
      console.log(`\n${unreadableClose.length} deal(s) HubSpot calls closed with nothing saying won or lost — left exactly as they are.`);
      console.log(`Set the outcome in HubSpot, or move the deal on the pipeline board here (which then holds it against this run).`);
      for (const line of unreadableClose) console.log(line);
    }
    console.log(
      `Done: ${created} created, ${updated} updated, ${closedHere} closed here because HubSpot closed them` +
        `${leftClosed ? `, ${leftClosed} already closed in the app and left alone` : ""}` +
        `${heldLines.length ? `, ${heldLines.length} held at a decision made in the app` : ""}` +
        `${closedNotHere.length ? `, ${closedNotHere.length} closed in HubSpot and not on this board (reported, not created)` : ""}` +
        `${unreadableClose.length ? `, ${unreadableClose.length} with an unreadable outcome` : ""}` +
        `, ${appCompanyId.size} companies linked.`,
    );
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

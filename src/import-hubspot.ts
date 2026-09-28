import "dotenv/config";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { dealStatus, dealStageLabel, CLOSED_WON_STAGE, CLOSED_LOST_STAGE } from "./hubspot-deal-status";

/**
 * HubSpot → dashboard CRM import. The worker is the only place the HubSpot
 * token lives; it fetches companies/contacts/deals and hands them to the
 * dashboard's `npm run crm-import` (which upserts by hubspot_id — safe to
 * re-run). Mirrors emit.ts/runDashboardSync for metrics.
 *
 *   npm run import-hubspot                # full
 *   npm run import-hubspot -- --limit=20  # first N of each type (safe smoke test)
 */

const HS = "https://api.hubapi.com";

function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Missing required env var ${name}.`);
  return v.trim();
}

interface HSObj {
  id: string;
  properties: Record<string, string | null>;
  associations?: Record<string, { results?: Array<{ id: string }> }>;
}

async function hsGet(token: string, path: string): Promise<any> {
  const res = await fetch(`${HS}${path}`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`HubSpot GET ${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

async function fetchAll(
  token: string,
  object: string,
  properties: string[],
  associations: string[],
  limit: number | null,
): Promise<HSObj[]> {
  const out: HSObj[] = [];
  let after: string | undefined;
  do {
    const qp = new URLSearchParams({ limit: "100" });
    properties.forEach((p) => qp.append("properties", p));
    associations.forEach((a) => qp.append("associations", a));
    if (after) qp.set("after", after);
    const data = await hsGet(token, `/crm/v3/objects/${object}?${qp.toString()}`);
    out.push(...((data.results ?? []) as HSObj[]));
    after = data.paging?.next?.after;
    if (limit && out.length >= limit) return out.slice(0, limit);
  } while (after);
  return out;
}

async function fetchOwners(token: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let after: string | undefined;
  do {
    const qp = new URLSearchParams({ limit: "100" });
    if (after) qp.set("after", after);
    const data = await hsGet(token, `/crm/v3/owners?${qp.toString()}`);
    for (const o of data.results ?? []) {
      const name = [o.firstName, o.lastName].filter(Boolean).join(" ").trim() || o.email || "";
      if (o.id && name) map.set(String(o.id), name);
    }
    after = data.paging?.next?.after;
  } while (after);
  return map;
}

// Default "Sales Pipeline" stage ids → our board labels. Deals in other
// pipelines fall back to a status-derived label.
const STAGE: Record<string, string> = {
  qualifiedtobuy: "Qualified to buy",
  "23705448": "Project pitched",
  decisionmakerboughtin: "Decision maker bought-in",
  contractsent: "Contract sent",
  closedwon: "Closed won",
  closedlost: "Closed lost",
};

function assocFirst(o: HSObj, type: string): string | null {
  const r = o.associations?.[type]?.results;
  return r && r.length ? String(r[0]!.id) : null;
}

async function main() {
  const token = reqEnv("HUBSPOT_TOKEN");
  const databaseUrl = reqEnv("DATABASE_URL");
  const dashboardDir = reqEnv("DASHBOARD_DIR");
  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : null;

  console.log(`HubSpot → CRM import${limit ? ` (limit ${limit}/type — smoke test)` : " (full)"}…`);
  const owners = await fetchOwners(token);
  const hsCompanies = await fetchAll(token, "companies", ["name", "domain", "industry", "hubspot_owner_id"], [], limit);
  const hsContacts = await fetchAll(
    token,
    "contacts",
    // hubspot_owner_id and createdate were NOT here until 2026-09-28, and the
    // app has been accepting both on the contact payload the whole time (see
    // contactIn in server/crm-import.ts). So: every imported contact arrived
    // with no owner — measured on production that day, owner_name was null on
    // 828 of 828 contacts the Leads board can show — and created_at fell back
    // to the import time, which is up to a day late and made a form submission
    // that came in overnight look like every other row imported that morning.
    // Two property names; nothing else in either repo had to change.
    ["firstname", "lastname", "email", "phone", "jobtitle", "lifecyclestage", "hs_lead_status", "hs_analytics_source", "notes_last_contacted", "hubspot_owner_id", "createdate"],
    ["companies"],
    limit,
  );
  const hsDeals = await fetchAll(
    token,
    "deals",
    ["dealname", "amount", "dealstage", "pipeline", "closedate", "hubspot_owner_id", "hs_analytics_source", "hs_is_closed_won", "hs_is_closed", "dealtype", "hs_priority", "hs_forecast_category", "closed_lost_reason", "hs_deal_score", "notes_last_contacted"],
    ["companies"],
    limit,
  );
  console.log(`Fetched ${hsCompanies.length} companies · ${hsContacts.length} contacts · ${hsDeals.length} deals · ${owners.size} owners`);

  const companies = hsCompanies.map((c) => ({
    hubspotId: c.id,
    // Fall back to the domain (then a short id) rather than a wall of identical
    // "(unnamed company)" rows — HubSpot auto-creates nameless companies from
    // email domains, and those flood every company picker otherwise.
    name: c.properties.name?.trim() || c.properties.domain?.trim() || `Company ${String(c.id).slice(-6)}`,
    domain: c.properties.domain || null,
    industry: c.properties.industry || null,
    ownerName: c.properties.hubspot_owner_id ? owners.get(String(c.properties.hubspot_owner_id)) ?? null : null,
    notes: null,
  }));

  const contacts = hsContacts.map((c) => ({
    hubspotId: c.id,
    companyHubspotId: assocFirst(c, "companies"),
    name: [c.properties.firstname, c.properties.lastname].filter(Boolean).join(" ").trim() || c.properties.email || "(unnamed contact)",
    email: c.properties.email || null,
    phone: c.properties.phone || null,
    title: c.properties.jobtitle || null,
    lifecycleStage: c.properties.lifecyclestage || null,
    leadStatus: c.properties.hs_lead_status || null,
    originalSource: c.properties.hs_analytics_source || null,
    lastContactedAt: c.properties.notes_last_contacted || null,
    // The app fills a BLANK owner with this and never overwrites one somebody
    // set there — see the contact upsert in server/crm-import.ts.
    ownerName: c.properties.hubspot_owner_id ? owners.get(String(c.properties.hubspot_owner_id)) ?? null : null,
    // HubSpot's own createdate. The app only stamps it on INSERT, so a
    // re-import never re-dates a contact already here.
    createdAt: c.properties.createdate || null,
  }));

  // Won / lost / open is decided in ONE place for both importers in this repo
  // — src/hubspot-deal-status.ts. It used to be a ternary here and a different
  // ternary (plus a filter that dropped closed deals entirely) in
  // src/import-hubspot-deals.ts, which is how the scheduled path could never
  // close a deal. A deal the rule REFUSES to read (closed, with nothing saying
  // which way) is left out of the payload and named below, so the app keeps
  // whatever it already holds rather than being handed a guess.
  const unreadableClose: string[] = [];
  const deals = hsDeals.flatMap((d) => {
    const reading = dealStatus({
      isClosedWon: d.properties.hs_is_closed_won,
      isClosed: d.properties.hs_is_closed,
    });
    if (reading.status === null) {
      unreadableClose.push(`  · ${d.properties.dealname || "(unnamed deal)"} [${d.id}] — ${reading.why}`);
      return [];
    }
    const status = reading.status;
    // A stage id we recognise, but only as an OPEN stage: the closed label is
    // the status's own, so a deal whose stage id says closed and whose flags
    // say open can no longer arrive as "Closed won, open".
    const mapped = STAGE[d.properties.dealstage ?? ""];
    const openStage = mapped && mapped !== CLOSED_WON_STAGE && mapped !== CLOSED_LOST_STAGE ? mapped : "Qualified to buy";
    const stage = dealStageLabel(status, openStage);
    const amount = Number(d.properties.amount ?? 0);
    return [{
      hubspotId: d.id,
      companyHubspotId: assocFirst(d, "companies"),
      // Which HubSpot pipeline this came from. We have always ASKED for this
      // property (see the fetch list above) and always dropped it before the
      // app saw it, which is how forty-six delivery sign-offs from the
      // "Contracts" pipeline ended up in the sales forecast as $0 deals. The
      // app's shared/deal-pipeline.ts does the rest: allowlist, report, and
      // marking anything already on the board. Null is fine and means "keep",
      // so nothing changes for a payload that predates this.
      pipeline: d.properties.pipeline || null,
      name: d.properties.dealname || "(unnamed deal)",
      stage,
      status,
      amountCents: Number.isFinite(amount) ? Math.round(amount * 100) : 0,
      closeDate: d.properties.closedate ? String(d.properties.closedate).slice(0, 10) : null,
      ownerName: d.properties.hubspot_owner_id ? owners.get(String(d.properties.hubspot_owner_id)) ?? null : null,
      source: d.properties.hs_analytics_source || null,
      dealType: d.properties.dealtype || null,
      priority: d.properties.hs_priority || null,
      forecastCategory: d.properties.hs_forecast_category || null,
      closedLostReason: d.properties.closed_lost_reason || null,
      dealScore: d.properties.hs_deal_score != null && d.properties.hs_deal_score !== "" ? Math.round(Number(d.properties.hs_deal_score)) : null,
      lastContactedAt: d.properties.notes_last_contacted || null,
    }];
  });

  if (unreadableClose.length) {
    console.log(`\n${unreadableClose.length} deal(s) left out: HubSpot says closed and nothing says won or lost.`);
    console.log(`Nothing was written for these — the app keeps whatever it already holds. Set the outcome in HubSpot, or move the deal on the pipeline board here.`);
    for (const line of unreadableClose) console.log(line);
  }
  const byStatus = { open: 0, won: 0, lost: 0 };
  for (const d of deals) byStatus[d.status as keyof typeof byStatus]++;
  console.log(`Deal outcomes read from HubSpot: ${byStatus.open} open · ${byStatus.won} won · ${byStatus.lost} lost${unreadableClose.length ? ` · ${unreadableClose.length} unreadable` : ""}`);

  const dir = mkdtempSync(join(tmpdir(), "hsimport-"));
  const file = join(dir, "crm.json");
  writeFileSync(file, JSON.stringify({ companies, contacts, deals }, null, 2));
  console.log(`\n→ Wrote payload to ${file}; invoking \`npm run crm-import\`…`);

  const res = spawnSync("npm", ["run", "crm-import", "--", `--input=${file}`], {
    cwd: dashboardDir,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  if (res.error) {
    console.error(`Failed to run crm-import in ${dashboardDir}:`, res.error.message);
    process.exit(1);
  }
  process.exit(res.status ?? 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

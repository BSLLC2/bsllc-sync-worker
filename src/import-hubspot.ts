import "dotenv/config";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

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
    ["firstname", "lastname", "email", "phone", "jobtitle", "lifecyclestage", "hs_lead_status", "hs_analytics_source", "notes_last_contacted"],
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
    name: c.properties.name || "(unnamed company)",
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
  }));

  const deals = hsDeals.map((d) => {
    const won = d.properties.hs_is_closed_won === "true";
    const closed = d.properties.hs_is_closed === "true";
    const status = won ? "won" : closed ? "lost" : "open";
    const stage = STAGE[d.properties.dealstage ?? ""] ?? (won ? "Closed won" : closed ? "Closed lost" : "Qualified to buy");
    const amount = Number(d.properties.amount ?? 0);
    return {
      hubspotId: d.id,
      companyHubspotId: assocFirst(d, "companies"),
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
    };
  });

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

#!/usr/bin/env tsx
import "dotenv/config";
import { loadD365Config, getToken } from "./d365.js";

/**
 * Read-only: Power Automate's own captured run output proves leadsourcecode
 * WAS written successfully at creation (201 response, value baked into the
 * returned representation) -- yet every read of the same record via OUR
 * worker's own D365 app registration shows leadsourcecode: null, on every
 * sampled lead, including this one seconds after creation. A write
 * succeeding while every read (from a DIFFERENT credential/connection than
 * the one that wrote it) comes back null is the classic signature of
 * Dataverse Field-Level Security: a secured field returns null to any
 * caller not explicitly granted Read via a Field Security Profile, even
 * though the real value is stored. Checking whether leadsourcecode (and
 * new_firsttouchsource) are marked IsSecured, and what security profiles
 * exist, before concluding anything else.
 *
 *   npm run debug-d365-field-security
 */
async function main() {
  const cfg = loadD365Config();
  const token = await getToken(cfg);
  const base = cfg.resourceUrl.replace(/\/$/, "");

  for (const [entity, field] of [["lead", "leadsourcecode"], ["contact", "new_firsttouchsource"]] as const) {
    const url = `${base}/api/data/v9.2/EntityDefinitions(LogicalName='${entity}')/Attributes(LogicalName='${field}')?$select=LogicalName,IsSecured,IsValidForRead,DisplayName`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    const text = await res.text();
    console.log(`-- ${entity}.${field} metadata --`);
    console.log(res.status, text.slice(0, 1000));
    console.log("");
  }

  console.log("-- Field Security Profiles in this org (if any) --");
  const fspUrl = `${base}/api/data/v9.2/fieldsecurityprofiles?$select=fieldsecurityprofileid,name`;
  const fspRes = await fetch(fspUrl, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  console.log(fspRes.status, (await fspRes.text()).slice(0, 2000));

  console.log("\n-- Who is our worker's D365 app user, and what roles does it have? --");
  const whoAmIRes = await fetch(`${base}/api/data/v9.2/WhoAmI()`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  const whoAmI = (await whoAmIRes.json()) as { UserId?: string };
  console.log(whoAmI);
  if (whoAmI.UserId) {
    const rolesRes = await fetch(
      `${base}/api/data/v9.2/systemusers(${whoAmI.UserId})/systemuserroles_association?$select=name`,
      { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
    );
    console.log((await rolesRes.text()).slice(0, 2000));
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

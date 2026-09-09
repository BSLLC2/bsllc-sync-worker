#!/usr/bin/env tsx
import "dotenv/config";
import { loadD365Config, getToken, FTS } from "./d365.js";

/**
 * Read-only diagnostic: dump a few raw Lead records from Dataverse (dpg-prod)
 * to find the actual logical field name for "Lead Source" before building
 * anything that reads it. Guessing a field name risks either a 400 (safe,
 * loud) or worse: a wrong-but-valid field that silently reports zeros/nulls,
 * which would look like "no attribution data" instead of "we're reading the
 * wrong column." Also checks whether the Lead-side codes match the existing
 * Contact.new_firsttouchsource FTS enum (same numeric range would mean DPG
 * reuses one shared global choice set across both entities, per Sebastien's
 * description of the Switch being "fixed to map to the numeric choice codes
 * Dataverse actually needs" on 2026-09-02).
 *
 *   npm run debug-d365-lead-schema
 */
async function main() {
  const cfg = loadD365Config();
  const token = await getToken(cfg);
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "OData-MaxVersion": "4.0",
    "OData-Version": "4.0",
  };

  console.log("-- 3 raw Lead records (no $select, so all standard + custom fields come through) --");
  const leadsRes = await fetch(`${cfg.resourceUrl}/api/data/v9.2/leads?$top=3`, { headers });
  if (!leadsRes.ok) {
    console.error(`leads query failed (${leadsRes.status}): ${await leadsRes.text()}`);
  } else {
    const j = (await leadsRes.json()) as { value?: Record<string, unknown>[] };
    for (const lead of j.value ?? []) {
      console.log(JSON.stringify(lead, null, 2));
      console.log("---");
    }
  }

  console.log("\n-- Picklist (optionset) attributes on the Lead entity whose name suggests 'source' --");
  const metaUrl =
    `${cfg.resourceUrl}/api/data/v9.2/EntityDefinitions(LogicalName='lead')/Attributes` +
    `?$select=LogicalName,DisplayName&$filter=AttributeType eq Microsoft.Dynamics.CRM.AttributeTypeCode'Picklist'`;
  const metaRes = await fetch(metaUrl, { headers });
  if (!metaRes.ok) {
    console.error(`metadata query failed (${metaRes.status}): ${await metaRes.text()}`);
  } else {
    const j = (await metaRes.json()) as { value?: Array<{ LogicalName: string; DisplayName?: { UserLocalizedLabel?: { Label?: string } } }> };
    for (const a of j.value ?? []) {
      const label = a.DisplayName?.UserLocalizedLabel?.Label ?? "";
      if (/source/i.test(a.LogicalName) || /source/i.test(label)) {
        console.log(`  ${a.LogicalName}  (label: "${label}")`);
      }
    }
  }

  console.log("\n-- For reference, our existing Contact.new_firsttouchsource FTS codes --");
  console.log(FTS);

  console.log("\n-- Does Contact have an 'originatingleadid' back-reference we could use instead of an email match? --");
  const contactRes = await fetch(
    `${cfg.resourceUrl}/api/data/v9.2/contacts?$top=1&$select=contactid,emailaddress1,new_firsttouchsource,_originatingleadid_value`,
    { headers },
  );
  if (!contactRes.ok) {
    console.error(`contacts query failed (${contactRes.status}): ${await contactRes.text()}`);
  } else {
    console.log(await contactRes.text());
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

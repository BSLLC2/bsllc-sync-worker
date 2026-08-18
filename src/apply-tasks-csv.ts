#!/usr/bin/env tsx
import "dotenv/config";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import pg from "pg";

/**
 * One-off/idempotent bulk task applier: reads a tasks CSV and UPSERTS each row
 * into commitments by (client_id, lower(title)) — updating due date, estimated
 * hours, priority, status, owner, assignee, description on a match; inserting
 * otherwise. Mirrors the dashboard's bulk importer, but runs from the worker so
 * we can apply a file directly without a UI upload.
 *
 *   npm run apply-tasks-csv -- data/lbl-tasks.csv
 *   npm run apply-tasks-csv -- data/lbl-tasks.csv --dry-run
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

// Minimal quoted-CSV parser (handles quotes, escaped quotes, CRLF).
function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let cur: string[] = []; let f = ""; let q = false; let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i += 2; continue; } q = false; i++; continue; }
      f += c; i++; continue;
    }
    if (c === '"') { q = true; i++; continue; }
    if (c === ",") { cur.push(f); f = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { cur.push(f); rows.push(cur); cur = []; f = ""; i++; continue; }
    f += c; i++;
  }
  if (f.length || cur.length) { cur.push(f); rows.push(cur); }
  while (rows.length && (rows[rows.length - 1] ?? []).every((x) => x.trim() === "")) rows.pop();
  return rows;
}

const OWNER_AGENCY = ["agency", "bs_llc", "bsllc", "bs", "us", "internal", "team"];
function normOwnerType(v: string): string { const o = v.toLowerCase().replace(/[\s-]+/g, "_").trim(); return OWNER_AGENCY.includes(o) ? "bs_llc" : o === "client" ? "client" : "bs_llc"; }
function normStatus(v: string): string {
  const s = (v || "").toLowerCase().replace(/[\s-]+/g, "_").trim();
  if (["done", "completed", "complete"].includes(s)) return "complete";
  if (["in_progress", "inprogress", "started", "doing"].includes(s)) return "in_progress";
  if (["blocked", "stuck"].includes(s)) return "blocked";
  return "not_started";
}
const roundHalf = (n: number) => Math.max(0, Math.round(n * 2) / 2);
const truthy = (v: string) => ["true", "yes", "1", "y", "x"].includes((v || "").toLowerCase().trim());

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const path = args.find((a) => !a.startsWith("--")) || "data/lbl-tasks.csv";
  const table = parseCsv(readFileSync(path, "utf8"));
  if (table.length < 2) throw new Error("CSV has no data rows");
  const header = (table[0] ?? []).map((h) => h.trim());
  const idx = (name: string) => header.indexOf(name);
  const col = { clientName: idx("clientName"), priority: idx("priority"), title: idx("title"), description: idx("description"), ownerType: idx("ownerType"), ownerName: idx("ownerName"), assigneeName: idx("assigneeName"), status: idx("status"), dueDate: idx("dueDate"), estimatedHours: idx("estimatedHours"), isMilestone: idx("isMilestone"), clientVisible: idx("clientVisible"), link: idx("link"), category: idx("category") };
  // Optional client-facing flags — only touched when the CSV actually has the column.
  const hasMilestone = col.isMilestone >= 0, hasVisible = col.clientVisible >= 0, hasLink = col.link >= 0, hasCategory = col.category >= 0;
  const dataRows = table.slice(1);
  console.log(`apply-tasks-csv — ${dataRows.length} rows from ${path}${dryRun ? " (dry-run)" : ""}`);

  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    // Ensure the hours column can hold halves regardless of app-boot timing.
    await c.query(`ALTER TABLE commitments ALTER COLUMN estimated_hours TYPE double precision`).catch(() => {});

    // Resolve client ids by name once.
    const clientIdByName = new Map<string, string>();
    const clientRows = (await c.query<{ id: string; name: string }>(`SELECT id, name FROM clients`)).rows;
    for (const r of clientRows) clientIdByName.set(r.name.toLowerCase().trim(), r.id);

    let created = 0, updated = 0, skipped = 0;
    for (const row of dataRows) {
      const clientName = (row[col.clientName] ?? "").trim();
      const clientId = clientIdByName.get(clientName.toLowerCase());
      const title = (row[col.title] ?? "").trim();
      if (!clientId) { console.log(`  skip: no client "${clientName}"`); skipped++; continue; }
      if (!title) { skipped++; continue; }
      const priority = (row[col.priority] ?? "P1").toUpperCase().trim();
      const description = (row[col.description] ?? "").trim() || null;
      const ownerType = normOwnerType(row[col.ownerType] ?? "");
      const ownerName = (row[col.ownerName] ?? "").trim() || null;
      const assigneeName = (row[col.assigneeName] ?? "").trim() || null;
      const status = normStatus(row[col.status] ?? "");
      const dueDate = (row[col.dueDate] ?? "").trim() || null;
      const hoursRaw = (row[col.estimatedHours] ?? "").trim();
      const estimatedHours = hoursRaw ? roundHalf(Number(hoursRaw) || 0) : 0;
      const isMilestone = hasMilestone ? truthy(row[col.isMilestone] ?? "") : false;
      const clientVisible = hasVisible ? truthy(row[col.clientVisible] ?? "") : false;
      const link = hasLink ? ((row[col.link] ?? "").trim() || null) : null;
      // Category: 'setup' gates the launch-readiness score, so it must be
      // explicit. Retainer/ongoing plans are the common bulk import, so default
      // to 'ongoing' unless the row says 'setup' — never silently inflate setup.
      const category = ((row[col.category] ?? "").trim().toLowerCase() === "setup") ? "setup" : "ongoing";

      if (dryRun) { updated++; continue; }
      const existing = await c.query<{ id: string }>(`SELECT id FROM commitments WHERE client_id = $1 AND lower(trim(title)) = lower(trim($2)) LIMIT 1`, [clientId, title]);
      if (existing.rows[0]) {
        // Build the SET dynamically so the flag columns are only overwritten when
        // the CSV carries them — other CSVs (no flag columns) leave them intact.
        const sets = ["priority=$1", "description=COALESCE($2, description)", "owner_type=$3", "owner_name=$4", "assignee_name=$5", "status=$6", "due_date=$7", "estimated_hours=$8", "last_updated_at=now()"];
        const params: (string | number | boolean | null)[] = [priority, description, ownerType, ownerName, assigneeName, status, dueDate, estimatedHours];
        let p = 9;
        if (hasMilestone) { sets.push(`is_milestone=$${p++}`); params.push(isMilestone); }
        if (hasVisible) { sets.push(`client_visible=$${p++}`); params.push(clientVisible); }
        if (hasLink) { sets.push(`link=COALESCE($${p++}, link)`); params.push(link); }
        if (hasCategory) { sets.push(`category=$${p++}`); params.push(category); }
        params.push(existing.rows[0].id);
        await c.query(`UPDATE commitments SET ${sets.join(", ")} WHERE id=$${p}`, params);
        updated++;
      } else {
        await c.query(
          `INSERT INTO commitments (id, client_id, priority, title, description, owner_type, owner_name, assignee_name, status, due_date, estimated_hours, category, is_milestone, client_visible, link)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [randomUUID(), clientId, priority, title, description, ownerType, ownerName, assigneeName, status, dueDate, estimatedHours, category, isMilestone, clientVisible, link],
        );
        created++;
      }
    }
    console.log(`Done: ${created} created, ${updated} updated, ${skipped} skipped.`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

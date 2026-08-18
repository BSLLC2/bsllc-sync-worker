#!/usr/bin/env tsx
import "dotenv/config";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import pg from "pg";

/**
 * Reconcile LBL's tasks against the refined Aug-2026 Master Priority list
 * (data/lbl-master-priorities.json — one row per refined action).
 *
 * Rules (per Sebastien):
 *   • Replace tasks that are the SAME — a refined action fuzzy-matched to an
 *     existing OPEN task retitles/updates that task in place (priority,
 *     category, due date, description, status), so we don't create duplicates.
 *   • Keep CLOSED work closed — a refined action whose best match is already
 *     `complete` is left untouched and NOT re-added (e.g. contract signed).
 *     Complete tasks are never modified and never reopened.
 *   • Add genuinely NEW actions that don't match anything open.
 *   • Never delete. Unmatched existing open tasks are left as-is and reported.
 *
 * Matching: exact title first (so re-runs are stable once titles are aligned),
 * then significant-token overlap ≥ threshold. Each existing task is claimed at
 * most once.
 *
 *   npm run reconcile-lbl-tasks -- --dry-run     # print the plan, write nothing
 *   npm run reconcile-lbl-tasks                  # apply
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

interface Refined {
  extId: string; title: string; priority: string; status: string;
  category: string; dueDate: string | null; workstream: string; window: string;
  ownerName: string; srcStatus: string; description: string | null;
}
interface Task { id: string; title: string; status: string; category: string; priority: string; }

const STOP = new Set(["the","a","an","of","to","and","or","for","on","in","at","by","with","from","into","is","are","be","that","this","it","as","per","not","no","do","we","our","all","any","every","new","up","off","out","before","after","onto","than","then","if","yes","its","their","them","across","onto"]);
// Split common joined brand tokens so "DigitalLogic" matches "Digital Logic".
function preNorm(s: string): string {
  return (s || "").toLowerCase()
    .replace(/digitallogic/g, "digital logic")
    .replace(/callrail/g, "call rail")
    .replace(/youtube/g, "you tube")
    .replace(/[^a-z0-9\s]/g, " ");
}
const stem = (w: string) => w.replace(/(ies)$/, "y").replace(/(es|s)$/, "");
function tokens(s: string): Set<string> {
  const words = preNorm(s).split(/\s+/).filter(Boolean);
  return new Set(words.filter((w) => w.length > 2 && !STOP.has(w)).map(stem));
}
/** How well an existing task matches the refined action (0..1). */
function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0) return 0;
  let hit = 0; for (const t of a) if (b.has(t)) hit++;
  const cover = hit / a.size;                 // how much of the refined action is present
  const rev = b.size ? hit / b.size : 0;      // how much of the existing task is present
  // Reward absolute shared-token count too, so long titles that share 3–4
  // significant words match even when each has extra words.
  const byCount = Math.min(1, hit / 3);
  return Math.max(cover, rev * 0.9, byCount * 0.75);
}

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const refined: Refined[] = JSON.parse(readFileSync("data/lbl-master-priorities.json", "utf8"));

  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const cl = (await c.query<{ id: string; name: string }>(
      `SELECT id, name FROM clients WHERE name ILIKE 'LBL%' OR lower(name) LIKE '%lawrence%' ORDER BY name`,
    )).rows;
    if (cl.length !== 1) { console.log(`Expected exactly one LBL client, found ${cl.length}: ${cl.map((x) => x.name).join(", ")}`); return; }
    const client = cl[0]!;
    console.log(`Client: ${client.name} (${client.id})`);

    const tasks = (await c.query<Task>(
      `SELECT id, title, status, category, priority FROM commitments WHERE client_id = $1`, [client.id],
    )).rows;
    const open = tasks.filter((t) => t.status !== "complete");
    const done = tasks.filter((t) => t.status === "complete");
    console.log(`Existing LBL tasks: ${tasks.length} (${open.length} open, ${done.length} complete)\n`);

    const tokById = new Map(tasks.map((t) => [t.id, tokens(t.title)]));
    const byExactTitle = new Map(tasks.map((t) => [t.title.toLowerCase().trim(), t]));
    const claimed = new Set<string>();
    const THRESH = 0.5;

    const plan = { update: [] as string[], keepComplete: [] as string[], insert: [] as string[] };
    type Op = { kind: "update" | "insert" | "keep"; refined: Refined; taskId?: string };
    const ops: Op[] = [];

    for (const r of refined) {
      // 1) exact title (stable on re-run)
      const exact = byExactTitle.get(r.title.toLowerCase().trim());
      if (exact && !claimed.has(exact.id)) {
        if (exact.status === "complete") { claimed.add(exact.id); plan.keepComplete.push(`[${r.extId}] ${r.title}`); ops.push({ kind: "keep", refined: r, taskId: exact.id }); continue; }
        claimed.add(exact.id); plan.update.push(`[${r.extId}] ${r.title}  (exact)`); ops.push({ kind: "update", refined: r, taskId: exact.id }); continue;
      }
      // 2) best fuzzy match among all tasks
      const rtok = tokens(r.title);
      let best: { t: Task; score: number } | null = null;
      for (const t of tasks) {
        if (claimed.has(t.id)) continue;
        const score = overlap(rtok, tokById.get(t.id)!);
        if (!best || score > best.score) best = { t, score };
      }
      if (best && best.score >= THRESH) {
        claimed.add(best.t.id);
        if (best.t.status === "complete") { plan.keepComplete.push(`[${r.extId}] ${r.title}  ⟵ done: "${best.t.title}"`); ops.push({ kind: "keep", refined: r, taskId: best.t.id }); }
        else { plan.update.push(`[${r.extId}] ${r.title}\n        ⟵ replaces open: "${best.t.title}" (score ${best.score.toFixed(2)})`); ops.push({ kind: "update", refined: r, taskId: best.t.id }); }
      } else {
        plan.insert.push(`[${r.extId}] ${r.title}`);
        ops.push({ kind: "insert", refined: r });
      }
    }

    const unmatchedOpen = open.filter((t) => !claimed.has(t.id));

    // Unmatched first (it's the long list), then the decision-relevant sections
    // and a compact summary LAST so it's always visible at the end of the log.
    console.log(`━━━ PLAN ━━━`);
    console.log(`\nUNMATCHED EXISTING OPEN (left as-is) — ${unmatchedOpen.length}`);
    unmatchedOpen.forEach((t) => console.log(`  • "${t.title}" [${t.status}/${t.category}]`));
    console.log(`\nUPDATE (replace same open task in place) — ${plan.update.length}`);
    plan.update.forEach((s) => console.log(`  • ${s}`));
    console.log(`\nKEEP COMPLETE (already done, untouched) — ${plan.keepComplete.length}`);
    plan.keepComplete.forEach((s) => console.log(`  • ${s}`));
    console.log(`\nINSERT (new action, no match found) — ${plan.insert.length}`);
    plan.insert.forEach((s) => console.log(`  • ${s}`));
    console.log(`\n━━━ SUMMARY ━━━`);
    console.log(`  existing tasks: ${tasks.length} (${open.length} open, ${done.length} complete)`);
    console.log(`  refined actions: ${refined.length}`);
    console.log(`  → UPDATE ${plan.update.length} · KEEP-COMPLETE ${plan.keepComplete.length} · INSERT ${plan.insert.length} · leave-as-is ${unmatchedOpen.length}`);

    if (dryRun) { console.log(`\n(dry-run — nothing written)`); return; }

    let updated = 0, inserted = 0;
    for (const op of ops) {
      const r = op.refined;
      if (op.kind === "keep") continue;
      if (op.kind === "update" && op.taskId) {
        // Refine the task in place but PRESERVE its live status (never regress an
        // in_progress/blocked task, never reopen a complete one) and keep
        // is_milestone/client_visible/link untouched.
        await c.query(
          `UPDATE commitments SET title=$1, priority=$2, category=$3,
             due_date=$4, description=COALESCE($5, description), owner_type='bs_llc',
             owner_name=$6, workstream=$7, last_updated_at=now() WHERE id=$8`,
          [r.title, r.priority, r.category, r.dueDate, r.description, r.ownerName, r.workstream || null, op.taskId],
        );
        updated++;
      } else if (op.kind === "insert") {
        await c.query(
          `INSERT INTO commitments (id, client_id, priority, title, description, owner_type, owner_name, status, due_date, estimated_hours, category, workstream, is_milestone, client_visible)
           VALUES ($1,$2,$3,$4,$5,'bs_llc',$6,$7,$8,0,$9,$10,false,false)`,
          [randomUUID(), client.id, r.priority, r.title, r.description, r.ownerName, r.status, r.dueDate, r.category, r.workstream || null],
        );
        inserted++;
      }
    }
    console.log(`\n✓ Applied: ${updated} updated, ${inserted} inserted, ${plan.keepComplete.length} kept complete, ${unmatchedOpen.length} left as-is.`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error("✗ reconcile-lbl-tasks failed:", e instanceof Error ? e.message : e); process.exit(1); });

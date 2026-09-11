#!/usr/bin/env tsx
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";

/**
 * Seed "Client knowledge" from the research briefs.
 *
 * The Drive research agents write one markdown file per client into the
 * dashboard repo at docs/client-knowledge/<slug>.md (slug = the dashboard's
 * clientSlug(name): lowercase, non-alphanumerics → "-"). Each file opens with
 * an "As of <date>" line and has exactly nine H2 sections. This script splits
 * each file by H2 and upserts one client_module_notes row per section, keyed
 * `knowledge.<section>` (see SECTIONS below), plus `knowledge.as-of` for the
 * date line — all stamped updated_by = 'drive-research'.
 *
 * Rules:
 *  • A row whose updated_by is anything other than 'drive-research' (or NULL
 *    from a legacy insert) was edited by a person in the app. It is never
 *    overwritten — it's printed as "skipped (edited by <name>)" — so a human
 *    correction survives every re-run.
 *  • Idempotent: an unchanged section is left alone (updated_at untouched).
 *  • The file is the source of truth for research-owned rows: a section that
 *    is missing or empty in the file deletes the research-owned row for it,
 *    so "sections filled / 9" in the app stays honest. Human rows are kept.
 *  • Unknown H2 headings are reported and ignored; nothing else in the row
 *    set is touched.
 *
 *   DASHBOARD_DIR=../bsllc-account-health npm run seed-client-knowledge -- --dry-run
 *   npm run seed-client-knowledge -- --client=franklin-brazing
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }
function arg(name: string): string | undefined {
  const p = `--${name}=`;
  const hit = process.argv.slice(2).find((a) => a.startsWith(p));
  return hit ? hit.slice(p.length).replace(/^"|"$/g, "").trim() : undefined;
}
const flag = (name: string) => process.argv.slice(2).includes(`--${name}`) || arg(name) === "true";

const SEED_AUTHOR = "drive-research";
const KEY_PREFIX = "knowledge.";
const AS_OF_KEY = `${KEY_PREFIX}as-of`;

/** Mirror of shared/client-knowledge.ts in the dashboard repo — keep in step.
 *  `match` is tested against the normalized H2 text (lowercase, punctuation
 *  stripped) so "Contract & commercials", "Contract and Commercials" and
 *  "Contract" all land on the same key. */
const SECTIONS: Array<{ slug: string; title: string; match: RegExp }> = [
  { slug: "company", title: "Company", match: /^company\b/ },
  { slug: "contacts", title: "Contacts", match: /^contacts?\b/ },
  { slug: "contract", title: "Contract & commercials", match: /^contract\b/ },
  { slug: "economics", title: "Customer value & economics", match: /^(customer value|economics)\b/ },
  { slug: "strategy", title: "Goals & strategy", match: /^(goals?|strategy)\b/ },
  { slug: "systems", title: "Systems & access", match: /^(systems?|access)\b/ },
  { slug: "history", title: "History & decisions", match: /^(history|decisions?)\b/ },
  { slug: "asks", title: "Open asks & risks", match: /^(open asks?|asks?|risks?)\b/ },
  { slug: "sources", title: "Sources", match: /^sources?\b/ },
];

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const normalizeHeading = (h: string) => h.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

interface ParsedBrief {
  asOf: string | null;
  sections: Map<string, string>; // slug → body (trimmed, non-empty)
  unknownHeadings: string[];
}

/** Split the brief by H2. Everything before the first H2 is the preamble;
 *  the "As of …" line is read from there (falls back to anywhere in the
 *  file). Fenced code blocks are respected so a "## " inside one doesn't
 *  start a section. */
export function parseBrief(text: string): ParsedBrief {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const sections = new Map<string, string>();
  const unknownHeadings: string[] = [];
  let current: { slug: string | null; heading: string; lines: string[] } = { slug: null, heading: "(preamble)", lines: [] };
  const preamble: string[] = [];
  let inFence = false;
  const flush = () => {
    const body = current.lines.join("\n").trim();
    if (current.heading === "(preamble)") preamble.push(...current.lines);
    else if (current.slug) {
      if (body) sections.set(current.slug, (sections.get(current.slug) ? `${sections.get(current.slug)}\n\n${body}` : body));
    }
  };
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const h2 = !inFence ? line.match(/^##\s+(.+?)\s*#*\s*$/) : null;
    if (h2) {
      flush();
      const heading = (h2[1] ?? "").trim();
      const norm = normalizeHeading(heading);
      const hit = SECTIONS.find((s) => s.match.test(norm));
      if (!hit) unknownHeadings.push(heading);
      current = { slug: hit?.slug ?? null, heading, lines: [] };
      continue;
    }
    current.lines.push(line);
  }
  flush();
  // Stored as just the date text ("2026-09-10", "September 10, 2026") — the
  // panel adds the "As of" wording itself.
  const asOfLine = [...preamble, ...lines].find((l) => /^\s*(\*\*|_|#+\s*)?as of\b/i.test(l));
  const asOfMatch = asOfLine?.match(/as of\s*:?\s*(.+)/i);
  const asOf = asOfMatch?.[1] ? asOfMatch[1].replace(/[*_\s.]+$/, "").trim() || null : null;
  return { asOf, sections, unknownHeadings };
}

interface NoteRow { id: string; module_key: string; body: string; updated_by: string | null }

async function main() {
  const dryRun = flag("dry-run");
  const onlyClient = arg("client")?.toLowerCase() || null;
  const dashboardDir = env("DASHBOARD_DIR");
  const dir = join(dashboardDir, "docs", "client-knowledge");
  if (!existsSync(dir)) {
    console.log(`No ${dir} — nothing to seed.`);
    return;
  }
  const files = readdirSync(dir).filter((f) => f.endsWith(".md") && !f.startsWith("_") && f.toLowerCase() !== "readme.md").sort();
  if (!files.length) { console.log(`No *.md files in ${dir} — nothing to seed.`); return; }

  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  const totals = { clients: 0, inserted: 0, updated: 0, unchanged: 0, skipped: 0, deleted: 0, unmatched: 0 };
  try {
    const { rows: clients } = await c.query<{ id: string; name: string }>(`SELECT id, name FROM clients`);
    const bySlug = new Map(clients.map((r) => [slugify(r.name), r]));

    for (const file of files) {
      const slug = file.replace(/\.md$/, "").toLowerCase();
      if (onlyClient && slug !== onlyClient) continue;
      const client = bySlug.get(slug);
      if (!client) {
        totals.unmatched += 1;
        console.log(`\n✗ ${file}: no client whose slug is "${slug}" — skipped. (Slugs in DB: ${[...bySlug.keys()].sort().join(", ")})`);
        continue;
      }
      totals.clients += 1;
      const brief = parseBrief(readFileSync(join(dir, file), "utf8"));
      console.log(`\n${client.name} (${file})${dryRun ? " — dry run" : ""}`);
      if (!brief.asOf) console.log(`  ! no "As of <date>" line found`);
      for (const h of brief.unknownHeadings) console.log(`  ! unrecognised H2 ignored: "${h}"`);
      const missing = SECTIONS.filter((s) => !brief.sections.has(s.slug)).map((s) => s.title);
      if (missing.length) console.log(`  · empty/missing in file: ${missing.join(", ")}`);

      const { rows: existingRows } = await c.query<NoteRow>(
        `SELECT id, module_key, body, updated_by FROM client_module_notes WHERE client_id = $1 AND module_key LIKE $2`,
        [client.id, `${KEY_PREFIX}%`],
      );
      const existing = new Map(existingRows.map((r) => [r.module_key, r]));

      const wanted = new Map<string, string>();
      for (const [sectionSlug, body] of brief.sections) wanted.set(`${KEY_PREFIX}${sectionSlug}`, body);
      if (brief.asOf) wanted.set(AS_OF_KEY, brief.asOf);

      // Upserts
      for (const [key, body] of wanted) {
        const label = key === AS_OF_KEY ? "as-of" : (SECTIONS.find((s) => `${KEY_PREFIX}${s.slug}` === key)?.title ?? key);
        const row = existing.get(key);
        if (row && row.updated_by && row.updated_by !== SEED_AUTHOR) {
          totals.skipped += 1;
          console.log(`  – ${label}: skipped (edited by ${row.updated_by})`);
          continue;
        }
        if (row && row.body === body && row.updated_by === SEED_AUTHOR) {
          totals.unchanged += 1;
          continue;
        }
        if (row) {
          totals.updated += 1;
          console.log(`  ↻ ${label}: updated (${body.length} chars)`);
          if (!dryRun) await c.query(`UPDATE client_module_notes SET body = $1, updated_by = $2, updated_at = now() WHERE id = $3`, [body, SEED_AUTHOR, row.id]);
        } else {
          totals.inserted += 1;
          console.log(`  + ${label}: inserted (${body.length} chars)`);
          if (!dryRun) {
            await c.query(
              `INSERT INTO client_module_notes (id, client_id, module_key, body, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5, now())`,
              [randomUUID(), client.id, key, body, SEED_AUTHOR],
            );
          }
        }
      }

      // Research-owned rows the file no longer has → delete so "filled / 9" stays true.
      for (const [key, row] of existing) {
        if (wanted.has(key)) continue;
        if (row.updated_by && row.updated_by !== SEED_AUTHOR) continue; // a person's row stays
        const label = key === AS_OF_KEY ? "as-of" : (SECTIONS.find((s) => `${KEY_PREFIX}${s.slug}` === key)?.title ?? key);
        totals.deleted += 1;
        console.log(`  × ${label}: removed (no longer in file)`);
        if (!dryRun) await c.query(`DELETE FROM client_module_notes WHERE id = $1`, [row.id]);
      }
    }
  } finally {
    await c.end();
  }
  console.log(
    `\n${dryRun ? "Dry run — nothing written. Would be: " : "Done: "}` +
      `${totals.clients} client(s) · ${totals.inserted} inserted · ${totals.updated} updated · ${totals.unchanged} unchanged · ` +
      `${totals.skipped} skipped (human-edited) · ${totals.deleted} removed · ${totals.unmatched} file(s) with no matching client`,
  );
  if (totals.unmatched) process.exitCode = 2;
}

// Only run when invoked directly, so parseBrief can be imported by a test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error("✗ seed-client-knowledge failed:", e instanceof Error ? e.message : e); process.exit(1); });
}

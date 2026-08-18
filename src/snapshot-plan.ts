#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { JWT } from "google-auth-library";

/**
 * Freezes ("snapshots") a plan Google Doc to an immutable PDF the moment a
 * client sign-off is requested, so the e-signature binds to the exact version
 * the client read. The deployed app makes ZERO third-party calls — it enqueues
 * a row in `notifications_outbox` (kind='plan_snapshot'); this worker holds the
 * Google service-account key and does the export + upload.
 *
 * Each queued row carries:
 *   commitment_id, client_id, payload_json = {"link": "<doc/drive url>", "title": "<task title>"}
 *
 * For each row we: parse the Drive file id from the link, export the Doc (or
 * download the binary) as a PDF via the service account, upload that PDF to the
 * signed-plans Drive folder, make it link-viewable, then record the frozen
 * copy's url on the commitment and mark the outbox row sent.
 *
 * Auth reuses the same service-account JWT + multipart Drive upload as
 * upload-to-drive.ts. Reading a user's Doc usually requires impersonating a
 * Workspace user who can access it — set SIGNED_PLANS_DRIVE_IMPERSONATE (falls
 * back to BACKUP_DRIVE_IMPERSONATE). The signed-plans folder should be a Shared
 * Drive (or owned by the impersonated user) so the SA has somewhere to write.
 *
 * Dormant-ready: if SIGNED_PLANS_DRIVE_FOLDER_ID or GOOGLE_SERVICE_ACCOUNT_JSON
 * is unset, logs a clear message and exits 0 WITHOUT marking rows sent, so
 * queued jobs process once configured (mirrors how send-sms.ts stays dormant).
 *
 * Env:
 *   DATABASE_URL                     Postgres connection string
 *   GOOGLE_SERVICE_ACCOUNT_JSON      the SA key (same one used elsewhere)
 *   SIGNED_PLANS_DRIVE_FOLDER_ID     target folder / shared-drive folder id
 *   SIGNED_PLANS_DRIVE_IMPERSONATE   (optional) Workspace user to read/own as
 *   BACKUP_DRIVE_IMPERSONATE         (optional) fallback impersonation subject
 *
 *   npm run snapshot-plans
 *   npm run snapshot-plans -- --dry-run
 *   npm run snapshot-plans -- --commitment=<id>
 */
const SCOPE = "https://www.googleapis.com/auth/drive";

function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit?.split("=").slice(1).join("=").replace(/^"|"$/g, "");
}
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

/** Pull the Drive/Docs file id out of the shapes the dashboard stores. */
function parseFileId(link: string): string | null {
  if (!link) return null;
  // https://docs.google.com/document/d/<ID>/edit  and  drive.google.com/file/d/<ID>/view
  const path = link.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (path?.[1]) return path[1];
  // https://drive.google.com/open?id=<ID>  and  ...?id=<ID>
  const query = link.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (query?.[1]) return query[1];
  return null;
}

async function token(): Promise<string> {
  const sa = JSON.parse(env("GOOGLE_SERVICE_ACCOUNT_JSON"));
  if (!sa.client_email || !sa.private_key) throw new Error("Service-account JSON missing client_email / private_key.");
  const subject = process.env.SIGNED_PLANS_DRIVE_IMPERSONATE?.trim() || process.env.BACKUP_DRIVE_IMPERSONATE?.trim() || undefined;
  const jwt = new JWT({ email: sa.client_email, key: sa.private_key, scopes: [SCOPE], subject });
  const { token } = await jwt.getAccessToken();
  if (!token) throw new Error("Failed to mint a Drive token.");
  return token;
}

interface FileMeta { id: string; name: string; mimeType: string; modifiedTime?: string }

async function fileMeta(t: string, id: string): Promise<FileMeta> {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${id}?fields=id,name,mimeType,modifiedTime&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${t}` } },
  );
  if (!res.ok) throw new Error(`Drive metadata (${res.status}): ${await res.text()}`);
  return (await res.json()) as FileMeta;
}

async function pdfBytes(t: string, meta: FileMeta): Promise<Buffer> {
  const url = meta.mimeType === "application/vnd.google-apps.document"
    ? `https://www.googleapis.com/drive/v3/files/${meta.id}/export?mimeType=application/pdf`
    : `https://www.googleapis.com/drive/v3/files/${meta.id}?alt=media&supportsAllDrives=true`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${t}` } });
  if (!res.ok) throw new Error(`PDF fetch (${res.status}): ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

async function uploadPdf(t: string, folderId: string, name: string, bytes: Buffer): Promise<string> {
  const boundary = "bsllc-snapshot-boundary";
  const meta = JSON.stringify({ name, parents: [folderId] });
  const pre = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`;
  const post = `\r\n--${boundary}--`;
  const body = Buffer.concat([Buffer.from(pre, "utf8"), bytes, Buffer.from(post, "utf8")]);
  const up = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true", {
    method: "POST",
    headers: { Authorization: `Bearer ${t}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!up.ok) throw new Error(`Drive upload (${up.status}): ${await up.text()}`);
  const uploaded = (await up.json()) as { id: string };
  if (!uploaded.id) throw new Error("Drive upload returned no file id.");
  return uploaded.id;
}

async function shareAnyone(t: string, id: string): Promise<void> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${id}/permissions?supportsAllDrives=true`, {
    method: "POST",
    headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
    body: JSON.stringify({ role: "reader", type: "anyone" }),
  });
  if (!res.ok) throw new Error(`Drive permission (${res.status}): ${await res.text()}`);
}

/** YYYY-MM-DD from an ISO timestamp, else today (UTC). */
function ymd(iso?: string): string {
  const d = iso ? new Date(iso) : new Date();
  return (isNaN(d.getTime()) ? new Date() : d).toISOString().slice(0, 10);
}

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const commitment = arg("commitment");

  const folderId = process.env.SIGNED_PLANS_DRIVE_FOLDER_ID?.trim();
  const hasSa = !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (!folderId || !hasSa) {
    console.log("snapshot-plan — dormant: set SIGNED_PLANS_DRIVE_FOLDER_ID (and GOOGLE_SERVICE_ACCOUNT_JSON) to activate. Queued jobs left unsent.");
    return;
  }

  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    const params: string[] = [];
    let where = `n.sent_at IS NULL AND n.kind = 'plan_snapshot'`;
    if (commitment) { params.push(commitment); where += ` AND n.commitment_id = $1`; }
    const { rows } = await c.query<{ id: string; commitment_id: string | null; payload_json: string | null }>(
      `SELECT n.id, n.commitment_id, n.payload_json
         FROM notifications_outbox n
        WHERE ${where}
        ORDER BY n.created_at ASC`,
      params,
    );
    if (rows.length === 0) { console.log(`snapshot-plan — nothing queued${dryRun ? " (dry-run)" : ""}.`); return; }
    console.log(`snapshot-plan — ${rows.length} queued${dryRun ? " (dry-run)" : ""}`);

    const t = await token();
    let done = 0, skipped = 0, failed = 0;
    for (const r of rows) {
      const payload = r.payload_json ? (JSON.parse(r.payload_json) as { link?: string; title?: string }) : {};
      const link = payload.link || "";
      const title = (payload.title || "Plan").trim();
      try {
        const fileId = parseFileId(link);
        if (!fileId) {
          console.log(`  skip ${r.id}: could not parse a Drive file id from "${link}" — leaving unsent.`);
          skipped++;
          continue;
        }
        const meta = await fileMeta(t, fileId);
        const name = `${title} — signed version ${ymd(meta.modifiedTime)}.pdf`;
        if (dryRun) {
          console.log(`  would snapshot "${meta.name}" (${meta.mimeType}) → "${name}" for commitment ${r.commitment_id ?? "?"}`);
          done++;
          continue;
        }
        const bytes = await pdfBytes(t, meta);
        const newId = await uploadPdf(t, folderId, name, bytes);
        await shareAnyone(t, newId);
        const url = `https://drive.google.com/file/d/${newId}/view`;
        if (r.commitment_id) {
          await c.query(
            `UPDATE commitments
                SET plan_snapshot_url = $2,
                    plan_snapshot_at = now(),
                    plan_source_modified_at = $3
              WHERE id = $1`,
            [r.commitment_id, url, meta.modifiedTime ?? null],
          );
        }
        await c.query(`UPDATE notifications_outbox SET sent_at = now() WHERE id = $1`, [r.id]);
        console.log(`  ✓ ${r.id}: "${title}" → ${url}`);
        done++;
      } catch (e) {
        console.log(`  FAILED ${r.id}: ${e instanceof Error ? e.message : e} — leaving unsent, will retry next run`);
        failed++;
      }
    }
    console.log(`Done: ${done} ${dryRun ? "to snapshot" : "snapshotted"}, ${skipped} skipped, ${failed} failed.`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

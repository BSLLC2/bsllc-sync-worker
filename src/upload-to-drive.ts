#!/usr/bin/env tsx
import "dotenv/config";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { JWT } from "google-auth-library";

/**
 * Uploads a file (the encrypted nightly DB dump) to a Google Drive folder, and
 * prunes copies older than the retention window. Offsite, encrypted backup of
 * client data — belt & suspenders on top of Neon PITR + the GitHub artifact.
 *
 * Auth: the shared service account. Service accounts have no personal Drive
 * quota, so the target MUST be a **Shared Drive** the SA is a member of, OR set
 * BACKUP_DRIVE_IMPERSONATE to a Workspace user (needs the drive scope added to
 * domain-wide delegation) so the file is owned by that user.
 *
 * Env:
 *   GOOGLE_SERVICE_ACCOUNT_JSON   the SA key (same one used elsewhere)
 *   BACKUP_DRIVE_FOLDER_ID        target folder / shared-drive folder id
 *   BACKUP_DRIVE_IMPERSONATE      (optional) Workspace user to own the files
 *   BACKUP_RETENTION_DAYS         (optional, default 90) prune older copies
 *
 *   npm run upload-to-drive -- --file=path/to/backup.sql.gz.gpg
 */
const SCOPE = "https://www.googleapis.com/auth/drive";

function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }

async function token(): Promise<string> {
  const sa = JSON.parse(env("GOOGLE_SERVICE_ACCOUNT_JSON"));
  if (!sa.client_email || !sa.private_key) throw new Error("Service-account JSON missing client_email / private_key.");
  const subject = process.env.BACKUP_DRIVE_IMPERSONATE?.trim() || undefined;
  const jwt = new JWT({ email: sa.client_email, key: sa.private_key, scopes: [SCOPE], subject });
  const { token } = await jwt.getAccessToken();
  if (!token) throw new Error("Failed to mint a Drive token.");
  return token;
}

async function main() {
  const file = process.argv.slice(2).find((a) => a.startsWith("--file="))?.slice("--file=".length);
  if (!file) throw new Error("Pass --file=<path>.");
  const folderId = env("BACKUP_DRIVE_FOLDER_ID");
  const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS || "90");
  const t = await token();
  const name = basename(file);
  const bytes = readFileSync(file);
  console.log(`Uploading ${name} (${(statSync(file).size / 1024 / 1024).toFixed(1)} MB) to Drive folder ${folderId}…`);

  // Multipart upload: metadata part + binary media part.
  const boundary = "bsllc-backup-boundary";
  const meta = JSON.stringify({ name, parents: [folderId] });
  const pre = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`;
  const post = `\r\n--${boundary}--`;
  const body = Buffer.concat([Buffer.from(pre, "utf8"), bytes, Buffer.from(post, "utf8")]);
  const up = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true", {
    method: "POST",
    headers: { Authorization: `Bearer ${t}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!up.ok) throw new Error(`Drive upload failed (${up.status}): ${await up.text()}`);
  const uploaded = (await up.json()) as { id: string };
  console.log(`✅ Uploaded — file id ${uploaded.id}`);

  // Prune old backups in the same folder (name prefix bsllc-db-), keeping the
  // retention window. Best-effort; a failure here never fails the backup.
  try {
    const cutoff = Date.now() - retentionDays * 86_400_000;
    const q = encodeURIComponent(`'${folderId}' in parents and name contains 'bsllc-db-' and trashed = false`);
    const list = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,createdTime)&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true`,
      { headers: { Authorization: `Bearer ${t}` } },
    );
    if (list.ok) {
      const files = ((await list.json()) as { files?: { id: string; name: string; createdTime: string }[] }).files ?? [];
      let pruned = 0;
      for (const f of files) {
        if (Date.parse(f.createdTime) < cutoff) {
          const del = await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}?supportsAllDrives=true`, {
            method: "DELETE", headers: { Authorization: `Bearer ${t}` },
          });
          if (del.ok) pruned++;
        }
      }
      if (pruned) console.log(`Pruned ${pruned} backup(s) older than ${retentionDays} days.`);
    }
  } catch (e) {
    console.log(`Prune skipped: ${e instanceof Error ? e.message : e}`);
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

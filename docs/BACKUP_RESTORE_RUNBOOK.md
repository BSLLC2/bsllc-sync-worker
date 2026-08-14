# Backups & Restore Runbook

The BS LLC dashboard holds a lot of client PII. Data durability is layered:

1. **Neon point-in-time recovery (PITR)** — Neon's own continuous backup; restore
   the DB to any moment in the retention window from the Neon console.
2. **Nightly encrypted dump** (`.github/workflows/backup-db.yml`) — a full
   `pg_dump`, GPG-encrypted (AES-256) on the runner, kept as a **90-day GitHub
   artifact** and copied **offsite to Google Drive**.

Access to everything is SSO-gated (Google, @bsllc.biz).

## Setup (one-time)

Add these repo secrets to **bsllc-sync-worker** (Settings → Secrets → Actions):

| Secret | Purpose |
|---|---|
| `BACKUP_PASSPHRASE` | Symmetric key that encrypts every dump. **Store it in the team password manager** — without it the backups are unrecoverable. Until it's set, dumps are kept UNENCRYPTED and the run warns. |
| `BACKUP_DRIVE_FOLDER_ID` | Google Drive folder id for offsite copies. Omit to keep only the GitHub artifact. |
| `BACKUP_DRIVE_IMPERSONATE` | *(optional)* A Workspace user to own the Drive files. |

**Google Drive target — pick one:**
- **Shared Drive (recommended):** create a Shared Drive, add the service account
  (`client_email` from `GOOGLE_SERVICE_ACCOUNT_JSON`) as a **Content manager**,
  and use a folder id inside it. Files don't count against anyone's quota.
- **My Drive + impersonation:** share a folder with a Workspace user, set
  `BACKUP_DRIVE_IMPERSONATE` to that user, and add the scope
  `https://www.googleapis.com/auth/drive` to the service account's
  **domain-wide delegation** (Admin → Security → API controls).

Retention on Drive defaults to **90 days** (`BACKUP_RETENTION_DAYS` to change);
older `bsllc-db-*` copies are pruned automatically after each upload.

## Restore

1. **Get a dump.** From the GitHub Action run → Artifacts → `db-backup`, or from
   the Drive folder. File looks like `bsllc-db-YYYYMMDDTHHMMSSZ.sql.gz.gpg`.
2. **Decrypt + decompress:**
   ```
   gpg --batch --passphrase "$BACKUP_PASSPHRASE" -d bsllc-db-*.sql.gz.gpg | gunzip > restore.sql
   ```
3. **Restore into an ISOLATED target first** — never straight over prod. Create a
   **Neon branch** (console → Branches → New branch) and copy its connection string:
   ```
   psql "postgres://…neon-branch…" -f restore.sql
   ```
4. **Verify** row counts against expectations before promoting:
   ```
   psql "$BRANCH_URL" -c "SELECT
     (SELECT count(*) FROM clients)   AS clients,
     (SELECT count(*) FROM commitments) AS tasks,
     (SELECT count(*) FROM metric_snapshots) AS metrics;"
   ```
5. If it checks out and you're recovering prod, either point the app at the
   branch or restore prod from Neon PITR to the matching time.

## Restore drill (do this quarterly)

Run steps 1–4 against a throwaway Neon branch and confirm the row counts look
sane. A backup you've never restored is a hope, not a backup. Delete the branch
when done.

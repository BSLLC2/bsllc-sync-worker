#!/usr/bin/env tsx
import "dotenv/config";

/**
 * Read-only diagnostic: prints ONLY the shared service account's client_email
 * (never the private key) so it can be added as a user in Search Console,
 * GA4, Google Ads, or shared on a Google Sheet. The email is not sensitive —
 * it's meant to be shared with whoever needs to grant access.
 *
 *   npm run show-service-account-email
 */
function main() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw || !raw.trim()) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON.");
  const json = JSON.parse(raw);
  if (!json.client_email) throw new Error("Service-account JSON missing client_email.");
  console.log(`Service account client_email: ${json.client_email}`);
}

main();

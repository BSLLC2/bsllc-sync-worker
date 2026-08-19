#!/usr/bin/env tsx
import "dotenv/config";
import { credsFromEnv, aeoCheck } from "./dataforseo.js";

/** One-off diagnostic: fires a single AEO call and prints the FULL result,
 *  including the real error message import-aeo.ts's aggregate log swallows.
 *
 *   npm run probe-aeo -- --provider=chatgpt
 */
async function main() {
  const provider = (process.argv.find((a) => a.startsWith("--provider="))?.slice(11) || "chatgpt").trim();
  const creds = credsFromEnv();
  const result = await aeoCheck(creds, provider, "what is suboxone", "Ohio Community Health", "ohiorecoverycenters.com");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : e); process.exit(1); });

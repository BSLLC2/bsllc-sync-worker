# Ads optimization — report lives in the dashboard repo

The full agent report for the ads findings pipeline is
`docs/agent-reports/ads-optimization.md` in **BSLLC2/bsllc-account-health**,
branch `agent/ads-optimization`, alongside every other agent report.

What is in this repo:

| Path | What it is |
| --- | --- |
| `src/ads/rules.ts` | The deterministic detection rules. The only place a finding is decided. Versioned. |
| `src/ads/narrative.ts` | The one LLM seam. Language only, identity today. |
| `src/ads/store.ts` | Lifecycle over Postgres — the logic that makes a dismissal stick. |
| `src/ads/platform.ts` | The adapter interface: read, validate, apply, rollback, verify, capabilities. |
| `src/ads/google-ads-adapter.ts` | Implemented. Writes go through `applyChangeSet`. |
| `src/ads/meta-adapter.ts` | Implemented, dormant until `META_ACCESS_TOKEN`. |
| `src/ads/microsoft-adapter.ts` | Declared seam. Every verb throws. |
| `src/ads-findings-run.ts` | Weekly deep audit. Read-only against every platform. |
| `src/ads-apply-approved.ts` | The only job that writes to a live ad account, and only from a human's Approve. |
| `src/ads-verify-outcomes.ts` | The 14/28-day after-check. |
| `src/ads-vendor-briefs.ts` | What the API deliberately does not do. |
| `src/verify-ads-findings.ts` | Verification harness. No credentials, no network, nothing applied. |
| `docs/ADS_PLATFORM_CAPABILITIES.md` | Per platform: what the API can and cannot change, and which limits are our policy. |

Start with `docs/ADS_PLATFORM_CAPABILITIES.md` before promising a client
anything, and run `npm run verify-ads-findings` before changing a threshold.

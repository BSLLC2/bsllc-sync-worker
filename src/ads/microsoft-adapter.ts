/**
 * Microsoft Advertising — a DECLARED SEAM, not an implementation.
 *
 * This file exists so that "we don't cover Microsoft yet" is a fact the code
 * states, in the shape of the interface it would satisfy, rather than an
 * absence someone discovers three months from now. Every method fails loudly
 * with a pointer to the capability doc. Nothing here silently returns empty
 * and pretends to have looked.
 *
 * WHAT IT WOULD TAKE (researched, see docs/ADS_PLATFORM_CAPABILITIES.md):
 *  - A Microsoft Advertising developer token, plus a Microsoft Entra app and a
 *    refresh token for an account with access to the customer's ad account.
 *  - The Campaign Management and Reporting SOAP/REST services, v13. Budgets,
 *    keywords, negative keywords, audiences, targeting and status are all
 *    writable — the surface is closer to Google's than Meta's, so the Google
 *    adapter is the template to copy, not the Meta one.
 *  - Reporting is asynchronous: you submit a report request, poll for it, then
 *    download a file. `read()` here would be a submit/poll/download loop rather
 *    than the synchronous GAQL query the Google adapter does, which is the one
 *    real structural difference.
 *  - There is no validate_only equivalent. `validate()` would have to report
 *    serverValidated: false, exactly as the Meta adapter does.
 *
 * WHY IT IS NOT BUILT: no BS LLC client currently runs Microsoft Advertising
 * spend we manage. Building an untested write path against an account that does
 * not exist would be worse than this file.
 */

import { AdapterNotImplemented, type PlatformAdapter, type PlatformCapabilities, type AdapterContext, type ValidationResult, type ApplyResult, type VerifyMetrics } from "./platform.js";
import type { AuditInput } from "./rules.js";

export class MicrosoftAdsAdapter implements PlatformAdapter {
  readonly platform = "microsoft" as const;

  capabilities(): PlatformCapabilities {
    return {
      platform: "microsoft",
      label: "Microsoft Advertising",
      credentialed: false,
      // Written from the v13 docs so a vendor brief can be accurate about what
      // is possible even while we have no adapter. Nothing here is guarded.
      canChange: {
        budgets: true, bidStrategy: true, keywords: true, negativeKeywords: true,
        audiences: true, targeting: true, statusChanges: true,
        creativeEdit: false, creativeCreate: true, finalUrls: true, assetDetach: true,
      },
      guardedOps: [],
      notes: [
        "NOT IMPLEMENTED. This adapter is a declared seam — every verb throws.",
        "No BS LLC client currently runs Microsoft Advertising spend we manage, which is why it is unbuilt rather than half-built.",
        "Microsoft's Google Ads Import can copy a Google account wholesale (and can be told to scale budgets), which is usually the right first move before any per-finding automation.",
        "Reporting is asynchronous (submit, poll, download), unlike Google's synchronous GAQL — that is the one structural change a real implementation needs.",
      ],
    };
  }

  async read(_ctx: AdapterContext): Promise<AuditInput> { throw new AdapterNotImplemented("microsoft", "read"); }
  async validate(_op: string, _body: unknown): Promise<ValidationResult> { throw new AdapterNotImplemented("microsoft", "validate"); }
  async apply(_op: string, _body: unknown): Promise<ApplyResult> { throw new AdapterNotImplemented("microsoft", "apply"); }
  async rollback(_priorValues: unknown): Promise<ApplyResult> { throw new AdapterNotImplemented("microsoft", "rollback"); }
  async verify(_e: string, _i: string, _s: string, _en: string): Promise<VerifyMetrics> { throw new AdapterNotImplemented("microsoft", "verify"); }
}

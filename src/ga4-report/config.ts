/**
 * The report's per-client settings, read from the dashboard's app_settings row
 * `web_report_config:<clientId>` and sanitised. A person typed them in the app, but
 * this worker puts nothing it was handed into a request without checking it first.
 *
 * A missing, unparseable or hostile value means NO exclusions, NO groups and the
 * default form event. A bad single entry is dropped; it never fails the run.
 */
import { cleanMatch, groupKey } from "./groups.js";
import { CHANNEL_GROUPS, CONFIG_LIMITS, DEFAULT_FORM_EVENT, type ReportConfig, type ReportGroup } from "./types.js";

export const CONFIG_KEY_PREFIX = "web_report_config:";
export const configKey = (clientId: string) => `${CONFIG_KEY_PREFIX}${clientId}`;

const EVENT_NAME = /^[a-z][a-z0-9_]{0,39}$/;
/** Control characters in a typed name would end up in a stored string and in a log. */
const hasControl = (s: string) => /[\u0000-\u001f\u007f]/.test(s);

export function defaultConfig(): ReportConfig {
  return { excludeCountries: [], excludeChannels: [], groups: [], formEvent: DEFAULT_FORM_EVENT };
}

export function sanitiseConfig(raw: unknown): ReportConfig {
  const out = defaultConfig();
  let v: unknown = raw;
  if (typeof raw === "string") {
    try { v = JSON.parse(raw); } catch { return out; }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  const o = v as Record<string, unknown>;

  if (Array.isArray(o.excludeCountries)) {
    const seen = new Set<string>();
    for (const c of o.excludeCountries) {
      if (typeof c !== "string") continue;
      const t = c.trim();
      if (!t || t.length > CONFIG_LIMITS.countryChars || hasControl(t)) continue;
      const k = t.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.excludeCountries.push(t);
      if (out.excludeCountries.length >= CONFIG_LIMITS.countries) break;
    }
  }

  if (Array.isArray(o.excludeChannels)) {
    // Only a channel group name GA4 defines can reach a request, matched whatever its case, and written as GA4 spells it.
    for (const c of o.excludeChannels) {
      if (typeof c !== "string") continue;
      const hit = CHANNEL_GROUPS.find((g) => g.toLowerCase() === c.trim().toLowerCase());
      if (hit && !out.excludeChannels.includes(hit)) out.excludeChannels.push(hit);
      if (out.excludeChannels.length >= CONFIG_LIMITS.channels) break;
    }
  }

  if (Array.isArray(o.groups)) {
    const seen = new Set<string>();
    for (const g of o.groups) {
      if (!g || typeof g !== "object" || Array.isArray(g)) continue;
      const gg = g as Record<string, unknown>;
      if (typeof gg.name !== "string" || typeof gg.prefix !== "string") continue;
      const name = gg.name.trim().slice(0, CONFIG_LIMITS.nameChars);
      const prefix = gg.prefix.trim();
      if (!name || hasControl(name)) continue;
      if (!prefix.startsWith("/") || prefix.length > CONFIG_LIMITS.prefixChars || hasControl(prefix) || /\s/.test(prefix)) continue;
      // No mode, or one this build does not know, is the original behaviour. An address may repeat when the modes differ.
      const match = cleanMatch(gg.match);
      // A "one level deeper" group hangs off a directory: a bare "/" would be every top-level page, which is not a group of pages under anything.
      if (match === "child" && prefix === "/") continue;
      // A query or fragment is never part of a page's address in the report, so an exact or deeper-level address with one matches nothing.
      if (match !== "starts" && (prefix.includes("?") || prefix.includes("#"))) continue;
      const key = groupKey({ prefix, match });
      if (seen.has(key)) continue;
      seen.add(key);
      out.groups.push({ name, prefix, match } satisfies ReportGroup);
      if (out.groups.length >= CONFIG_LIMITS.groups) break;
    }
  }

  if (typeof o.formEvent === "string" && EVENT_NAME.test(o.formEvent)) out.formEvent = o.formEvent;
  return out;
}

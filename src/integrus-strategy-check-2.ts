#!/usr/bin/env tsx
import "dotenv/config";
import { credsFromEnv, type DfsCreds } from "./dataforseo.js";

/**
 * READ-ONLY follow-up to integrus-strategy-check: the site inventory came back
 * empty (robots/sitemap/llms all 200 with no body), and the brand SERP shows
 * Integrus at #2 for its own name. Diagnose both, and classify the intent
 * behind the largest "demand" the first run found.
 *
 *   npm run integrus-strategy-check-2
 */

const HOSTS = ["https://www.integruspartners.com", "https://integruspartners.com", "https://www.integrus-partners.com", "https://integrus-partners.com"];
const PATHS = ["/", "/robots.txt", "/sitemap.xml", "/pages-sitemap.xml", "/llms.txt", "/client-wins", "/clientwins", "/dental", "/veterinary", "/businessservices", "/healthcare"];
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const BRAND_SERPS = ["integrus partners", "integris partners", "integrus", "integrus partners dallas"];
const INTENT_SERPS = ["hvac company for sale", "surgery center for sale", "dental laboratory for sale", "veterinary practice broker", "dental practice broker near me", "medical practice broker", "private equity vet", "dental private equity"];

const hr = (t: string) => console.log(`\n${"=".repeat(96)}\n${t}\n${"=".repeat(96)}`);

async function dfsPost(creds: DfsCreds, path: string, body: unknown): Promise<any> {
  const res = await fetch(`https://api.dataforseo.com/v3${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: "Basic " + Buffer.from(`${creds.login}:${creds.password}`).toString("base64") }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`DataForSEO ${path} HTTP ${res.status}`);
  return res.json();
}
async function serpTop(creds: DfsCreds, keyword: string) {
  const resp = await dfsPost(creds, "/serp/google/organic/live/advanced", [{ keyword, location_name: "United States", language_name: "English", device: "desktop", depth: 10 }]);
  const rt = resp?.tasks?.[0]; if (!rt || rt.status_code !== 20000) throw new Error(rt?.status_message || "no task result");
  const items: any[] = rt.result?.[0]?.items ?? [];
  return { organic: items.filter((i) => i?.type === "organic").slice(0, 10).map((i) => ({ domain: String(i.domain ?? "").replace(/^www\./, ""), url: String(i.url ?? ""), title: String(i.title ?? "") })), paid: items.filter((i) => i?.type === "paid").map((i) => String(i.domain ?? "")), types: [...new Set(items.map((i) => String(i?.type)))] };
}
const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"');
const pick = (html: string, re: RegExp) => { const m = re.exec(html); return m ? decode(m[1]!.replace(/\s+/g, " ").trim()) : ""; };

async function main() {
  const creds = credsFromEnv();
  console.log(`\nINTEGRUS — FOLLOW-UP CHECK — READ ONLY — ${new Date().toISOString().slice(0, 10)}`);

  hr("A. WHAT EACH HOST ACTUALLY SERVES (both spellings of the domain)");
  for (const host of HOSTS) {
    for (const p of PATHS) {
      try {
        const res = await fetch(host + p, { redirect: "manual", headers: { "user-agent": UA, accept: "text/html,application/xml;q=0.9,*/*;q=0.8" } });
        const loc = res.headers.get("location") ?? "";
        const ct = res.headers.get("content-type") ?? "";
        const server = res.headers.get("server") ?? res.headers.get("x-wix-request-id") ? "wix" : (res.headers.get("cf-ray") ? "cloudflare" : "");
        const text = res.status >= 200 && res.status < 300 ? await res.text() : "";
        const title = pick(text, /<title[^>]*>([\s\S]*?)<\/title>/i);
        const h1 = pick(text, /<h1[^>]*>([\s\S]*?)<\/h1>/i).replace(/<[^>]+>/g, "");
        const locs = (text.match(/<loc>/g) ?? []).length;
        console.log(`  ${(host + p).padEnd(52)} ${res.status} ${loc ? "→ " + loc.slice(0, 60) : ""} ${ct.split(";")[0]} len=${text.length}${locs ? ` locs=${locs}` : ""}${title ? ` title="${title.slice(0, 60)}"` : ""}${h1 ? ` h1="${h1.slice(0, 50)}"` : ""}${server ? ` [${server}]` : ""}`);
        if (p === "/" && text.length && text.length < 4000) console.log(`      body: ${text.replace(/\s+/g, " ").slice(0, 300)}`);
        if ((p === "/sitemap.xml" || p === "/pages-sitemap.xml") && locs) for (const m of text.matchAll(/<loc>([^<]+)<\/loc>/g)) console.log(`      ${m[1]}`);
        if (p === "/robots.txt" && text) console.log(`      ${text.replace(/\s+/g, " ").slice(0, 300)}`);
      } catch (e) { console.log(`  ${(host + p).padEnd(52)} [fetch failed] ${e instanceof Error ? e.message.slice(0, 80) : e}`); }
    }
    console.log("");
  }

  hr("B. BRAND SERPs — who outranks Integrus for its own name, and the Integris collision");
  for (const term of BRAND_SERPS) {
    try {
      const s = await serpTop(creds, term);
      console.log(`\n  "${term}"  [${s.types.filter((t) => t !== "organic").join(",")}]${s.paid.length ? `  ADS: ${[...new Set(s.paid)].join(", ")}` : ""}`);
      s.organic.forEach((o, i) => console.log(`    ${String(i + 1).padStart(2)}. ${o.domain.padEnd(34)} ${o.title.slice(0, 64)}`));
    } catch (e) { console.log(`  "${term}" [UNAVAILABLE] ${e instanceof Error ? e.message : e}`); }
  }

  hr("C. INTENT CHECK — is the big 'for sale / broker' volume sellers or buyers?");
  for (const term of INTENT_SERPS) {
    try {
      const s = await serpTop(creds, term);
      console.log(`\n  "${term}"  [${s.types.filter((t) => t !== "organic").join(",")}]${s.paid.length ? `  ADS: ${[...new Set(s.paid)].join(", ")}` : "  no ads"}`);
      s.organic.forEach((o, i) => console.log(`    ${String(i + 1).padStart(2)}. ${o.domain.padEnd(34)} ${o.title.slice(0, 64)}`));
    } catch (e) { console.log(`  "${term}" [UNAVAILABLE] ${e instanceof Error ? e.message : e}`); }
  }

  console.log(`\nDONE — read only.\n`);
}
main().catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : e); process.exit(1); });

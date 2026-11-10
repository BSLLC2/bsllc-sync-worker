#!/usr/bin/env tsx
/**
 * Guard for the branded-search reading: `read-query-months` and the table it writes,
 * `seo_query_months`.
 *
 *   1. The brand test (src/query-months/brand.ts): whole words, spacing and accents set
 *      aside, run-together terms, short and everyday terms refused, a word that merely
 *      contains a term not matched.
 *   2. The arithmetic (src/query-months/months.ts): branded plus other equals the rows
 *      read, hidden is the site total less those rows and is never negative, a capped
 *      read says so and has no hidden figure, no usable term means no split.
 *   3. The privacy rule, read as text: no column, no INSERT parameter and no log line can
 *      hold a search, and the code that tags a row keeps nothing of its text.
 *   4. The real job, run as a child process against a pretend Search Console and a
 *      throwaway Postgres database: counts, hidden share, the cap, a month still in
 *      progress, a rerun, a dry run, a client that fails beside one that works, a retry.
 *      THIS SECTION RUNS ONLY WHEN ADS_VERIFY_DATABASE_URL IS SET (the `ads-store` CI job
 *      sets it; locally, `node scripts/test-db.mjs start` in the dashboard repo prints one).
 *   5. The contract with the rest of the system: read-only scope, the workflow, the registries.
 *
 * EVERY CLIENT, SEARCH, FIGURE AND PERSON BELOW IS INVENTED. WHAT THIS CANNOT PROVE: the
 * Search Analytics request shapes follow the published documentation and have not been
 * run against a live property.
 *
 *   npm run verify-query-months
 */
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";
import { startFake, type Call, type Reply } from "./signals/fake-http.js";
import {
  COMMON_WORDS, derivedTermList, fingerprintOf, fold, matchesBrand, MIN_TERM_LETTERS, parseTypedTerms, prepareTerms, stripLegalSuffix,
} from "./query-months/brand.js";
import {
  buildMonthRow, completeMonths, CREATE_QUERY_MONTHS, INSERT_QUERY_MONTH, newTally, parseTotal, QUERY_PAGE_SIZE, QUERY_ROW_CEILING,
  queryRequest, tallyQueryPage, totalRequest, type MonthSpan,
} from "./query-months/months.js";
import { describeFailure, retryable } from "./query-months/read.js";
import { HttpError } from "./page-behaviour/http.js";

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`  ${pass ? "✅" : "❌"} ${label}${!pass && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const hr = (t: string) => console.log(`\n${t}\n${"─".repeat(72)}`);
function selfTest(label: string, test: (text: string) => boolean, good: string, bad: string) {
  ok(`${label} (self-test: passes a good sample)`, test(good) === true);
  ok(`${label} (self-test: fails a planted bad sample)`, test(bad) === false);
}
const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.join(here, "..");
const src = (f: string) => fs.readFileSync(path.join(root, f), "utf8");
const code = (t: string) => t.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const sha16 = (list: string[]) => createHash("sha256").update(list.join("\n")).digest("hex").slice(0, 16);

/* ───────────────────────── 1. the brand test ───────────────────────── */

hr("1. A search is branded when the client's name is in it as whole words");
{
  const t = (...raw: string[]) => prepareTerms(raw).terms;
  const bell = t("Bell Wood");
  ok("the term matches as spaced words", matchesBrand("bell wood dentist", bell));
  ok("case is set aside", matchesBrand("BELL WOOD hours", bell));
  ok("punctuation is set aside", matchesBrand("bell-wood, near me", bell));
  ok("the term run together matches the search spaced out", matchesBrand("bell wood phone number", t("Bellwood")));
  ok("the term spaced out matches the search run together", matchesBrand("bellwood phone number", bell));
  ok("accents are folded", matchesBrand("bélle wöod".replace("bélle", "bell"), bell) && matchesBrand("Álpha Déntal", t("alpha dental")));
  ok("an apostrophe closes up (o'brien is obrien)", matchesBrand("obriens pub o'brien", t("O'Brien")) && matchesBrand("obrien pub", t("O'Brien")));
  ok("digits count as part of a word", matchesBrand("studio 54 tickets", t("Studio 54")) && !matchesBrand("studio 55 tickets", t("Studio 54")));
  ok("a term in the middle of the search matches", matchesBrand("is acme plumbing open today", t("acme plumbing")));
  ok("a word that merely CONTAINS the term does not match", !matchesBrand("bellwoodfarm hours", t("Bellwood")) && !matchesBrand("campbellwood", t("Bellwood")));
  ok("a term that is the start of another word does not match", !matchesBrand("acmes plumbing", t("acme plumbing")) && !matchesBrand("alphabet dental supply", t("alpha dental")));
  ok("a term inside a longer word does not match", !matchesBrand("tabellwood", bell));
  ok("only some of a multi-word term is not enough", !matchesBrand("bell hours", bell) && !matchesBrand("wood stove", bell));
  ok("an empty search and an empty list match nothing", !matchesBrand("", bell) && !matchesBrand("bell wood", []) && !matchesBrand(null, bell) && !matchesBrand(undefined, bell));
  ok("a non-string search does not throw", matchesBrand(12345 as unknown as string, t("12345")));

  const small = prepareTerms(["ab", "A", "  ", "x1"]);
  ok(`a term under ${MIN_TERM_LETTERS} letters or digits is refused and counted`, small.terms.length === 0 && small.refused === 3, small);
  ok("three letters is the smallest term kept", prepareTerms(["abc"]).terms.length === 1);
  const common = prepareTerms(["Hope", "STAR", "love", "hope clinic"]);
  ok("a single everyday short word is skipped and counted", common.skipped === 3 && common.terms.length === 1 && common.list[0] === "hope clinic", common);
  ok("the same word inside a longer name is kept", matchesBrand("hope clinic cincinnati", common.terms) && !matchesBrand("hope", common.terms));
  ok("a longer common-looking word is not skipped (the rule is for four letters or fewer)", prepareTerms(["Health"]).terms.length === 1);
  ok("every declared common word is short enough to matter", COMMON_WORDS.every((w) => w.length <= 4 && w === w.toLowerCase()));
  ok("a non-string term is ignored, not thrown on", prepareTerms([null, 5, {}, "acme plumbing"] as unknown[]).terms.length === 1);
  ok("duplicate terms count once", prepareTerms(["Acme Plumbing", "acme  plumbing", "ACME-PLUMBING"]).terms.length === 1);

  const a = prepareTerms(["Zeta", "Alpha"]), b = prepareTerms(["alpha", "ZETA", "zeta"]);
  ok("the fingerprint ignores order, case and repeats", a.fingerprint === b.fingerprint && a.fingerprint === sha16(["alpha", "zeta"]), [a.fingerprint, b.fingerprint]);
  ok("the fingerprint changes with the list", a.fingerprint !== prepareTerms(["alpha"]).fingerprint && fingerprintOf([]) === sha16([]));
  ok("fold gives the words and nothing else", JSON.stringify(fold("  Bell-Wood's,  CAFÉ #5 ")) === JSON.stringify(["bell", "woods", "cafe", "5"]), fold("  Bell-Wood's,  CAFÉ #5 "));

  ok("a company suffix is taken off a DERIVED name", stripLegalSuffix("Bellwood Farms LLC") === "bellwood farms" && stripLegalSuffix("Acme, Inc.") === "acme" && stripLegalSuffix("Co") === "co");
  ok("a name that is only a suffix word is left alone", derivedTermList(["llc"]).length === 1);
  ok("derived terms are de-duplicated", derivedTermList(["alpha dental", "alpha dental llc"]).length === 1);

  const good = JSON.stringify({ terms: ["a b c", 7, " "], by: "Sam", at: "2026-10-01T00:00:00Z" });
  ok("a typed list with a name and a date is read, strings only", JSON.stringify(parseTypedTerms(good)?.terms) === JSON.stringify(["a b c"]));
  ok("a typed list with no name is not a typed answer", parseTypedTerms(JSON.stringify({ terms: ["acme"], at: "2026-10-01T00:00:00Z" })) === null && parseTypedTerms(JSON.stringify({ terms: ["acme"], by: " ", at: "2026-10-01T00:00:00Z" })) === null);
  ok("a typed list with no usable date is not a typed answer", parseTypedTerms(JSON.stringify({ terms: ["acme"], by: "Sam", at: "yesterday-ish" })) === null && parseTypedTerms(JSON.stringify({ terms: ["acme"], by: "Sam" })) === null);
  ok("broken JSON, nothing and an empty list are not typed answers", parseTypedTerms("{") === null && parseTypedTerms(null) === null && parseTypedTerms("") === null && parseTypedTerms(JSON.stringify({ terms: [], by: "Sam", at: "2026-10-01T00:00:00Z" })) === null && parseTypedTerms("[]") === null);
}

/* ───────────────────────── 2. the arithmetic ───────────────────────── */

hr("2. Branded plus other is every row read; hidden is the rest of the site total");
const SPAN: MonthSpan = { month: "2026-09", start: "2026-09-01", end: "2026-09-30" };
{
  const terms = prepareTerms(["alpha dental"]);
  const tally = newTally();
  const rows = tallyQueryPage({ rows: [
    { keys: ["alpha dental"], clicks: 10, impressions: 100 },
    { keys: ["Alpha-Dental hours"], clicks: 5, impressions: 40 },
    { keys: ["dentist near me"], clicks: 3, impressions: 300 },
    { keys: [], clicks: 1, impressions: 1 },
  ] }, terms.terms, tally);
  ok("the page's row count is returned", rows === 4);
  ok("branded rows are summed apart from the others", tally.branded.clicks === 15 && tally.branded.impressions === 140 && tally.other.clicks === 4 && tally.other.impressions === 301, tally);
  ok("a row with no search key counts as other, not as nothing", tally.other.clicks === 4);
  ok("a page that is not a list adds nothing and does not throw", tallyQueryPage({}, terms.terms, newTally()) === 0 && tallyQueryPage(null, terms.terms, newTally()) === 0);

  const row = buildMonthRow({ span: SPAN, total: { clicks: 30, impressions: 500 }, tally, capped: false, termCount: 1, fingerprint: terms.fingerprint, source: "derived" });
  ok("hidden is the site total less the rows read", row.hiddenClicks === 11 && row.hiddenImpressions === 59, row);
  ok("branded and other come through whole", row.brandedClicks === 15 && row.otherClicks === 4 && row.brandedImpressions === 140 && row.otherImpressions === 301);
  ok("the month and what it covers are the span's", row.month === "2026-09" && row.coveredTo === "2026-09-30" && row.termsSource === "derived" && row.brandTerms === 1);
  ok("rows read is the count of rows, not clicks", row.rowsRead === 4 && row.rowsCapped === false);

  const over = buildMonthRow({ span: SPAN, total: { clicks: 10, impressions: 100 }, tally, capped: false, termCount: 1, fingerprint: "f", source: "derived" });
  ok("hidden is never negative (rows ran past the total)", over.hiddenClicks === 0 && over.hiddenImpressions === 0, over);

  const capped = buildMonthRow({ span: SPAN, total: { clicks: 30, impressions: 500 }, tally, capped: true, termCount: 1, fingerprint: "f", source: "derived" });
  ok("a capped read says so and has NO hidden figure (the unread tail cannot be told from Google's)", capped.rowsCapped === true && capped.hiddenClicks === null && capped.hiddenImpressions === null, capped);

  const none = buildMonthRow({ span: SPAN, total: { clicks: 30, impressions: 500 }, tally, capped: false, termCount: 0, fingerprint: "f", source: "typed" });
  ok("with no usable term nothing is called branded or other (null, never a nought)", none.brandedClicks === null && none.otherClicks === null && none.brandedImpressions === null && none.otherImpressions === null, none);
  ok("the site total and hidden are still kept with no term", none.totalClicks === 30 && none.hiddenClicks !== null);

  ok("the total is read from the one row Search Console returns", JSON.stringify(parseTotal({ rows: [{ clicks: 41.6, impressions: 90 }] })) === JSON.stringify({ clicks: 42, impressions: 90 }));
  ok("no total row is null, never a nought", parseTotal({}) === null && parseTotal({ rows: [] }) === null && parseTotal(null) === null);
}

hr("2b. The requests and the months");
{
  const q = queryRequest(SPAN, 25000) as Record<string, unknown>;
  ok("the per-search request asks for the query dimension, final data, a full page and the page offset", JSON.stringify(q.dimensions) === '["query"]' && q.dataState === "final" && q.rowLimit === QUERY_PAGE_SIZE && q.startRow === 25000 && q.startDate === "2026-09-01" && q.endDate === "2026-09-30");
  const tr = totalRequest(SPAN) as Record<string, unknown>;
  ok("the site total is asked with NO dimension (so anonymised searches are in it)", !("dimensions" in tr) && tr.dataState === "final");
  ok("the row ceiling is whole pages", QUERY_ROW_CEILING % QUERY_PAGE_SIZE === 0 && QUERY_ROW_CEILING >= QUERY_PAGE_SIZE);

  const m = completeMonths("2026-10-04", 3);
  ok("on the 4th the month that ended on the 30th is finished", m[0]?.month === "2026-09" && m.length === 3 && m[2]?.month === "2026-07", m);
  ok("on the 2nd it is not (its last day is under three days behind); on the 3rd it is", completeMonths("2026-10-02", 2)[0]?.month === "2026-08" && completeMonths("2026-10-03", 2)[0]?.month === "2026-09");
  ok("a month is never the month in progress", completeMonths("2026-10-31", 5).every((s) => s.month < "2026-10"));
  ok("at most sixteen months, whatever is asked", completeMonths("2026-10-20", 99).length === 16);
  ok("a month spans its first to its last day", m[0]?.start === "2026-09-01" && m[0]?.end === "2026-09-30" && completeMonths("2026-03-20", 1)[0]?.end === "2026-02-28");
}

hr("2c. What a failure is called");
{
  ok("429 and 5xx are retried, everything else is an answer", retryable(429) && retryable(500) && retryable(503) && !retryable(403) && !retryable(404) && !retryable(400));
  const secret = new HttpError(403, '{"error":"query: jane doe alpha dental"}', "Search Console");
  ok("a failure names a status and never carries the response body", !/jane doe/.test(describeFailure(secret)) && /403/.test(describeFailure(secret)), describeFailure(secret));
  ok("a plain error is cut short", describeFailure(new Error("x".repeat(500))).length <= 200);
}

/* ───────────────────────── 3. the privacy rule, as text ───────────────────────── */

hr("3. Nothing here can hold a search");
const FILES = ["src/query-months/brand.ts", "src/query-months/months.ts", "src/query-months/read.ts", "src/read-query-months.ts"];
const body = Object.fromEntries(FILES.map((f) => [f, code(src(f))])) as Record<string, string>;
const DDL_COLS = CREATE_QUERY_MONTHS.split("\n").slice(1, -1).map((l) => l.trim().split(/\s+/)[0]!).filter(Boolean);
{
  const BRIEF = ["id", "client_id", "month", "covered_to", "branded_clicks", "branded_impressions", "other_clicks", "other_impressions", "total_clicks", "total_impressions", "hidden_clicks", "hidden_impressions", "rows_read", "rows_capped", "brand_terms", "terms_fingerprint", "terms_source", "synced_at"];
  ok("the table has exactly the columns the dashboard declares", JSON.stringify(DDL_COLS) === JSON.stringify(BRIEF), DDL_COLS);
  ok("the client is a real client and a month is one row per client", /client_id TEXT NOT NULL REFERENCES clients\(id\)/.test(CREATE_QUERY_MONTHS) && /UNIQUE INDEX[^;]*\(client_id, month\)/.test(src("src/query-months/months.ts")));

  const noText = (cols: string[]) => !cols.some((c) => /query|queries|text|keyword|phrase|term_text|search_term|name/i.test(c.replace(/^brand_terms$|^terms_fingerprint$|^terms_source$/, "")));
  ok("no column is named for a search, a phrase or text", noText(DDL_COLS), DDL_COLS);
  ok("the column check would catch a column for a search (self-test)", noText([...DDL_COLS, "query_text"]) === false && noText([...DDL_COLS, "top_keyword"]) === false);
  ok("every column is a number, a flag, a date, an id or a fixed word", DDL_COLS.every((c) => new RegExp(`^\\s*${c} (TEXT|INTEGER|BOOLEAN|TIMESTAMPTZ)\\b`, "m").test(CREATE_QUERY_MONTHS)));
  ok("the only TEXT columns are ids, months, dates, a 16-character fingerprint and a two-word source", ["id", "client_id", "month", "covered_to", "terms_fingerprint", "terms_source"].every((c) => new RegExp(`^\\s*${c} TEXT`, "m").test(CREATE_QUERY_MONTHS)) && (CREATE_QUERY_MONTHS.match(/ TEXT/g) ?? []).length === 6);

  const insCols = /\(\s*id,([^)]*)\)\s*VALUES/.exec(INSERT_QUERY_MONTH)?.[0].replace(/VALUES|[()]/g, "").split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  ok("the INSERT names exactly the table's columns", JSON.stringify(insCols) === JSON.stringify(DDL_COLS), insCols);
  ok("the INSERT has one placeholder a column", (INSERT_QUERY_MONTH.match(/\$\d+/g) ?? []).filter((_, i, a) => a.indexOf(_) === i).length === DDL_COLS.length);
  ok("the write replaces the month as a whole", /ON CONFLICT \(client_id, month\) DO UPDATE SET/.test(INSERT_QUERY_MONTH) && DDL_COLS.filter((c) => !["id", "client_id", "month"].includes(c)).every((c) => new RegExp(`${c} = EXCLUDED\\.${c}`).test(INSERT_QUERY_MONTH)));

  // The code that tags a row reads the text once, to ask a question, and keeps nothing of it.
  const keyUses = (t: string) => (t.replace(/keys\?: unknown\[\]/g, "").match(/\bkeys\b/g) ?? []).length;
  const keysUses = keyUses(body["src/query-months/months.ts"]!);
  const tagOnly = (t: string) => keyUses(t) === 1 && /matchesBrand\(r\.keys\?\.\[0\], terms\)/.test(t);
  selfTest("a search key is read in one place and only to be tested", tagOnly, "matchesBrand(r.keys?.[0], terms)", "const k = r.keys?.[0]; matchesBrand(r.keys?.[0], terms)");
  ok("a search key is read in one place and only to be tested", tagOnly(body["src/query-months/months.ts"]!), keysUses);
  ok("no search is put in a map, a set, a list or a return", !/(\.set\(|\.add\(|\.push\()\s*[^)]*\bkeys\b/.test(body["src/query-months/months.ts"]!) && !/\bkeys\b/.test(body["src/query-months/read.ts"]! + body["src/read-query-months.ts"]!));
  ok("brand.ts returns yes or no and a count, never the search", /export function matchesBrand\(query: unknown, terms: readonly PreparedTerm\[\]\): boolean/.test(body["src/query-months/brand.ts"]!));

  const logLines = (t: string) => t.split("\n").filter((l) => /console\.(log|error|warn|info|debug)|appendFileSync|process\.stdout|process\.stderr/.test(l));
  const quiet = (lines: string[]) => lines.every((l) => !/\bkeys\b|\bquery\b|\bqueries\b|\brows\[|\bq\.|\.keys\b|\bsearchText\b/.test(l));
  selfTest("no log line mentions a search by name", (t) => quiet(logLines(t)), 'console.log(`${client}: ${n} clicks`)', "console.log(`${r.keys[0]}`)");
  ok("no log line mentions a search by name", FILES.every((f) => quiet(logLines(body[f]!))), FILES.flatMap((f) => logLines(body[f]!)).filter((l) => !quiet([l])));
  ok("the log prints counts: clicks, branded, other, hidden, searches read", /branded \$\{r\.brandedClicks\}, other \$\{r\.otherClicks\}/.test(body["src/read-query-months.ts"]!) && /searches read/.test(body["src/read-query-months.ts"]!));
  ok("nothing prints a response body or a request body", !/\.body\b|JSON\.stringify\(body/.test(body["src/read-query-months.ts"]!) && !/console\./.test(body["src/query-months/read.ts"]! + body["src/query-months/months.ts"]! + body["src/query-months/brand.ts"]!));
  ok("nothing here writes the search to disk or the network beyond Search Console", !/writeFileSync|createWriteStream|appendFileSync\((?!process\.env\.GITHUB_OUTPUT)/.test(body["src/read-query-months.ts"]! + body["src/query-months/months.ts"]! + body["src/query-months/read.ts"]!));
}

/* ───────────────────────── 5a. the contract with the rest of the system (static half) ───────────────────────── */

hr("5. Read-only, the workflow, the registries");
{
  const job = body["src/read-query-months.ts"]!;
  const read = body["src/query-months/read.ts"]!;
  ok("the only scope asked for is read-only Search Console", /const SCOPE = "https:\/\/www\.googleapis\.com\/auth\/webmasters\.readonly"/.test(job) && !/auth\/webmasters"/.test(job) && !/auth\/(analytics|adwords|content|drive|spreadsheets)/.test(job));
  ok("the only request is Search Analytics query, by POST", /searchAnalytics\/query/.test(read) && (read.match(/method: "(\w+)"/g) ?? []).every((m) => m === 'method: "POST"') && !/"(PUT|DELETE|PATCH)"/.test(read));
  ok("it goes through the one door the seam uses (a pretend server stands in under test)", /serviceUrl\("gsc"/.test(read) && /googleToken\(SCOPE/.test(job));
  ok("a dry run neither creates the table nor writes", /if \(!dryRun\) await ensureQueryMonthsTable/.test(job) && /if \(rows\.length && !dryRun\)/.test(job));
  ok("one transaction a client, only after every month was read", /writeClientMonths\(c, client\.id, rows/.test(job) && /BEGIN/.test(body["src/query-months/months.ts"]!) && /ROLLBACK/.test(body["src/query-months/months.ts"]!));
  ok("a month that fails is named and the rest go on", /could not be read/.test(job) && !/throw e;\s*\n\s*\}\s*\n\s*await sleep/.test(job));
  ok("an access refusal stops asking for that property", /isAccessFailure\(e\)\) \{ notes\.push\("stopped for this property"\); break;/.test(job));
  ok("a typed list is preferred and its source is recorded", /terms\.source = "typed"|source: "typed"/.test(job) || /source: "typed"/.test(job));

  const wf = src(".github/workflows/read-query-months.yml");
  ok("it is scheduled weekly, after the page-months job (08:30 UTC Mondays)", /cron: "0 9 \* \* 1"/.test(wf));
  ok("a dispatch takes a client and a dry run, and the dry run defaults to true", /client_id:/.test(wf) && /dry_run:[\s\S]{0,260}default: "true"/.test(wf));
  ok("a scheduled run is live (dry only when the input says true)", /\[ "\$DRY_RUN" = "true" \]/.test(wf));
  ok("inputs reach the command through the environment, never into the shell line", /CLIENT_ID: \$\{\{ inputs\.client_id \}\}/.test(wf) && !/run:[^\n]*\$\{\{ inputs\./.test(wf));
  ok("the heartbeat is recorded even when the job fails", /Heartbeat\s*\n\s*if: always\(\)/.test(wf));
  ok("a dry run and a one-client run do NOT stamp the book-wide heartbeat", /if: always\(\) && inputs\.dry_run != 'true' && inputs\.client_id == ''/.test(wf));
  ok("the heartbeat is named read_query_months", /--job=read_query_months/.test(wf));
  ok("the note reaches the heartbeat through the environment", /NOTE: \$\{\{ steps\.run\.outputs\.summary \}\}/.test(wf) && /--note="\$NOTE"/.test(wf));
  ok("the run cannot overlap itself", /concurrency:[\s\S]{0,120}cancel-in-progress: false/.test(wf));
  ok("no workflow points a job at a pretend server", !fs.readdirSync(path.join(root, ".github/workflows")).some((f) => /SIGNALS_FAKE_BASE|GOOGLE_FAKE_BASE/.test(fs.readFileSync(path.join(root, ".github/workflows", f), "utf8")) && f !== "ci.yml"));
  ok("the job needs only the secrets the other Google jobs already use", /DATABASE_URL: \$\{\{ secrets\.DATABASE_URL \}\}/.test(wf) && /GOOGLE_SERVICE_ACCOUNT_JSON: \$\{\{ secrets\.GOOGLE_SERVICE_ACCOUNT_JSON \}\}/.test(wf) && (wf.match(/secrets\.[A-Z_]+/g) ?? []).every((s) => ["secrets.DATABASE_URL", "secrets.GOOGLE_SERVICE_ACCOUNT_JSON"].includes(s)));

  const pkg = JSON.parse(src("package.json")).scripts as Record<string, string>;
  ok("package.json registers the job and the guard", pkg["read-query-months"] === "tsx src/read-query-months.ts" && pkg["verify-query-months"] === "tsx src/verify-query-months.ts");
  const ci = src(".github/workflows/ci.yml");
  ok("CI runs the guard (twice: the pure half in the main job, the real-SQL half in ads-store)", (ci.match(/npm run verify-query-months/g) ?? []).length === 2);
  ok("the docs say what is stored and what never is", fs.existsSync(path.join(root, "docs/QUERY-MONTHS.md")) && /never stored/i.test(src("docs/QUERY-MONTHS.md")));
}

/* ───────────────────────── 4. the real job, as a child process ───────────────────────── */


interface Run { code: number | null; out: string }
const TSX = path.join(root, "node_modules/.bin/tsx");
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const KEY_JSON = JSON.stringify({ client_email: "sync@example-project.iam.gserviceaccount.com", private_key: privateKey });

// Invented searches. The privacy marker is a person's name inside a branded search.
const ALPHA_ROWS: Array<[string, number, number]> = [
  ["alpha dental", 100, 1000], ["Alpha-Dental near me", 50, 500], ["alphadental reviews", 20, 200], ["alpha smiles cincinnati", 15, 150],
  ["jane doe alpha dental", 5, 50], ["álpha déntal", 2, 20],
  ["dentist near me", 30, 900], ["teeth whitening", 10, 400], ["alphabet dental supply", 4, 40], ["alphadentalfarm", 3, 30],
];
// A search that is also a client's NAME ("alpha dental") is left out of the leak scan: client names are logged.
const ALL_TEXTS = [...ALPHA_ROWS.map((r) => r[0]), "zeta zoo tickets", "zoo tickets", "zetasomething", "delta diner menu", "eta eats coupons", "theta tickets"].filter((t) => t !== "alpha dental");

async function realJob(admin: string) {
  hr("4. The real job against a pretend Search Console and a throwaway database");
  const dbName = `qm_${Math.random().toString(36).slice(2, 10)}`;
  const a = new pg.Client({ connectionString: admin });
  await a.connect();
  await a.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(admin); url.pathname = `/${dbName}`;
  const c = new pg.Client({ connectionString: url.toString() });
  await c.connect();
  let fake: Awaited<ReturnType<typeof startFake>> | null = null;
  try {
    await c.query(`CREATE TABLE clients (id text PRIMARY KEY, name text NOT NULL, aliases text, seo_domain text, status text NOT NULL DEFAULT 'active', is_internal boolean NOT NULL DEFAULT false)`);
    await c.query(`CREATE TABLE connector_mappings (client_id text, source text, external_id text, enabled boolean NOT NULL DEFAULT true)`);
    await c.query(`CREATE TABLE app_settings (key text PRIMARY KEY, value text NOT NULL)`);
    const addClient = async (id: string, name: string, prop: string | null, o: { aliases?: string; domain?: string; status?: string; internal?: boolean; typed?: string } = {}) => {
      await c.query(`INSERT INTO clients (id, name, aliases, seo_domain, status, is_internal) VALUES ($1,$2,$3,$4,$5,$6)`, [id, name, o.aliases ?? null, o.domain ?? null, o.status ?? "active", o.internal ?? false]);
      if (prop) await c.query(`INSERT INTO connector_mappings (client_id, source, external_id) VALUES ($1,'gsc',$2)`, [id, prop]);
      if (o.typed) await c.query(`INSERT INTO app_settings (key, value) VALUES ($1,$2)`, [`brand_terms:${id}`, o.typed]);
    };
    await addClient("c-alpha", "Alpha Dental", "sc-domain:alpha.example", { aliases: "Alpha Smiles", domain: "alphadental.example" });
    await addClient("c-delta", "Delta Diner LLC", "sc-domain:delta.example");
    await addClient("c-epsilon", "Epsilon Eats", "sc-domain:eps.example");
    await addClient("c-zeta", "Zeta Zoo", "sc-domain:zeta.example", { typed: JSON.stringify({ terms: ["zeta", "zz", "hope", "Zeta Zoo!"], by: "Sam Example", at: "2026-10-01T00:00:00Z" }) });
    await addClient("c-eta", "Eta Eats", "sc-domain:eta.example", { typed: JSON.stringify({ terms: ["ab", "hope"], by: "Sam Example", at: "2026-10-01T00:00:00Z" }) });
    await addClient("c-theta", "Theta Tea", "sc-domain:theta.example");
    await addClient("c-nosite", "No Search Console", null);
    await addClient("c-churned", "Churned Co", "sc-domain:churned.example", { status: "churned" });
    await addClient("c-internal", "Our Own Account", "sc-domain:own.example", { internal: true });

    // ── the pretend Search Console ──
    let bump = 0;                       // changes alpha's newest month between runs (a restatement)
    let oldestStart = "";               // alpha's oldest requested month answers with nothing
    const seen = new Map<string, number>();
    const state = { forbidden: new Set<string>() };
    const handler = (call: Call): Reply | undefined => {
      const m = /\/gsc\/webmasters\/v3\/sites\/([^/]+)\/searchAnalytics\/query/.exec(call.path);
      if (!m) return undefined;
      const prop = decodeURIComponent(m[1]!);
      const req = JSON.parse(call.body) as { startDate: string; endDate: string; dimensions?: string[]; startRow?: number };
      const dim = !!req.dimensions?.length;
      const key = `${prop}|${dim ? "q" : "t"}|${req.startDate}|${req.startRow ?? 0}`;
      const nth = (seen.get(key) ?? 0) + 1; seen.set(key, nth);
      if (call.headers.authorization !== "Bearer fake-token") return { status: 401, body: "no token" };
      if (state.forbidden.has(prop)) return { status: 403, body: { error: { message: "User does not have sufficient permission for site: jane doe alpha dental" } } };
      const newest = req.startDate === completeMonths(new Date().toISOString().slice(0, 10), 3)[0]!.start;
      const rowsOf = (list: Array<[string, number, number]>) => ({ rows: list.map(([k, c, i]) => ({ keys: [k], clicks: c, impressions: i, ctr: 0.1, position: 5 })) });
      const sum = (list: Array<[string, number, number]>) => ({ clicks: list.reduce((s, r) => s + r[1], 0), imps: list.reduce((s, r) => s + r[2], 0) });
      if (prop === "sc-domain:alpha.example") {
        if (req.startDate === oldestStart) return { body: {} };
        const list = ALPHA_ROWS.map(([k, cl, im]) => [k, newest ? cl + bump : cl, im] as [string, number, number]);
        const s = sum(list);
        return { body: dim ? ((req.startRow ?? 0) === 0 ? rowsOf(list) : {}) : { rows: [{ clicks: s.clicks + 40, impressions: s.imps + 600 }] } };
      }
      if (prop === "sc-domain:delta.example") {
        if (!dim && nth <= 2) return { status: 429, body: "slow down" };
        if (dim && nth === 1) return { status: 503, body: "try later" };
        const list: Array<[string, number, number]> = [["delta diner menu", 7, 70], ["delta diner", 3, 30], ["pizza near me", 20, 400]];
        const s = sum(list);
        return { body: dim ? rowsOf(list) : { rows: [{ clicks: s.clicks, impressions: s.imps }] } };
      }
      if (prop === "sc-domain:zeta.example") {
        const list: Array<[string, number, number]> = [["zeta zoo tickets", 40, 400], ["zoo tickets", 25, 900], ["zetasomething", 5, 50]];
        const s = sum(list);
        return { body: dim ? rowsOf(list) : { rows: [{ clicks: s.clicks + 3, impressions: s.imps + 30 }] } };
      }
      if (prop === "sc-domain:eta.example") {
        const list: Array<[string, number, number]> = [["eta eats coupons", 9, 90], ["lunch", 1, 10]];
        const s = sum(list);
        return { body: dim ? rowsOf(list) : { rows: [{ clicks: s.clicks, impressions: s.imps }] } };
      }
      if (prop === "sc-domain:theta.example") {         // searches listed, but no site total: a reading that cannot be completed
        return { body: dim ? rowsOf([["theta tickets", 5, 50]]) : {} };
      }
      if (prop === "sc-domain:beta.example") {          // three full pages: capped
        const page = req.startRow ?? 0;
        if (!dim) return { body: { rows: [{ clicks: 80_000, impressions: 160_000 }] } };
        return { body: { rows: Array.from({ length: QUERY_PAGE_SIZE }, (_, i) => ({ keys: [`zzq-${page + i}`], clicks: 1, impressions: 2 })) } };
      }
      if (prop === "sc-domain:gamma.example") {         // exactly one full page, then nothing: NOT capped
        if (!dim) return { body: { rows: [{ clicks: 30_000, impressions: 60_000 }] } };
        return { body: (req.startRow ?? 0) === 0 ? { rows: Array.from({ length: QUERY_PAGE_SIZE }, (_, i) => ({ keys: [`zzq-g${i}`], clicks: 1, impressions: 2 })) } : {} };
      }
      return { status: 404, body: "no such property" };
    };
    fake = await startFake(handler);
    state.forbidden.add("sc-domain:eps.example");

    const today = new Date().toISOString().slice(0, 10);
    const spans = completeMonths(today, 3);
    oldestStart = spans[2]!.start;
    const run = (args: string[]): Promise<Run> => new Promise((resolve) => {
      const env: NodeJS.ProcessEnv = {
        ...process.env, DATABASE_URL: url.toString(), SIGNALS_FAKE_BASE: fake!.base, GOOGLE_SERVICE_ACCOUNT_JSON: KEY_JSON,
        QUERY_MONTHS_BACKOFF_MS: "5", QUERY_MONTHS_PAUSE_MS: "0", GITHUB_OUTPUT: "",
      };
      delete env.GITHUB_OUTPUT;
      const p = spawn(TSX, [path.join(here, "read-query-months.ts"), ...args], { env, cwd: root });
      let out = "";
      p.stdout.on("data", (d) => { out += d; });
      p.stderr.on("data", (d) => { out += d; });
      p.on("close", (code) => resolve({ code, out }));
    });
    const outputs: string[] = [];
    const tableExists = async () => (await c.query(`SELECT to_regclass('public.seo_query_months') AS t`)).rows[0]!.t !== null;
    const rowsFor = async (id: string) => (await c.query(`SELECT * FROM seo_query_months WHERE client_id = $1 ORDER BY month DESC`, [id])).rows as Record<string, any>[];

    // 4a. a dry run
    const dry = await run(["--months=3", "--dry-run"]); outputs.push(dry.out);
    ok("a dry run succeeds", dry.code === 0, dry.out.slice(-400));
    ok("a dry run creates no table and writes nothing", !(await tableExists()));
    ok("a dry run reads and prints counts", /\(dry run\) Alpha Dental/.test(dry.out) && /branded 1(9|0)\d/.test(dry.out) && /nothing written/.test(dry.out), dry.out.slice(0, 600));
    ok("a dry run still reads the month (the pretend server was asked)", fake.calls.some((x) => /alpha\.example/.test(decodeURIComponent(x.path))));

    // 4b. the live run
    fake.calls.length = 0;
    const live = await run(["--months=3"]); outputs.push(live.out);
    ok("the live run ends well although one account is refused", live.code === 0, live.out.slice(-500));
    const alpha = await rowsFor("c-alpha");
    ok("a month Search Console had nothing for is not written (two of the three months)", alpha.length === 2 && alpha.every((r) => r.month !== spans[2]!.month), alpha.map((r) => r.month));
    const a1 = alpha[0]!;
    ok("branded clicks and impressions are the branded searches' sums (whole words, accents, run-together, alias)", a1.branded_clicks === 192 && a1.branded_impressions === 1920, a1);
    ok("other is every other search, including words that only contain the term", a1.other_clicks === 47 && a1.other_impressions === 1370, a1);
    ok("the site total is the no-dimension answer", a1.total_clicks === 279 && a1.total_impressions === 3890, a1);
    ok("hidden is the total less the searches Google listed", a1.hidden_clicks === 40 && a1.hidden_impressions === 600, a1);
    ok("branded plus other plus hidden is the total", a1.branded_clicks + a1.other_clicks + a1.hidden_clicks === a1.total_clicks);
    ok("rows read and the cap flag", a1.rows_read === 10 && a1.rows_capped === false);
    ok("the month and what it covers", a1.month === spans[0]!.month && a1.covered_to === spans[0]!.end);
    ok("the terms are DERIVED from the name, alias and domain, with the fingerprint of the sorted list", a1.terms_source === "derived" && a1.brand_terms === 3 && a1.terms_fingerprint === sha16(["alpha dental", "alpha smiles", "alphadental"]), a1);
    const delta = await rowsFor("c-delta");
    ok("a 429 and a 503 are retried and the month is read", delta.length === 3 && delta[0]!.branded_clicks === 10 && delta[0]!.other_clicks === 20 && delta[0]!.hidden_clicks === 0, delta[0]);
    ok("the retries happened (the pretend server said no first)", (seen.get(`sc-domain:delta.example|t|${spans[0]!.start}|0`) ?? 0) >= 3 && (seen.get(`sc-domain:delta.example|q|${spans[0]!.start}|0`) ?? 0) >= 2);
    ok("a derived name has its company suffix taken off (Delta Diner LLC is matched as delta diner)", delta[0]!.terms_source === "derived" && delta[0]!.terms_fingerprint === sha16(["delta diner"]) && delta[0]!.brand_terms === 1, delta[0]);
    ok("a refused property writes nothing and is named", (await rowsFor("c-epsilon")).length === 0 && /Epsilon Eats[^\n]*could not be read \(Search Console refused the service account \(403\)/.test(live.out) && /stopped for this property/.test(live.out), live.out.slice(0, 900));
    ok("searches with no site total are a failed month, named, and nothing is written for it", (await rowsFor("c-theta")).length === 0 && /Theta Tea[^\n]*could not be read \(Search Console gave searches for the month but no site total\)/.test(live.out), live.out.slice(0, 1200));
    ok("a refused property is asked once, not once a month", fake.calls.filter((x) => /eps\.example/.test(decodeURIComponent(x.path))).length === 1);
    ok("one account failing did not stop the others", delta.length === 3 && alpha.length === 2 && (await rowsFor("c-zeta")).length === 3);
    const zeta = (await rowsFor("c-zeta"))[0]!;
    ok("a TYPED list is used, with its short and everyday terms refused, and the source says so", zeta.terms_source === "typed" && zeta.brand_terms === 2 && zeta.terms_fingerprint === sha16(["zeta", "zeta zoo"]) && /typed terms: 2 used, 1 refused as too short, 1 skipped as everyday word/.test(live.out), [zeta, live.out.slice(0, 800)]);
    ok("typed terms tag the searches", zeta.branded_clicks === 40 && zeta.other_clicks === 30 && zeta.hidden_clicks === 3, zeta);
    const eta = (await rowsFor("c-eta"))[0]!;
    ok("with no usable term the split is NULL, never a nought, and the total is still kept", eta.brand_terms === 0 && eta.branded_clicks === null && eta.other_clicks === null && eta.branded_impressions === null && eta.total_clicks === 10, eta);
    ok("an account with no Search Console, a churned one and our own are not read", !fake.calls.some((x) => /churned|own\.example/.test(decodeURIComponent(x.path))) && (await rowsFor("c-nosite")).length === 0 && (await rowsFor("c-churned")).length === 0 && (await rowsFor("c-internal")).length === 0);

    // 4c. the month in progress
    const monthStart = `${today.slice(0, 7)}-01`;
    const reqs = fake.calls.filter((x) => /searchAnalytics/.test(x.path)).map((x) => JSON.parse(x.body) as { startDate: string; endDate: string });
    ok("no request reaches into the month in progress", reqs.length > 0 && reqs.every((r) => r.endDate < monthStart), reqs.filter((r) => r.endDate >= monthStart));
    const allRows = (await c.query(`SELECT month, covered_to FROM seo_query_months`)).rows as { month: string; covered_to: string }[];
    const limit = new Date(Date.parse(`${today}T00:00:00Z`) - 3 * 86400_000).toISOString().slice(0, 10);
    ok("every stored month is finished: its last day is at least three days behind today", allRows.length > 0 && allRows.every((r) => r.covered_to <= limit && r.month < today.slice(0, 7)), allRows);

    // 4d. a rerun is idempotent, a restatement replaces
    const before = (await c.query(`SELECT count(*)::int AS n FROM seo_query_months`)).rows[0]!.n as number;
    const ids = (await c.query(`SELECT id FROM seo_query_months ORDER BY id`)).rows.map((r) => r.id).join(",");
    const rerun = await run(["--months=3"]); outputs.push(rerun.out);
    const after = (await c.query(`SELECT count(*)::int AS n FROM seo_query_months`)).rows[0]!.n as number;
    ok("a rerun adds no row and keeps every id", rerun.code === 0 && before === after && ids === (await c.query(`SELECT id FROM seo_query_months ORDER BY id`)).rows.map((r) => r.id).join(","), [before, after, rerun.out.slice(-300)]);
    const same = (await rowsFor("c-alpha"))[0]!;
    ok("a rerun leaves the figures as they were", same.branded_clicks === 192 && same.total_clicks === 279);
    bump = 1000;
    const restated = await run(["--months=3"]); outputs.push(restated.out);
    const rs = (await rowsFor("c-alpha")); const newest = rs[0]!;
    ok("a month Search Console restated is REPLACED as a whole, not added to", restated.code === 0 && rs.length === 2 && newest.total_clicks === 279 + 10 * 1000 && newest.branded_clicks === 192 + 6 * 1000, newest);
    ok("the other month was untouched", rs[1]!.branded_clicks === 192 && rs[1]!.total_clicks === 279);
    bump = 0;

    // 4e. one client only
    fake.calls.length = 0;
    const one = await run(["--client=alpha-dental", "--months=1"]); outputs.push(one.out);
    ok("a one-client run asks about that client only and says one account", one.code === 0 && fake.calls.every((x) => /alpha\.example/.test(decodeURIComponent(x.path)) || /\/token$/.test(x.path)) && /1 account:/.test(one.out), one.out.slice(-300));
    const none = await run(["--client=no-such-client"]); outputs.push(none.out);
    ok("an unknown client is an error, not a silent success", none.code === 1 && /No client matches/.test(none.out));

    // 4f. the row ceiling
    await addClient("c-beta", "Beta Bakery", "sc-domain:beta.example");
    await addClient("c-gamma", "Gamma Gardens", "sc-domain:gamma.example");
    fake.calls.length = 0;
    const cap = await run(["--client=beta-bakery", "--months=1"]); outputs.push(cap.out);
    const beta = (await rowsFor("c-beta"))[0]!;
    ok("a read that reaches the ceiling says so", cap.code === 0 && beta?.rows_capped === true && beta.rows_read === QUERY_ROW_CEILING, [beta, cap.out.slice(-300)]);
    ok("a capped month has NO hidden figure and its split is the floor", beta.hidden_clicks === null && beta.hidden_impressions === null && beta.other_clicks === QUERY_ROW_CEILING && beta.branded_clicks === 0 && beta.total_clicks === 80_000, beta);
    ok("it stops at the ceiling (three pages, no fourth)", fake.calls.filter((x) => /searchAnalytics/.test(x.path) && JSON.parse(x.body).dimensions).length === QUERY_ROW_CEILING / QUERY_PAGE_SIZE);
    ok("the run says the split is a floor", /cut at the row ceiling, so the split is a floor/.test(cap.out) && /1 cut at the row ceiling/.test(cap.out));
    const g = await run(["--client=gamma-gardens", "--months=1"]); outputs.push(g.out);
    const gamma = (await rowsFor("c-gamma"))[0]!;
    ok("exactly one full page then an empty one is NOT capped", gamma?.rows_capped === false && gamma.rows_read === QUERY_PAGE_SIZE && gamma.hidden_clicks === 5000, gamma);

    // 4g. the table
    const cols = (await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'seo_query_months' ORDER BY ordinal_position`)).rows.map((r) => r.column_name);
    ok("the table the job made has the declared columns, and the unique key", JSON.stringify(cols) === JSON.stringify(DDL_COLS) && (await c.query(`SELECT 1 FROM pg_indexes WHERE tablename='seo_query_months' AND indexdef ILIKE '%UNIQUE%client_id, month%'`)).rowCount === 1, cols);
    ok("the table's client column is a real foreign key", (await c.query(`SELECT 1 FROM information_schema.table_constraints WHERE table_name='seo_query_months' AND constraint_type='FOREIGN KEY'`)).rowCount === 1);

    // 4h. no search anywhere
    const dump = JSON.stringify((await c.query(`SELECT * FROM seo_query_months`)).rows) + JSON.stringify((await c.query(`SELECT * FROM app_settings`)).rows);
    const hay = (outputs.join("\n") + dump).toLowerCase();
    const leaked = [...ALL_TEXTS, "jane doe", "zzq-"].filter((t) => hay.includes(t.toLowerCase()));
    ok("no search text is in anything a run printed or in any stored row", leaked.length === 0, leaked);
    ok("not even the pretend server's own error text reaches the output", !/sufficient permission/i.test(outputs.join("\n")));
    selfTest("the leak scan would see a search", (t) => !ALL_TEXTS.some((x) => t.toLowerCase().includes(x.toLowerCase())), "branded 192, other 47", "alpha smiles cincinnati: 15 clicks");
  } finally {
    await fake?.close();
    await c.end();
    await a.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
    await a.end();
  }
}

const adminUrl = process.env.ADS_VERIFY_DATABASE_URL;
if (!adminUrl) {
  hr("4. The real job against a pretend Search Console and a throwaway database");
  console.log("  ⏭  skipped: ADS_VERIFY_DATABASE_URL is not set. CI runs this section in the `ads-store` job.");
  console.log("     Locally: `node scripts/test-db.mjs start` in the dashboard repo prints a URL.");
} else {
  await realJob(adminUrl);
}

console.log("\n" + "─".repeat(72));
if (failures) { console.log(`${failures} check(s) failed.`); process.exit(1); }
console.log("All checks passed.");

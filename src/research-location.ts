/** Where a keyword research run searches, and how a place is written down. */

/**
 * Pure. Facts in, one answer out. No imports, because this file is copied byte
 * for byte into the worker (bsllc-sync-worker/src/research-location.ts) and
 * `npm run verify:wiring` fails when the two drift. The panel that shows
 * "Searched in Cincinnati, OH" and the job that sends the request to the
 * research provider have to read one place the same way, or a run is labelled
 * with a city it was never run in.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * The owner, on a run for Ohio Community Health: ten service seeds came back
 * as 200 ideas at NATIONAL volumes. The panel's default was
 * `client.seoLocation || "United States"`, and the field is blank on most
 * accounts, so a client that sells in one metro area was researched across the
 * whole country. A volume measured nationally is not a volume anybody in
 * Cincinnati searches, and a gap built on it is a gap in a market the client
 * does not sell into.
 *
 * ── THE FOUR RULES ─────────────────────────────────────────────────────────
 *
 *  1. THE DEFAULT IS A PLACE SOMEBODY RECORDED, never one read from a client's
 *     name, a title or an industry. In order: the location typed on the
 *     client's tracking config, then the place its own local tracked searches
 *     are pinned to. Nothing else qualifies.
 *  2. A BILLING ADDRESS IS OFFERED, NEVER ASSUMED. It says where invoices go,
 *     not where a client sells, so it is a choice in the list and is never the
 *     default.
 *  3. NO PLACE IS AN ANSWER THE PANEL GIVES. With nothing recorded and nothing
 *     chosen the run is refused with a sentence that says what to do. A blank
 *     is unanswered. It is never read as "the whole country".
 *  4. A VOLUME BELONGS TO THE PLACE IT WAS MEASURED IN. Two runs in different
 *     places are two markets, and `sameMarket` is how a reader tells them
 *     apart so it never adds or ranks one against the other.
 *
 * The provider takes a place as "City,State,United States". The AM types
 * "Cincinnati, OH". `providerLocationName` writes the first from the second
 * and says nothing it cannot back: a lone word like "Cincinnati" is ambiguous
 * (there are more than one) and is refused rather than guessed.
 */

export const UNITED_STATES = "United States";

/** The fifty states and DC. A fact about the country, not about any industry. */
export const US_STATES: Readonly<Record<string, string>> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan",
  MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota",
  OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee",
  TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
  WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

const STATE_BY_NAME = new Map<string, string>(
  Object.entries(US_STATES).map(([abbr, name]) => [name.toLowerCase(), abbr] as const),
);

const COUNTRY_WORDS = new Set(["united states", "usa", "us", "u.s.", "u.s.a.", "united states of america"]);

export type ParsedPlace =
  /** The whole country. */
  | { kind: "country"; raw: string }
  /** One state. */
  | { kind: "state"; raw: string; stateAbbr: string; state: string }
  /** A city in a state. */
  | { kind: "city"; raw: string; city: string; stateAbbr: string; state: string }
  /** Two or more parts we do not recognise: passed through as written, because
   *  it may be a provider-form name for a place outside the states. */
  | { kind: "provider"; raw: string }
  /** One word that is not a state or a country. There is more than one
   *  Cincinnati, so nothing here picks. */
  | { kind: "ambiguous"; raw: string };

function cleanParts(raw: string): string[] {
  return String(raw ?? "")
    .split(",")
    .map((p) => p.trim().replace(/\s+/g, " "))
    .filter((p) => p.length > 0);
}

function stateOf(part: string): { abbr: string; name: string } | null {
  const up = part.replace(/\./g, "").trim();
  if (/^[A-Za-z]{2}$/.test(up) && US_STATES[up.toUpperCase()]) {
    const abbr = up.toUpperCase();
    return { abbr, name: US_STATES[abbr]! };
  }
  const abbr = STATE_BY_NAME.get(up.toLowerCase());
  return abbr ? { abbr, name: US_STATES[abbr]! } : null;
}

/** "cincinnati" and "CINCINNATI" become "Cincinnati"; "St. Louis" is left as typed. */
function tidyCity(city: string): string {
  const hasUpper = /[A-Z]/.test(city);
  const hasLower = /[a-z]/.test(city);
  if (hasUpper && hasLower) return city;
  return city.toLowerCase().replace(/(^|[\s\-'.])([a-z])/g, (_m, pre: string, ch: string) => pre + ch.toUpperCase());
}

/** Read a place the way a person writes it. Null where nothing was written. */
export function parsePlace(raw: string | null | undefined): ParsedPlace | null {
  const parts = cleanParts(raw ?? "");
  if (parts.length === 0) return null;
  const text = parts.join(", ");
  let sawCountry = false;
  if (COUNTRY_WORDS.has(parts[parts.length - 1]!.toLowerCase())) {
    sawCountry = true;
    parts.pop();
  }
  if (parts.length === 0) return sawCountry ? { kind: "country", raw: text } : null;
  if (parts.length === 1) {
    const st = stateOf(parts[0]!);
    if (st) return { kind: "state", raw: text, stateAbbr: st.abbr, state: st.name };
    // A word and a country ("Canada, United States" never happens) is still one word.
    return { kind: "ambiguous", raw: text };
  }
  if (parts.length === 2) {
    const st = stateOf(parts[1]!);
    if (st && !stateOf(parts[0]!)) {
      return { kind: "city", raw: text, city: tidyCity(parts[0]!), stateAbbr: st.abbr, state: st.name };
    }
  }
  return { kind: "provider", raw: text };
}

/**
 * The name the research provider takes: "Cincinnati,Ohio,United States".
 * Null for a place that cannot be written that way (nothing typed, or one word
 * that could be many places).
 */
export function providerLocationName(raw: string | null | undefined): string | null {
  const p = parsePlace(raw);
  if (!p) return null;
  switch (p.kind) {
    case "country": return UNITED_STATES;
    case "state": return `${p.state},${UNITED_STATES}`;
    case "city": return `${p.city},${p.state},${UNITED_STATES}`;
    case "provider": return cleanParts(p.raw).join(",");
    case "ambiguous": return null;
  }
}

/** What to call a place on a screen: "Cincinnati, OH", "Ohio", "the United States". */
export function placeLabel(raw: string | null | undefined): string | null {
  const p = parsePlace(raw);
  if (!p) return null;
  switch (p.kind) {
    case "country": return "the United States";
    case "state": return p.state;
    case "city": return `${p.city}, ${p.stateAbbr}`;
    case "provider": {
      // "Cincinnati,Ohio,United States" read back as "Cincinnati, OH" where the
      // parts are a city, a state and the country.
      const parts = cleanParts(p.raw);
      return parts.join(", ");
    }
    case "ambiguous": return p.raw;
  }
}

/**
 * The key two places are compared on. "Cincinnati, OH" and
 * "Cincinnati,Ohio,United States" are one market. Null where nothing was
 * written, which is unanswered and never equal to anything.
 */
export function placeKey(raw: string | null | undefined): string | null {
  const name = providerLocationName(raw) ?? (parsePlace(raw)?.raw ?? null);
  if (!name) return null;
  return name.toLowerCase().replace(/\s*,\s*/g, ",").replace(/\s+/g, " ");
}

/** Are these two the same market? Two unanswered places are not the same. */
export function sameMarket(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = placeKey(a);
  const kb = placeKey(b);
  return ka != null && kb != null && ka === kb;
}

/** Is this the whole country? */
export function isNational(raw: string | null | undefined): boolean {
  return parsePlace(raw)?.kind === "country";
}

/** The one line a run carries wherever it is shown. */
export function searchedInLine(raw: string | null | undefined): string {
  const label = placeLabel(raw);
  if (!label) return "The place this was searched in was not recorded.";
  return isNational(raw) ? "Searched across the United States." : `Searched in ${label}.`;
}

/** What a national run says to a client that sells in one place. */
export const NATIONAL_NOTE =
  "These volumes are for the whole country. They are not what people near this client search.";

export const NO_LOCATION_MESSAGE = "No location on this client: set one or choose United States.";

export function unreadableLocationMessage(typed: string): string {
  return `We cannot look up "${typed}" on its own, because more than one place has that name. Write it as city and state, like Cincinnati, OH, or choose United States.`;
}

export function unreadableSettingMessage(typed: string): string {
  return `The location on this client's tracking config is "${typed}", and more than one place has that name. Write it as city and state, like Cincinnati, OH, or choose another place for this run.`;
}

/* ───────────────────────── which place a run uses ───────────────────────── */

export interface LocationChoices {
  /** A place a person picked or typed on the panel for this run. */
  override?: string | null;
  /** `clients.seo_location`, as recorded on the tracking config. */
  seoLocation?: string | null;
  /** `seo_targets.location_name` of the client's active LOCAL tracked searches. */
  targetLocations?: ReadonlyArray<string | null | undefined> | null;
  /** The billing city and state. Offered, never the default. */
  billing?: { city?: string | null; state?: string | null } | null;
}

export type LocationSource = "chosen" | "client_setting" | "tracked_searches";

export type LocationResolution =
  | { ok: true; location: string; label: string; source: LocationSource; national: boolean }
  | { ok: false; code: "no_location" | "unreadable_location"; message: string };

/** Distinct tracked-search places, most used first, ties alphabetical. */
function rankedTargetPlaces(list: LocationChoices["targetLocations"]): Array<{ value: string; count: number }> {
  const counts = new Map<string, { value: string; count: number }>();
  for (const t of list ?? []) {
    const v = String(t ?? "").trim();
    if (!v) continue;
    const k = placeKey(v) ?? v.toLowerCase();
    const hit = counts.get(k);
    if (hit) hit.count += 1;
    else counts.set(k, { value: v, count: 1 });
  }
  return Array.from(counts.values()).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

function resolved(raw: string, source: LocationSource): LocationResolution {
  const name = providerLocationName(raw);
  return {
    ok: true,
    location: name ?? raw.trim(),
    label: placeLabel(raw) ?? raw.trim(),
    source,
    national: isNational(raw),
  };
}

export function resolveResearchLocation(c: LocationChoices): LocationResolution {
  const chosen = String(c.override ?? "").trim();
  if (chosen) {
    if (providerLocationName(chosen) == null) {
      return { ok: false, code: "unreadable_location", message: unreadableLocationMessage(chosen) };
    }
    return resolved(chosen, "chosen");
  }
  const setting = String(c.seoLocation ?? "").trim();
  if (setting) {
    if (providerLocationName(setting) == null) {
      return { ok: false, code: "unreadable_location", message: unreadableSettingMessage(setting) };
    }
    return resolved(setting, "client_setting");
  }
  const targets = rankedTargetPlaces(c.targetLocations).filter((t) => providerLocationName(t.value) != null);
  if (targets.length) return resolved(targets[0]!.value, "tracked_searches");
  return { ok: false, code: "no_location", message: NO_LOCATION_MESSAGE };
}

export interface LocationOption {
  /** What gets sent as the override. */
  value: string;
  label: string;
  source: LocationSource | "billing" | "national";
  /** The one the run uses if nobody picks. */
  isDefault: boolean;
  /** Where it comes from, in words, for the list. */
  note: string;
}

/** Every place the panel offers, the default marked. */
export function researchLocationOptions(c: LocationChoices): LocationOption[] {
  const out: LocationOption[] = [];
  const seen = new Set<string>();
  const def = resolveResearchLocation({ ...c, override: null });
  const defKey = def.ok ? placeKey(def.location) : null;
  const push = (value: string, source: LocationOption["source"], note: string) => {
    const k = placeKey(value);
    if (!k || seen.has(k) || providerLocationName(value) == null) return;
    seen.add(k);
    out.push({ value, label: placeLabel(value) ?? value, source, isDefault: defKey != null && k === defKey, note });
  };
  const setting = String(c.seoLocation ?? "").trim();
  if (setting) push(setting, "client_setting", "From this client's tracking config");
  for (const t of rankedTargetPlaces(c.targetLocations)) push(t.value, "tracked_searches", "Where its local tracked searches are pinned");
  const b = c.billing;
  const city = String(b?.city ?? "").trim();
  const st = String(b?.state ?? "").trim();
  if (city && st) push(`${city}, ${st}`, "billing", "From the billing address. Check it is where they sell");
  push(UNITED_STATES, "national", "The whole country");
  return out;
}

/* ───────────────────────── which runs a reading may use ───────────────────────── */

export interface RunPlace {
  id: string;
  /** `research_requests.location_name`. */
  location: string | null | undefined;
}

/**
 * Runs are read in the place the NEWEST one was searched in. Two runs in
 * different places are different markets: ranking one's volumes against the
 * other's, or keeping a phrase from one beside a phrase from the other, would
 * compare numbers that never measured the same people. The runs left out are
 * counted so a reading can say so.
 *
 * `runs` must be newest first. A run with no recorded place is unanswered, so
 * it is never in the same market as anything and is counted as left out.
 */
export function splitRunsByMarket(runs: readonly RunPlace[]): { place: string | null; used: string[]; leftOut: string[] } {
  const first = runs.find((r) => placeKey(r.location) != null);
  if (!first) return { place: null, used: [], leftOut: runs.map((r) => r.id) };
  const used: string[] = [];
  const leftOut: string[] = [];
  for (const r of runs) (sameMarket(r.location, first.location) ? used : leftOut).push(r.id);
  return { place: first.location ?? null, used, leftOut };
}

/** The sentence a reading carries when it left runs out. */
export function otherMarketLine(count: number, place: string | null | undefined): string | null {
  if (count <= 0) return null;
  const where = placeLabel(place) ?? "the newest run's place";
  return `${count} older ${count === 1 ? "run was" : "runs were"} searched somewhere other than ${where} and ${count === 1 ? "was" : "were"} left out, because volumes from different places are not comparable.`;
}

/** What the panel says before a run starts: where it will search. */
export function willSearchLine(raw: string | null | undefined): string {
  const label = placeLabel(raw);
  if (!label) return NO_LOCATION_MESSAGE;
  return isNational(raw) ? `Will search across the United States. ${NATIONAL_NOTE}` : `Will search in ${label}.`;
}

/** Said beside a billing address that is offered as a place to search. */
export const BILLING_PLACE_NOTE = "This is the billing address. Nobody recorded that they sell there.";

/**
 * The calls and the answers, read defensively. Pure parsers: what Tag Manager sent in,
 * declared facts out. Nothing here stores a custom HTML body, a variable's value or a
 * template's code (the guard plants a poisoned answer and checks none of it comes out).
 */
import { HttpError, getJson } from "../page-behaviour/http.js";
import { sleep, serviceUrl, text } from "../signals/common.js";
import type { FetchLike } from "../page-behaviour/types.js";
import {
  BUILT_IN_TRIGGER_MIN, GTM_BASE, GTM_EVENT_NAME_CAP, GTM_PAUSE_MS, GTM_STRING_MAX, GTM_TAG_CAP, GTM_TRIES, GTM_TRIGGER_CAP, GTM_VARIABLE_NAME_CAP,
  KNOWN_TEMPLATES, TAG_TYPE, type GtmFacts, type GtmVersionOut,
} from "./types.js";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export const gtmUrl = (path: string): string => serviceUrl("gtm", `${GTM_BASE}/${path.replace(/^\/+/, "")}`);

/** GET with a short retry on 429 and 5xx. Never retries a refusal. */
export async function gtmGet(f: FetchLike, token: string, path: string, what: string, pauseMs = GTM_PAUSE_MS): Promise<unknown> {
  let last: unknown;
  for (let i = 0; i < GTM_TRIES; i++) {
    try {
      return await getJson(f, gtmUrl(path), { Authorization: `Bearer ${token}`, Accept: "application/json" }, what);
    } catch (e) {
      last = e;
      const retry = e instanceof HttpError && (e.status === 429 || e.status >= 500);
      if (!retry || i === GTM_TRIES - 1) throw e;
      await sleep(pauseMs * 2 ** i);
    }
  }
  throw last;
}

/** Tag Manager answers a disabled API with a 403 whose body says so. A different fix from a missing grant. */
export const isApiDisabled = (e: unknown): boolean => e instanceof HttpError && e.status === 403 && /SERVICE_DISABLED|has not been used in project|API has not been enabled|is disabled/i.test(e.body);
export const isNoAccess = (e: unknown): boolean => e instanceof HttpError && (e.status === 403 || e.status === 404) && !isApiDisabled(e);

export interface ContainerListing { publicId: string; path: string; usage: string[] }

/** The accounts the service account can see: their paths. */
export const parseAccounts = (json: unknown): string[] =>
  arr(obj(json)?.account).map((a) => text(obj(a)?.path, 80)).filter((p): p is string => !!p && /^accounts\/\d+$/.test(p));

export function parseContainers(json: unknown): ContainerListing[] {
  const out: ContainerListing[] = [];
  for (const c of arr(obj(json)?.container)) {
    const o = obj(c);
    const publicId = text(o?.publicId, 30)?.toUpperCase();
    const path = text(o?.path, 120);
    if (!publicId || !path || !/^accounts\/\d+\/containers\/\d+$/.test(path)) continue;
    out.push({ publicId, path, usage: arr(o?.usageContext).map((u) => String(u)).slice(0, 5) });
  }
  return out;
}

/** Every container the service account can see, keyed by public id. Throws what Tag Manager threw. */
export async function listContainers(f: FetchLike, token: string, pauseMs: number): Promise<Map<string, ContainerListing>> {
  const out = new Map<string, ContainerListing>();
  const accounts = parseAccounts(await gtmGet(f, token, "accounts", "Tag Manager list accounts", pauseMs));
  for (const a of accounts) {
    if (pauseMs) await sleep(pauseMs);
    for (const c of parseContainers(await gtmGet(f, token, `${a}/containers`, "Tag Manager list containers", pauseMs))) out.set(c.publicId, c);
  }
  return out;
}

/** The live published version of one container. A container never published answers 404. */
export const getLiveVersion = (f: FetchLike, token: string, containerPath: string, pauseMs: number) =>
  gtmGet(f, token, `${containerPath}/versions:live`, "Tag Manager live version", pauseMs);

/* ── parsing the live version into declared facts ── */

function params(tag: Obj): Map<string, { type: string; value: string | null }> {
  const m = new Map<string, { type: string; value: string | null }>();
  for (const p of arr(tag.parameter)) {
    const o = obj(p); if (!o) continue;
    const key = text(o.key, 60); if (!key) continue;
    // Only plain string values are ever read; a list or a map is never opened.
    m.set(key, { type: String(o.type ?? ""), value: typeof o.value === "string" ? o.value : null });
  }
  return m;
}
const isVariableRef = (v: string | null) => v != null && /\{\{[^}]+\}\}/.test(v);
const ga4Id = (v: string | null) => (v && /^G-[A-Z0-9]{4,12}$/i.test(v.trim()) ? v.trim().toUpperCase() : null);
const adsId = (v: string | null) => (v && /^(AW-)?\d{6,12}$/i.test(v.trim()) ? (v.trim().toUpperCase().startsWith("AW-") ? v.trim().toUpperCase() : `AW-${v.trim()}`) : null);
const eventName = (v: string | null) => (v && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(v.trim()) ? v.trim() : null);
const idOf = (v: unknown): string | null => (typeof v === "string" || typeof v === "number" ? String(v) : null);

/** One trigger as a type and a short summary of its conditions. Values are never kept, except a custom event's name. */
function summariseTrigger(t: Obj): { id: string | null; type: string; summary: string } {
  const type = text(t.type, 40) ?? "unknown";
  const filters = [...arr(t.filter), ...arr(t.customEventFilter), ...arr(t.autoEventFilter)];
  const ops = Array.from(new Set(filters.map((f) => text(obj(f)?.type, 30)).filter((x): x is string => !!x))).slice(0, 4);
  let evName: string | null = null;
  if (type === "customEvent") {
    for (const f of arr(t.customEventFilter)) {
      for (const p of arr(obj(f)?.parameter)) { const o = obj(p); if (o?.key === "arg1" && typeof o.value === "string" && eventName(o.value)) evName = o.value.trim(); }
    }
  }
  const bits = [filters.length ? `${filters.length} condition${filters.length === 1 ? "" : "s"}${ops.length ? ` (${ops.join(", ")})` : ""}` : "no conditions", evName ? `event ${evName}` : null].filter(Boolean);
  return { id: idOf(t.triggerId), type, summary: bits.join(", ").slice(0, GTM_STRING_MAX * 2) };
}

const fingerprintDate = (fp: unknown): Date | null => {
  const n = typeof fp === "string" || typeof fp === "number" ? Number(fp) : NaN;
  if (!Number.isFinite(n)) return null;
  const d = new Date(n);
  return d.getTime() > Date.UTC(2010, 0, 1) && d.getTime() < Date.now() + 86_400_000 ? d : null;
};

export function parseLiveVersion(json: unknown): { version: GtmVersionOut; facts: GtmFacts } {
  const v = obj(json) ?? {};
  const triggersRaw = arr(v.trigger).map((t) => obj(t)).filter((t): t is Obj => !!t);
  const triggers = triggersRaw.slice(0, GTM_TRIGGER_CAP).map(summariseTrigger);
  const triggerIds = new Set(triggers.map((t) => t.id).filter((x): x is string => !!x));
  const hasTrigger = (tag: Obj): boolean => arr(tag.firingTriggerId).some((i) => {
    const id = idOf(i); if (!id) return false;
    return triggerIds.has(id) || (Number(id) >= BUILT_IN_TRIGGER_MIN);
  });

  // Community templates: id -> exact gallery reference.
  const templateKind = new Map<string, "clarity" | "metaPixel" | "custom">();
  for (const ct of arr(v.customTemplate)) {
    const o = obj(ct); const ref = obj(o?.galleryReference); const tid = idOf(o?.templateId);
    if (!tid) continue;
    const owner = text(ref?.owner, 80)?.toLowerCase(), repo = text(ref?.repository, 80)?.toLowerCase();
    const known = owner && repo ? KNOWN_TEMPLATES.find((k) => k.owner === owner && k.repository === repo) : undefined;
    templateKind.set(tid, known ? known.kind : "custom");
  }

  const facts: GtmFacts = {
    v: 1,
    counts: { tags: 0, paused: 0, triggers: triggersRaw.length, variables: arr(v.variable).length, truncated: false },
    ga4Configs: [], ga4Events: [], adsConversions: [],
    conversionLinker: { count: 0, active: 0 }, clarity: { count: 0, active: 0 }, metaPixel: { count: 0, active: 0 },
    customTags: 0, otherTags: 0, triggers, variableNames: [],
  };
  const tags = arr(v.tag).map((t) => obj(t)).filter((t): t is Obj => !!t);
  facts.counts.tags = tags.length;
  facts.counts.truncated = tags.length > GTM_TAG_CAP;
  for (const tag of tags.slice(0, GTM_TAG_CAP)) {
    const type = String(tag.type ?? "");
    const paused = tag.paused === true;
    const fires = !paused && hasTrigger(tag);
    if (paused) facts.counts.paused += 1;
    const p = params(tag);
    const bump = (c: { count: number; active: number }) => { c.count += 1; if (fires) c.active += 1; };
    if (type === TAG_TYPE.ga4Config || (type === TAG_TYPE.googleTag && /^G-/i.test(p.get("tagId")?.value ?? ""))) {
      const raw = (p.get("measurementId") ?? p.get("tagId"))?.value ?? null;
      facts.ga4Configs.push({ measurementId: ga4Id(raw), viaVariable: isVariableRef(raw), paused, fires });
    } else if (type === TAG_TYPE.ga4Event) {
      facts.ga4Events.push({ event: eventName(p.get("eventName")?.value ?? null), paused, fires });
    } else if (type === TAG_TYPE.adsConversion) {
      facts.adsConversions.push({ conversionId: adsId(p.get("conversionId")?.value ?? null), hasLabel: Boolean((p.get("conversionLabel")?.value ?? "").trim()), paused, fires });
    } else if (type === TAG_TYPE.googleTag && /^AW-/i.test(p.get("tagId")?.value ?? "")) {
      facts.otherTags += 1;
    } else if (type === TAG_TYPE.conversionLinker) {
      bump(facts.conversionLinker);
    } else if (type === TAG_TYPE.customHtml || type === TAG_TYPE.customImage) {
      facts.customTags += 1;
    } else if (type.startsWith("cvt_")) {
      const kind = templateKind.get(type.slice(type.lastIndexOf("_") + 1)) ?? "custom";
      if (kind === "clarity") bump(facts.clarity); else if (kind === "metaPixel") bump(facts.metaPixel); else facts.customTags += 1;
    } else facts.otherTags += 1;
  }
  facts.ga4Events = facts.ga4Events.slice(0, GTM_EVENT_NAME_CAP);
  facts.variableNames = arr(v.variable).map((x) => text(obj(x)?.name, GTM_STRING_MAX)).filter((x): x is string => !!x).slice(0, GTM_VARIABLE_NAME_CAP);
  return {
    version: { versionId: idOf(v.containerVersionId), versionName: text(v.name, 120), publishedAt: fingerprintDate(v.fingerprint) },
    facts,
  };
}

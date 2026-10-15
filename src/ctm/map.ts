/**
 * One CTM call record to one stored row, or to a refusal.
 *
 * `buildCall` reads ONLY the fields in `CTM_FIELDS` and returns exactly `CTM_ROW_KEYS`.
 * Nothing else in a record is read, so nothing else can be stored: a recording link, a
 * transcript, a summary, a note, a caller name or a visitor IP never enters this function's
 * output whatever CTM sends. The caller's number becomes a salted hash and is not returned
 * in any other form.
 */
import { createHmac } from "node:crypto";
import { num, text } from "../signals/common.js";
import {
  CTM_FIELDS, CTM_STRING_MAX, TAG_GOOGLE_ADS_CONVERSION, TAG_REPEAT,
  type CtmCallRow, type CtmDirection, type CtmStatus, type FieldAlias,
} from "./types.js";

type Rec = Record<string, unknown>;
const norm = (k: string): string => k.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The first alias present in the record, JSON names before export headings. */
export function pick(rec: Rec, alias: FieldAlias): unknown {
  const index = new Map<string, unknown>();
  for (const [k, v] of Object.entries(rec)) index.set(norm(k), v);
  for (const name of [...alias.json, ...alias.csv]) {
    const v = index.get(norm(name));
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

/** A phone-looking run of digits, an address or a machine address in free text is not kept as typed. */
const PHONE_LIKE = /\+?\d[\d\s().-]{6,}\d/g;
const EMAIL_LIKE = /\S+@\S+/g;
export function cleanText(v: unknown, max = CTM_STRING_MAX): string | null {
  const t = text(v, 400);
  if (!t) return null;
  const cleaned = t.replace(EMAIL_LIKE, "[email]").replace(PHONE_LIKE, "[number]").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

export function normalizeStatus(v: unknown): CtmStatus | null {
  const t = typeof v === "string" ? v.toLowerCase().replace(/[^a-z]+/g, "_").replace(/^_+|_+$/g, "") : "";
  if (!t) return null;
  if (/^(answered|completed|connected|talked)$/.test(t)) return "answered";
  if (/(hang_?up|hung_up|abandon)/.test(t)) return "hangup";
  if (/(no_answer|unanswered|missed|ring_?out|busy|voicemail)/.test(t)) return "no_answer";
  return null;
}
export function normalizeDirection(v: unknown): CtmDirection | null {
  const t = typeof v === "string" ? v.toLowerCase() : "";
  if (/^in/.test(t)) return "inbound";
  if (/^out/.test(t)) return "outbound";
  return null;
}

/** Seconds from 143, "143", "02:23" or "1:02:23". Anything else is unanswered, never 0. */
export function seconds(v: unknown): number | null {
  if (typeof v === "string" && /^\d{1,3}(:\d{2}){1,2}$/.test(v.trim())) {
    const parts = v.trim().split(":").map(Number);
    return parts.length === 2 ? parts[0]! * 60 + parts[1]! : parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  }
  const n = num(v);
  return n != null && Number.isFinite(n) && n >= 0 && n < 86_400 ? Math.round(n) : null;
}

/**
 * The time a call was made, as an ISO instant. ONLY where the record says which instant:
 * an ISO time or "YYYY-MM-DD HH:MM:SS +hhmm" (an offset or a Z), or a unix time. A time
 * with no offset is NOT read as any zone, because a guess shifts a call into the wrong
 * day; the record is refused and counted instead.
 */
export function calledAtOf(rec: Rec): string | null {
  const raw = pick(rec, CTM_FIELDS.calledAt);
  if (typeof raw === "string") {
    const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)\s*(Z|[+-]\d{2}:?\d{2})$/i.exec(raw.trim());
    if (m) {
      const off = m[3]!.toUpperCase() === "Z" ? "Z" : m[3]!.replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
      const d = new Date(`${m[1]}T${m[2]!.length === 5 ? `${m[2]}:00` : m[2]}${off}`);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
  }
  const u = num(pick(rec, CTM_FIELDS.unixTime)) ?? (typeof raw === "number" ? raw : null);
  if (u != null && u > 1_000_000_000 && u < 4_000_000_000) return new Date(u * 1000).toISOString();
  if (u != null && u > 1_000_000_000_000 && u < 4_000_000_000_000) return new Date(u).toISOString();
  return null;
}

/** The caller's number to a stable hash. null where there is no usable number. The key is never stored or returned. */
export function callerHashOf(v: unknown, key: string): string | null {
  const digits = typeof v === "string" || typeof v === "number" ? String(v).replace(/\D/g, "") : "";
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (ten.length < 7 || ten.length > 15) return null;
  return createHmac("sha256", key).update(ten).digest("hex");
}

function tagsOf(v: unknown): string[] | null {
  if (v == null) return null;
  let raw: unknown[];
  if (Array.isArray(v)) raw = v;
  else if (typeof v === "string") raw = v.split(/[,|]/);
  else return null;
  return raw
    .map((t) => (typeof t === "string" ? t : t && typeof t === "object" ? String((t as Rec).name ?? (t as Rec).tag ?? "") : ""))
    .map((t) => t.toLowerCase().replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

const GCLID = /^[A-Za-z0-9_.-]{10,200}$/;

export type BuildResult = { row: CtmCallRow } | { skip: "no_id" | "no_time" };
export function buildCall(rec: Rec, hashKey: string): BuildResult {
  const idRaw = pick(rec, CTM_FIELDS.id);
  const ctmCallId = typeof idRaw === "string" || typeof idRaw === "number" ? String(idRaw).trim().slice(0, 80) : "";
  if (!ctmCallId) return { skip: "no_id" };
  const calledAt = calledAtOf(rec);
  if (!calledAt) return { skip: "no_time" };
  const tags = tagsOf(pick(rec, CTM_FIELDS.tags));
  const gclidRaw = text(pick(rec, CTM_FIELDS.gclid), 300);
  return {
    row: {
      ctmCallId, calledAt,
      trackingSource: cleanText(pick(rec, CTM_FIELDS.trackingSource)),
      trackingLabel: cleanText(pick(rec, CTM_FIELDS.trackingLabel)),
      status: normalizeStatus(pick(rec, CTM_FIELDS.status)),
      talkSeconds: seconds(pick(rec, CTM_FIELDS.talk)),
      ringSeconds: seconds(pick(rec, CTM_FIELDS.ring)),
      durationSeconds: seconds(pick(rec, CTM_FIELDS.duration)),
      direction: normalizeDirection(pick(rec, CTM_FIELDS.direction)),
      city: cleanText(pick(rec, CTM_FIELDS.city), 60),
      state: cleanText(pick(rec, CTM_FIELDS.state), 40),
      gclid: gclidRaw && GCLID.test(gclidRaw) ? gclidRaw : null,
      utmSource: cleanText(pick(rec, CTM_FIELDS.utmSource), 80),
      utmMedium: cleanText(pick(rec, CTM_FIELDS.utmMedium), 80),
      utmCampaign: cleanText(pick(rec, CTM_FIELDS.utmCampaign), 120),
      device: cleanText(pick(rec, CTM_FIELDS.device), 40),
      // Only two tags are read, as yes or no. No tag text is kept. A record with no tags field is unanswered, not "no".
      tagsGoogleAdsConversion: tags ? tags.some((t) => TAG_GOOGLE_ADS_CONVERSION.test(t)) : null,
      tagsRepeat: tags ? tags.some((t) => TAG_REPEAT.test(t)) : null,
      callerHash: callerHashOf(pick(rec, CTM_FIELDS.callerNumber), hashKey),
    },
  };
}

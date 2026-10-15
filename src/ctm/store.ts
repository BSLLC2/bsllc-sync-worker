/**
 * The only writes the call-log reader makes: calls in `ctm_calls` (schema v257) and a
 * status in `signal_runs`. The column list is LITERAL so the dashboard's
 * `npm run verify:wiring` can read it against shared/schema.ts in both directions.
 *
 * There is no column for a number, a name, caller-ID text, a recording, a transcript, a
 * summary, a note, a message body or an IP. The caller is a salted hash only.
 */
import { createHash } from "node:crypto";
import type { Queryable } from "../page-behaviour/store.js";
import type { CtmCallRow } from "./types.js";

export const BATCH = 400;

export const UPSERT_CTM_CALLS = `INSERT INTO ctm_calls (id, client_id, ctm_call_id, called_at, tracking_source, tracking_label, status, talk_seconds, ring_seconds, duration_seconds, direction, city, state, gclid, utm_source, utm_medium, utm_campaign, device, tags_google_ads_conversion, tags_repeat, caller_hash, read_at)
 SELECT t.id, $1, t.ctm_call_id, t.called_at::timestamptz, t.tracking_source, t.tracking_label, t.status, t.talk_seconds, t.ring_seconds, t.duration_seconds, t.direction, t.city, t.state, t.gclid, t.utm_source, t.utm_medium, t.utm_campaign, t.device, t.tags_google_ads_conversion, t.tags_repeat, t.caller_hash, $2
   FROM jsonb_to_recordset($3::jsonb) AS t(id text, ctm_call_id text, called_at text, tracking_source text, tracking_label text, status text, talk_seconds int, ring_seconds int, duration_seconds int, direction text, city text, state text, gclid text, utm_source text, utm_medium text, utm_campaign text, device text, tags_google_ads_conversion boolean, tags_repeat boolean, caller_hash text)
 ON CONFLICT (client_id, ctm_call_id) DO UPDATE SET called_at = EXCLUDED.called_at, tracking_source = EXCLUDED.tracking_source, tracking_label = EXCLUDED.tracking_label,
   status = EXCLUDED.status, talk_seconds = EXCLUDED.talk_seconds, ring_seconds = EXCLUDED.ring_seconds, duration_seconds = EXCLUDED.duration_seconds, direction = EXCLUDED.direction,
   city = EXCLUDED.city, state = EXCLUDED.state, gclid = EXCLUDED.gclid, utm_source = EXCLUDED.utm_source, utm_medium = EXCLUDED.utm_medium, utm_campaign = EXCLUDED.utm_campaign,
   device = EXCLUDED.device, tags_google_ads_conversion = EXCLUDED.tags_google_ads_conversion, tags_repeat = EXCLUDED.tags_repeat, caller_hash = EXCLUDED.caller_hash, read_at = EXCLUDED.read_at`;

/** Housekeeping: a call older than $2 is dropped. */
export const PRUNE_CTM_CALLS = `DELETE FROM ctm_calls WHERE client_id = $1 AND called_at < $2`;

const id = (clientId: string, callId: string): string => createHash("sha256").update(`ctm\u0001${clientId}\u0001${callId}`).digest("hex").slice(0, 40);

export async function writeCalls(c: Queryable, clientId: string, rows: CtmCallRow[], at: Date): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH) {
    const payload = rows.slice(i, i + BATCH).map((r) => ({
      id: id(clientId, r.ctmCallId), ctm_call_id: r.ctmCallId, called_at: r.calledAt, tracking_source: r.trackingSource, tracking_label: r.trackingLabel, status: r.status,
      talk_seconds: r.talkSeconds, ring_seconds: r.ringSeconds, duration_seconds: r.durationSeconds, direction: r.direction, city: r.city, state: r.state, gclid: r.gclid,
      utm_source: r.utmSource, utm_medium: r.utmMedium, utm_campaign: r.utmCampaign, device: r.device,
      tags_google_ads_conversion: r.tagsGoogleAdsConversion, tags_repeat: r.tagsRepeat, caller_hash: r.callerHash,
    }));
    await c.query(UPSERT_CTM_CALLS, [clientId, at, JSON.stringify(payload)]);
  }
}

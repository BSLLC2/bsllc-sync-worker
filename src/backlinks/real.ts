/**
 * The one door to DataForSEO's backlinks API. It reuses the credentials the research runner and the rank pull
 * already hold, passed in by the command that reads them, and makes POST calls only. A message carries no password.
 * Retries a 5xx and the provider's own temporary errors; nothing else.
 */
import { safeMessage } from "../page-behaviour/http.js";
import type { DfsAnswer, DfsCall } from "./types.js";

const BASE = "https://api.dataforseo.com/v3";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function realCall(creds: { login: string; password: string }, fetchImpl: typeof fetch = fetch, wait: (ms: number) => Promise<void> = sleep): DfsCall {
  const auth = "Basic " + Buffer.from(`${creds.login}:${creds.password}`).toString("base64");
  const secrets = [creds.password, auth];
  return async (path: string, body: unknown[]): Promise<DfsAnswer> => {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetchImpl(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: auth }, body: JSON.stringify(body), signal: AbortSignal.timeout(100_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
        const j: any = await res.json();
        const t = j?.tasks?.[0];
        if (!t || t.status_code !== 20000) throw new Error(`${path}: ${t?.status_code ?? "no task"} ${String(t?.status_message ?? "").slice(0, 120)}`);
        return { result: t.result, cost: typeof t.cost === "number" ? t.cost : typeof j?.cost === "number" ? j.cost : 0 };
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        if (!/HTTP 5|40101|50000|timeout|aborted|fetch failed/i.test(m) || attempt >= 2) throw new Error(safeMessage(e, secrets));
        await wait(3000 * (attempt + 1));
      }
    }
  };
}

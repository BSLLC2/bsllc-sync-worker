/**
 * A small DataForSEO Backlinks client with an injectable `fetch`, so the guard can stand a pretend server in for the real one.
 * Auth, base URL and the task envelope follow src/dataforseo.ts and src/dpg-backlinks.ts, which the owner has run live. It counts what
 * each call cost from the response's own `cost` field and stops before a call that would pass the cap.
 *
 * EVERY ENDPOINT NAME AND FIELD IN read.ts IS WRITTEN FROM MEMORY OF THE PUBLISHED REFERENCE AND MARKED UNVERIFIED LIVE where it was not
 * already used by src/dpg-backlinks.ts.
 */
export type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<any> }>;

export const DFS_BASE = "https://api.dataforseo.com/v3";

export class CapReached extends Error {
  constructor(public readonly spent: number, public readonly cap: number) { super(`the spend cap of $${cap.toFixed(2)} was reached after $${spent.toFixed(2)}`); }
}

export interface DfsLike {
  /** POST one task to a Backlinks endpoint and return its `result` array. `expectRows` is the most rows the call can return, for the cap check. */
  task(path: string, body: unknown, expectRows: number): Promise<any[]>;
  readonly spent: number;
  readonly calls: number;
}

/** Rough prices, OURS AND UNVERIFIED LIVE: a request has a base cost and each returned row a little more. The real cost is read from each response. */
export const CALL_BASE_USD = 0.02;
export const ROW_USD = 0.00003;
export const estimateCall = (rows: number): number => CALL_BASE_USD + rows * ROW_USD;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function makeDfs(creds: { login: string; password: string }, o: { fetch: Fetcher; capUsd: number; base?: string; retryMs?: number }): DfsLike {
  const auth = "Basic " + Buffer.from(`${creds.login}:${creds.password}`).toString("base64");
  const state = { spent: 0, calls: 0, last: 0 };
  return {
    get spent() { return state.spent; },
    get calls() { return state.calls; },
    async task(path, body, expectRows) {
      if (state.spent + Math.max(estimateCall(expectRows), state.last) > o.capUsd) throw new CapReached(state.spent, o.capUsd);
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await o.fetch(`${o.base ?? DFS_BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: auth }, body: JSON.stringify(body) });
          if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
          const j: any = await res.json();
          const cost = typeof j?.cost === "number" && Number.isFinite(j.cost) ? j.cost : estimateCall(expectRows);
          state.calls += 1; state.spent += cost; state.last = cost;
          const t = j?.tasks?.[0];
          if (!t || t.status_code !== 20000) throw new Error(`${path}: ${t?.status_code ?? "no task"} ${String(t?.status_message ?? "").slice(0, 80)}`);
          return Array.isArray(t.result) ? t.result : [];
        } catch (e) {
          if (e instanceof CapReached || attempt >= 2 || !/HTTP 5|40101|50000/.test(String(e))) throw e;
          await sleep((o.retryMs ?? 3000) * (attempt + 1));
        }
      }
    },
  };
}

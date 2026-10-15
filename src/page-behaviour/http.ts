import type { FetchLike } from "./types.js";

/** An answer that was not OK, with the body so a caller can tell one 400 from another. */
export class HttpError extends Error {
  constructor(public status: number, public body: string, what: string) {
    super(`${what} → ${status} ${body.slice(0, 300)}`);
  }
}

/** The real thing. Node's fetch has the shape FetchLike asks for. */
export const realFetch: FetchLike = (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>;

export async function postJson(f: FetchLike, url: string, headers: Record<string, string>, body: unknown, what: string): Promise<unknown> {
  const res = await f(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, text, what);
  try { return JSON.parse(text); } catch { throw new HttpError(res.status, text, `${what} (not JSON)`); }
}

export async function getJson(f: FetchLike, url: string, headers: Record<string, string>, what: string): Promise<unknown> {
  const res = await f(url, { method: "GET", headers });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, text, what);
  try { return JSON.parse(text); } catch { throw new HttpError(res.status, text, `${what} (not JSON)`); }
}

/** Never put a key, a token or a long body in a message that is stored or printed. */
export function safeMessage(e: unknown, secrets: readonly (string | undefined)[] = []): string {
  let m = e instanceof Error ? e.message : String(e);
  for (const s of secrets) if (s && s.length > 4) m = m.split(s).join("[secret]");
  m = m.replace(/([?&](?:key|token|access_token|apikey|apiKey)=)[^&\s]+/gi, "$1[secret]");
  return m.length > 240 ? `${m.slice(0, 237)}...` : m;
}

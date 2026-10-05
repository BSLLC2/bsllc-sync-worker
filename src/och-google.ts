/**
 * The one door from the OCH sheet jobs to Google. A token for a scope, the base
 * address of the Sheets and Drive APIs, and a fetch that retries what is worth
 * retrying. Nothing here knows about OCH's board.
 *
 * WHY ONE DOOR. Four jobs read or write the sheet and each had its own copy of
 * "mint a token, call Sheets". Only one of the four retried a 5xx, so a
 * ten-second Google hiccup failed the import and not the upload, and nothing
 * could be run against a pretend Google because the address was typed into each.
 *
 * THE TEST SEAM. When GOOGLE_FAKE_BASE is set (and only then) every call goes to
 * that address instead of Google, and a token is asked of `<base>/token` the way
 * Google's token endpoint is asked, so a refusal arrives in the shape the real
 * library throws it. That is how src/verify-och-e2e.ts runs the REAL importer and
 * the REAL check against a Google that can be told to revoke a key, rename a tab
 * or fail for a minute. No workflow sets it, and verify-och-sheet fails if one does.
 */
import { JWT } from "google-auth-library";

export const fakeBase = (): string | null => process.env.GOOGLE_FAKE_BASE?.trim() || null;
export const sheetsBase = (): string => (fakeBase() ? `${fakeBase()}/v4/spreadsheets` : "https://sheets.googleapis.com/v4/spreadsheets");
export const driveBase = (): string => (fakeBase() ? `${fakeBase()}/drive/v3/files` : "https://www.googleapis.com/drive/v3/files");

export interface KeyFile { client_email?: string; private_key?: string }

/** A token for one scope. THROWS when Google refuses the key, in the shape the library throws. */
export async function accessToken(sa: KeyFile, scope: string): Promise<string | null> {
  const fake = fakeBase();
  if (fake) {
    const res = await fetch(`${fake}/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope, email: sa.client_email }) });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string; error_description?: string } | null;
      throw Object.assign(new Error(`${data?.error ?? res.status}: ${data?.error_description ?? "token refused"}`), { response: { status: res.status, data } });
    }
    return ((await res.json()) as { access_token?: string }).access_token ?? null;
  }
  const { token } = await new JWT({ email: sa.client_email, key: sa.private_key, scopes: [scope] }).getAccessToken();
  return token ?? null;
}

/** Milliseconds before retry n (0-based). Tests shorten it with GOOGLE_RETRY_MS. */
export const retryDelayMs = (n: number): number => (Number(process.env.GOOGLE_RETRY_MS) >= 0 && process.env.GOOGLE_RETRY_MS !== undefined ? Number(process.env.GOOGLE_RETRY_MS) : 5000) * (n + 1);

/**
 * fetch, retried up to `tries` times on a 429, a 5xx or a dropped connection.
 * A 4xx is an answer and is returned at once. Only reads are retried: a write
 * that may have landed is not sent twice. Returns the last response, or throws
 * the last network error if there never was one.
 */
export async function sheetsFetch(url: string, init: RequestInit & { method?: string }, tries = 4): Promise<Response> {
  const canRetry = (init.method ?? "GET").toUpperCase() === "GET";
  let lastErr: unknown = null;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, init);
      if ((res.status === 429 || res.status >= 500) && canRetry && attempt < tries - 1) {
        console.warn(`Google answered ${res.status} for ${url.replace(/\?.*$/, "").slice(-60)}; retrying in ${Math.round(retryDelayMs(attempt) / 1000)}s`);
        await new Promise((r) => setTimeout(r, retryDelayMs(attempt)));
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (!canRetry || attempt >= tries - 1) throw e;
      console.warn(`Google did not answer; retrying in ${Math.round(retryDelayMs(attempt) / 1000)}s`);
      await new Promise((r) => setTimeout(r, retryDelayMs(attempt)));
    }
  }
  // unreachable, but keeps the type honest
  // eslint-disable-next-line no-unreachable
  throw lastErr;
}

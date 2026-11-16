/**
 * One way to turn whatever was thrown into a short, single-line, safe string.
 *
 * WHY (2026-11-16): the google-ads-api client throws plain objects (a
 * GoogleAdsFailure with an `errors` array), not Errors, so `String(e)` and
 * `e.message` printed `failed: [object Object]` for every account in a run and
 * the reason was lost. Other clients throw strings, gaxios/axios errors with a
 * `response`, or gRPC status objects. This file reads all of them.
 *
 * What it promises:
 *   - never "[object Object]", never "undefined", never an empty string
 *   - one line (whitespace collapsed), cut to `max` characters
 *   - secrets, tokens and addresses scrubbed: bearer and OAuth tokens, API keys
 *     and key=value secrets, long opaque strings, and email addresses. The one
 *     exception is a service account address (*.iam.gserviceaccount.com): it is
 *     not a secret and the fix for an access refusal is to share with it
 *   - what a person needs to act: Google's error code(s), its message and the
 *     request id (the id Google asks for when you raise a case)
 *
 * Pure: no database, no clock, no network.
 */

const SERVICE_ACCOUNT_ADDRESS = /\.iam\.gserviceaccount\.com$/i;

export function scrubSecrets(text: string): string {
  return text
    // Authorization headers and bearer tokens
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [secret]")
    // Google OAuth access and refresh tokens, and JWTs
    .replace(/\bya29\.[A-Za-z0-9._-]{10,}/g, "[secret]")
    .replace(/\b1\/\/[A-Za-z0-9._-]{20,}/g, "[secret]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, "[secret]")
    // key=value and "key": "value" for anything that names a secret
    .replace(
      /\b(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|token|client[_-]?secret|secret|password|developer[_-]?token|private[_-]?key|authorization)(["']?\s*[:=]\s*["']?)([^\s"'&,;)}\]]{4,})/gi,
      "$1$2[secret]",
    )
    // A PEM block
    .replace(/-----BEGIN [A-Z ]+-----[\s\S]*?(-----END [A-Z ]+-----|$)/g, "[secret]")
    // Email addresses, except a service account's
    .replace(/[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}/g, (m) => (SERVICE_ACCOUNT_ADDRESS.test(m) ? m : "[email]"))
    // Long opaque strings (keys, ids that are really tokens): 32+ of base64url or hex
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, (m) => (/^[a-z]+$/i.test(m) ? m : "[secret]"));
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

function codeText(code: unknown): string {
  if (code == null) return "";
  if (typeof code === "string" || typeof code === "number") return String(code);
  if (typeof code === "object") {
    return Object.entries(code as Record<string, unknown>)
      .filter(([, v]) => v != null && v !== "")
      .map(([k, v]) => `${k}=${typeof v === "object" ? "?" : String(v)}`)
      .join(",");
  }
  return "";
}

function fromFailure(e: Record<string, unknown>): string | null {
  const errs = e.errors;
  if (!Array.isArray(errs) || errs.length === 0) return null;
  const parts = errs
    .slice(0, 3)
    .map((x) => {
      const o = (x && typeof x === "object" ? x : { message: String(x) }) as Record<string, unknown>;
      const code = codeText(o.error_code ?? o.errorCode ?? o.code);
      const msg = typeof o.message === "string" ? o.message : "";
      return [code, msg].filter(Boolean).join(" ");
    })
    .filter(Boolean);
  if (parts.length === 0) return null;
  const more = errs.length > 3 ? ` (+${errs.length - 3} more)` : "";
  const req = e.request_id ?? e.requestId;
  return `${parts.join(" | ")}${more}${typeof req === "string" && req ? ` [request ${req}]` : ""}`;
}

/** An HTTP client error: the answer's own error message wins over "Request failed with status code 400". */
function fromResponse(e: Record<string, unknown>): string | null {
  const res = e.response as Record<string, unknown> | undefined;
  if (!res || typeof res !== "object") return null;
  const status = res.status ?? res.statusCode;
  const data = res.data as unknown;
  let inner: string | null = null;
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    const err = (d.error && typeof d.error === "object" ? d.error : d) as Record<string, unknown>;
    const failure = Array.isArray((err as { details?: unknown[] }).details)
      ? ((err as { details: unknown[] }).details.find((x) => x && typeof x === "object" && Array.isArray((x as Record<string, unknown>).errors)) as Record<string, unknown> | undefined)
      : undefined;
    inner = (failure && fromFailure(failure)) ?? (typeof err.message === "string" ? `${typeof err.status === "string" ? err.status + " " : ""}${err.message}` : null);
  } else if (typeof data === "string" && data.trim()) {
    inner = data.trim().startsWith("<") ? "an HTML page was returned instead of data" : data;
  }
  if (!inner && status == null) return null;
  return `${status != null ? `HTTP ${String(status)} ` : ""}${inner ?? ""}`.trim();
}

function safeJson(value: unknown): string | null {
  const seen = new WeakSet<object>();
  try {
    const out = JSON.stringify(value, (_k, v) => {
      if (typeof v === "bigint") return v.toString();
      if (v && typeof v === "object") {
        if (seen.has(v as object)) return "[circular]";
        seen.add(v as object);
      }
      return v;
    });
    return out && out !== "{}" && out !== "[]" ? out : null;
  } catch {
    return null;
  }
}

function raw(e: unknown): string {
  if (typeof e === "string") return e;
  if (e == null) return "an unknown error (nothing was thrown with it)";
  if (typeof e === "number" || typeof e === "boolean" || typeof e === "bigint") return String(e);
  if (typeof e === "object") {
    const o = e as Record<string, unknown>;
    const failure = fromFailure(o);
    if (failure) return failure;
    const http = fromResponse(o);
    if (http && !(e instanceof Error && e.message && !/^Request failed with status code/i.test(e.message))) return http;
    if (e instanceof Error) {
      const cause = (e as { cause?: unknown }).cause;
      const base = e.message || e.name || "Error";
      if (cause && cause !== e && base.length < 40) return `${base}: ${raw(cause)}`;
      return base;
    }
    // gRPC status: { code, details, message }
    if (typeof o.details === "string" && o.details) return `${o.code != null ? `code ${String(o.code)} ` : ""}${o.details}`;
    if (typeof o.message === "string" && o.message) return o.message;
    if (typeof o.error === "string" && o.error) return typeof o.error_description === "string" ? `${o.error}: ${o.error_description}` : o.error;
    if (o.error && typeof o.error === "object") return raw(o.error);
    const json = safeJson(e);
    return json ?? "an error with no message";
  }
  return "an unknown error";
}

export function describeError(e: unknown, max = 400): string {
  let text: string;
  try {
    text = raw(e);
  } catch {
    text = "an error that could not be read";
  }
  text = oneLine(scrubSecrets(text));
  if (!text || text === "[object Object]" || text === "undefined" || text === "null") text = "an error with no message";
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

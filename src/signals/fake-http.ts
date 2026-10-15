/**
 * A pretend server for the guards: a real HTTP server on a local port that the
 * readers' real fetch talks to, through SIGNALS_FAKE_BASE. It records every call
 * (method, path, headers, body) so a guard can assert exactly what was asked, and it
 * answers the Google token route by default. Used by the verify scripts only; no
 * reader imports it.
 *
 * EVERY ANSWER A GUARD GIVES IT IS INVENTED.
 */
import http from "node:http";

export interface Call { method: string; path: string; headers: http.IncomingHttpHeaders; body: string }
export interface Reply { status?: number; body?: unknown; headers?: Record<string, string> }
export type Handler = (c: Call) => Reply | undefined;

export async function startFake(handler: Handler): Promise<{ base: string; calls: Call[]; close: () => Promise<void> }> {
  const calls: Call[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", () => {
      const call: Call = { method: req.method ?? "GET", path: req.url ?? "/", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      calls.push(call);
      let reply = handler(call);
      if (!reply && call.path === "/token") reply = { body: { access_token: "fake-token" } };
      const r = reply ?? { status: 599, body: "no route" };
      res.writeHead(r.status ?? 200, { "content-type": typeof r.body === "string" ? "text/plain" : "application/json", ...(r.headers ?? {}) });
      res.end(typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); }),
  };
}

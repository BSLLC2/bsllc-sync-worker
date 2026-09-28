#!/usr/bin/env tsx
/**
 * Guard for the body half of the Gmail import.
 *
 * No mailbox, no credential, no network: it drives the real functions over
 * fixtures. EVERY ADDRESS, SUBJECT, FILENAME AND MESSAGE BELOW IS INVENTED.
 * There is no Gmail access in this sandbox, so nothing here was measured.
 *
 * WHY IT EXISTS. This file used to fetch `format=metadata`, which returns no
 * body at all, so the dashboard could only ever keep Gmail's ~200-character
 * snippet and "open email" on a CRM timeline had to be a link out to Gmail.
 * It fetches `format=full` now. The refusals are the deliverable:
 *
 *   • an ATTACHMENT is counted and never read — not its bytes, not its name
 *     as body text. `format=full` does not return attachment content and this
 *     file must never make the separate call that would;
 *   • the FIRST text part of each type wins, because a multipart/alternative
 *     lists the same words twice and a forwarded chain nests more of them;
 *   • a payload with no body at all comes back as nulls, so the dashboard
 *     behaves exactly as it did before bodies existed;
 *   • depth is bounded, so a malformed payload cannot spin.
 *
 * Each has a planted failure beside it so the check is shown to bite.
 *
 *   npx tsx src/verify-email-body.ts
 */
import { readFileSync } from "node:fs";
import { extractBody, decodeBody, toFetched } from "./import-email.js";

let failures = 0;
const ok = (label: string, pass: boolean, detail = "") => {
  console.log(`  ${pass ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures += 1;
};
const hr = (t: string) => console.log(`\n${t}\n${"─".repeat(72)}`);

/** Gmail hands body data back as base64url. */
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
const textPart = (s: string) => ({ mimeType: "text/plain", body: { data: b64(s), size: s.length } });
const htmlPart = (s: string) => ({ mimeType: "text/html", body: { data: b64(s), size: s.length } });
const filePart = (filename: string) => ({
  mimeType: "application/pdf", filename, body: { attachmentId: "INVENTED-ATTACHMENT-ID", size: 4096 },
});

console.log("Gmail body extraction — verification harness");
console.log("Nothing is fetched. Every message below is invented.\n");

// ── 1. The two body parts come out, decoded ────────────────────────────────
hr("1. A multipart/alternative gives up both halves");
{
  const payload = {
    mimeType: "multipart/alternative",
    parts: [textPart("Morning — notes before Friday."), htmlPart("<p>Morning — notes before Friday.</p>")],
  };
  const got = extractBody(payload);
  ok("the text/plain part is decoded", got.bodyText === "Morning — notes before Friday.", JSON.stringify(got.bodyText));
  ok("the text/html part is decoded", got.bodyHtml === "<p>Morning — notes before Friday.</p>");
  ok("nothing is counted as an attachment", got.attachmentCount === 0);
  // Planted: a walker that read only the top-level payload would find neither.
  const planted = extractBody({ mimeType: "multipart/alternative" });
  ok("PLANTED — a payload whose parts are missing yields nulls, not a crash", planted.bodyText === null && planted.bodyHtml === null);
}

// ── 2. A simple message with no parts at all ───────────────────────────────
hr("2. A plain message carries its body on the payload itself");
{
  const got = extractBody({ mimeType: "text/plain", body: { data: b64("Just a line.") } });
  ok("the body is read off the root part", got.bodyText === "Just a line.");
  ok("there is no HTML half and it is null, not empty", got.bodyHtml === null);
}

// ── 3. ATTACHMENTS ARE COUNTED AND NEVER READ ──────────────────────────────
hr("3. An attachment is a count, never content");
{
  const payload = {
    mimeType: "multipart/mixed",
    parts: [
      { mimeType: "multipart/alternative", parts: [textPart("Invoice attached."), htmlPart("<p>Invoice attached.</p>")] },
      filePart("invented-invoice.pdf"),
      filePart("invented-photo.jpg"),
    ],
  };
  const got = extractBody(payload);
  ok("both files are counted", got.attachmentCount === 2, String(got.attachmentCount));
  ok("the body is the words, not a filename", got.bodyText === "Invoice attached.");
  const asJson = JSON.stringify(got);
  ok("no filename reached the emitted body", !asJson.includes("invented-invoice.pdf"));
  ok("no attachment id reached the emitted body", !asJson.includes("INVENTED-ATTACHMENT-ID"));
  // Planted: an attachment part that was READ instead of counted would put
  // its (undecodable) data or its name into the body.
  const plantedWrong = { mimeType: "text/plain", filename: "invented-note.txt", body: { data: b64("secret file text"), attachmentId: "X" } };
  const planted = extractBody(plantedWrong);
  ok("PLANTED — a text part WITH a filename is an attachment, so it is not read", planted.bodyText === null && planted.attachmentCount === 1);
}

// ── 4. An inline image is a file, not words ────────────────────────────────
hr("4. An inline image is counted like any other file");
{
  const got = extractBody({
    mimeType: "multipart/related",
    parts: [htmlPart('<p>See below</p><img src="cid:logo">'),
            { mimeType: "image/png", body: { attachmentId: "INVENTED-INLINE-ID", size: 900 } }],
  });
  ok("it is counted", got.attachmentCount === 1);
  ok("its bytes are nowhere", !JSON.stringify(got).includes("INVENTED-INLINE-ID"));
}

// ── 5. THE FIRST PART OF EACH TYPE WINS ────────────────────────────────────
hr("5. One reading of the words, not several");
{
  const got = extractBody({
    mimeType: "multipart/mixed",
    parts: [
      textPart("The reply."),
      { mimeType: "message/rfc822", parts: [textPart("The message being forwarded.")] },
    ],
  });
  ok("the outer text wins", got.bodyText === "The reply.", JSON.stringify(got.bodyText));
  ok("the forwarded copy is not appended", !(got.bodyText ?? "").includes("forwarded"));
  // Planted: concatenating every text/plain would print the chain twice.
  const concatenated = "The reply." + "The message being forwarded.";
  ok("PLANTED — a concatenating walker would not equal the first part", got.bodyText !== concatenated);
}

// ── 6. A forwarded message's own body is still reachable ───────────────────
hr("6. A forward with no outer text still gives up the forwarded words");
{
  const got = extractBody({
    mimeType: "multipart/mixed",
    parts: [{ mimeType: "message/rfc822", filename: "", parts: [textPart("Forwarded body.")] }],
  });
  ok("descending past a container finds it", got.bodyText === "Forwarded body.", JSON.stringify(got.bodyText));
}

// ── 7. NOTHING AT ALL IS NULL, NOT AN EMPTY STRING ─────────────────────────
hr("7. Nothing to send is nothing, so the dashboard behaves as before");
{
  const got = extractBody({ mimeType: "multipart/mixed", parts: [filePart("invented.pdf")] });
  ok("no text part means null", got.bodyText === null);
  ok("no html part means null", got.bodyHtml === null);
  ok("the file is still counted", got.attachmentCount === 1);
  ok("an undefined payload is nulls", extractBody(undefined).bodyText === null);
  const empty = extractBody({ mimeType: "text/plain", body: { data: "" } });
  ok("an empty body is null, never an empty email", empty.bodyText === null, JSON.stringify(empty.bodyText));
}

// ── 8. Decoding refuses rather than producing mojibake ─────────────────────
hr("8. Decoding");
{
  ok("base64url is decoded as UTF-8", decodeBody(b64("naïve — £5")) === "naïve — £5");
  ok("nothing decodes to nothing", decodeBody(null) === "" && decodeBody(undefined) === "");
}

// ── 9. Depth is bounded ────────────────────────────────────────────────────
hr("9. A malformed payload cannot spin");
{
  let deep: any = textPart("Bottom.");
  for (let i = 0; i < 60; i++) deep = { mimeType: "multipart/mixed", parts: [deep] };
  const started = Date.now();
  const got = extractBody(deep);
  ok("it returns", Date.now() - started < 2000);
  ok("and past the bound it simply finds nothing rather than recursing forever", got.bodyText === null);
}

// ── 10. The emitted message carries the three fields ───────────────────────
hr("10. What the dashboard is handed");
{
  const msg = toFetched("dana.reyes@bsllc.biz", {
    id: "gm-invented-1",
    threadId: "th-invented-1",
    snippet: "Morning — notes…",
    internalDate: "1758000000000",
    labelIds: ["INBOX"],
    payload: {
      headers: [
        { name: "From", value: "Priya Nandakumar <priya@northgate-invented.example>" },
        { name: "To", value: "dana.reyes@bsllc.biz" },
        { name: "Subject", value: "Website transition plan" },
        { name: "Message-ID", value: "<invented-1@northgate-invented.example>" },
      ],
      mimeType: "multipart/mixed",
      parts: [textPart("The whole message."), filePart("invented-plan.pdf")],
    },
  });
  ok("bodyText is emitted", msg.bodyText === "The whole message.");
  ok("bodyHtml is null where there was none", msg.bodyHtml === null);
  ok("attachmentCount is emitted", msg.attachmentCount === 1);
  ok("the headers the dashboard reads are still there", msg.subject === "Website transition plan" && msg.messageId === "<invented-1@northgate-invented.example>");
  ok("the snippet is still emitted, because the dashboard still stores it", msg.snippet === "Morning — notes…");
}

// ── 11. The fetch asks for the body, and never for an attachment ───────────
hr("11. What is asked of Gmail");
{
  // Comments stripped first: this file's own header EXPLAINS the metadata
  // fetch it replaced and the attachments call it must never make, and a scan
  // that could not tell a paragraph from a call would fire on the explanation.
  const src = readFileSync(new URL("./import-email.ts", import.meta.url).pathname, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  ok("messages.get asks for format=full", /messages\/\$\{id\}\?format=full/.test(src));
  ok("it no longer asks for format=metadata", !/format=metadata/.test(src));
  ok("nothing here fetches attachment content", !/attachments\/|messages\.attachments/.test(src));
  ok("the scope is still read-only", /gmail\.readonly/.test(src) && !/gmail\.modify|mail\.google\.com\/"/.test(src));
}

console.log(`\n${failures === 0 ? "✅ All checks passed." : `❌ ${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);

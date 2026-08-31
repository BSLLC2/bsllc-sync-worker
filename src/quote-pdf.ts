import PDFDocument from "pdfkit";

/**
 * The signed contract PDF — attached to the invoice(s) it bills so the
 * client (and BS LLC's own accounting/legal records) have the actual signed
 * terms alongside the bill, not just a bare line-item summary. Renders the
 * full picture an accounting department would need to audit the charge:
 * itemized lines with real descriptions, the payment plan, scope of work
 * and contract language as agreed, and the e-signature record itself
 * (signer, timestamp, IP, which Terms & Conditions version was in force) —
 * everything already captured on pricing_quotes at signature time (see
 * signQuote in the app's storage.ts), just not previously surfaced here.
 */
export interface QuotePdfLine { name: string; description: string | null; qty: number; unitPriceCents: number; monthly: boolean }
export interface QuotePdfData {
  quoteNumber: string | null;
  clientName: string;
  companyName: string | null;
  lines: QuotePdfLine[];
  comments: string | null;
  sowText: string | null;
  contractText: string | null;
  paymentTerms: string | null;
  paymentMonths: number | null;
  depositCents: number | null;
  depositType: string | null; // 'fixed' | 'percent'
  depositPercent: number | null;
  retainerTermMonths: number | null;
  signedName: string | null;
  signedEmail: string | null;
  signedAt: string | null; // ISO
  signedIp: string | null;
  acceptedPriceCents: number | null;
  termsLabel: string | null; // e.g. "v1.2" — null if no terms version was on file
}

const INK = "#2D2A26";
const MUTED = "#6C665C";
const LINE = "#E4E0D5";
const ACCENT = "#0000FF";

const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// The bull mark lives in the app repo (client/public/icon-512.png); fetched
// once per process run rather than duplicating the binary asset across
// repos. Best-effort -- a network hiccup drops the mark, never the PDF.
let logoCache: Buffer | null | undefined;
async function fetchLogo(): Promise<Buffer | null> {
  if (logoCache !== undefined) return logoCache;
  try {
    const base = (process.env.DASHBOARD_URL?.trim() || "https://work.bsllc.biz").replace(/\/+$/, "");
    const res = await fetch(`${base}/icon-512.png`);
    if (!res.ok) throw new Error(String(res.status));
    logoCache = Buffer.from(await res.arrayBuffer());
  } catch {
    logoCache = null;
  }
  return logoCache;
}

function depositLine(data: QuotePdfData, oneTimeTotalCents: number): string | null {
  if (data.depositType === "percent" && data.depositPercent) {
    return `${data.depositPercent}% deposit due upfront (${usd(Math.round(oneTimeTotalCents * (data.depositPercent / 100)))}).`;
  }
  if (data.depositCents) return `${usd(data.depositCents)} deposit due upfront.`;
  return null;
}

export async function buildQuotePdf(data: QuotePdfData): Promise<Buffer> {
  const logo = await fetchLogo();
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 56 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const rule = () => {
      doc.moveDown(0.4);
      doc.strokeColor(LINE).lineWidth(1).moveTo(doc.x, doc.y).lineTo(doc.x + pageWidth, doc.y).stroke();
      doc.moveDown(0.6);
    };
    const heading = (text: string) => {
      doc.fontSize(10.5).fillColor(MUTED).font("Helvetica-Bold").text(text.toUpperCase(), { characterSpacing: 0.6 });
      doc.moveDown(0.35);
      doc.font("Helvetica");
    };

    // ── Header: bull mark + wordmark + quote number ──
    const headerTop = doc.y;
    if (logo) doc.image(logo, doc.x, headerTop, { width: 34, height: 34 });
    doc.fontSize(20).fillColor(INK).font("Helvetica-Bold").text("BS LLC", doc.x + (logo ? 44 : 0), headerTop + 2);
    doc.fontSize(11).fillColor(MUTED).font("Helvetica").text(
      `Signed Contract${data.quoteNumber ? ` — ${data.quoteNumber}` : ""}`,
      doc.x + (logo ? 44 : 0),
      headerTop + 26,
    );
    doc.y = headerTop + 48;
    doc.x = doc.page.margins.left;
    rule();

    // ── Client / signature summary ──
    doc.fontSize(11).fillColor(INK);
    doc.font("Helvetica-Bold").text(data.clientName, { continued: false });
    if (data.companyName && data.companyName !== data.clientName) doc.font("Helvetica").fillColor(MUTED).fontSize(10).text(data.companyName);
    doc.moveDown(0.5);
    doc.font("Helvetica").fontSize(10.5).fillColor(INK);
    if (data.signedAt) doc.text(`Signed ${new Date(data.signedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}`);
    if (data.signedName) doc.text(`By ${data.signedName}${data.signedEmail ? ` (${data.signedEmail})` : ""}`);
    rule();

    // ── Line items ──
    heading("Line items");
    let oneTimeTotal = 0, monthlyTotal = 0;
    for (const line of data.lines) {
      const amount = (line.unitPriceCents * line.qty) / 100;
      if (line.monthly) monthlyTotal += amount; else oneTimeTotal += amount;
      const qtyNote = line.qty > 1 ? ` × ${line.qty}` : "";
      doc.font("Helvetica-Bold").fontSize(10.5).fillColor(INK).text(`${line.name}${qtyNote}${line.monthly ? " (monthly)" : ""}`, { continued: true, width: pageWidth - 70 });
      doc.font("Helvetica-Bold").text(`  ${usd(Math.round(amount * 100))}`, { align: "right" });
      if (line.description) {
        doc.font("Helvetica").fontSize(9.5).fillColor(MUTED).text(line.description, { width: pageWidth - 10 });
      }
      doc.moveDown(0.35);
    }
    doc.moveDown(0.2);
    if (oneTimeTotal > 0) {
      doc.font("Helvetica-Bold").fontSize(10.5).fillColor(INK).text(`One-time total: ${usd(Math.round(oneTimeTotal * 100))}`, { align: "right" });
    }
    if (monthlyTotal > 0) {
      doc.font("Helvetica-Bold").fontSize(10.5).fillColor(INK).text(`Monthly: ${usd(Math.round(monthlyTotal * 100))}/mo${data.retainerTermMonths ? ` for ${data.retainerTermMonths} months` : ""}`, { align: "right" });
    }
    if (data.acceptedPriceCents != null) {
      doc.font("Helvetica-Bold").fontSize(11).fillColor(ACCENT).text(`Accepted total: ${usd(data.acceptedPriceCents)}`, { align: "right" });
    }
    rule();

    // ── Payment terms ──
    const deposit = depositLine(data, Math.round(oneTimeTotal * 100));
    if (data.paymentTerms || data.paymentMonths || deposit) {
      heading("Payment terms");
      doc.font("Helvetica").fontSize(10).fillColor(INK);
      if (data.paymentTerms) doc.text(data.paymentTerms);
      if (data.paymentMonths && data.paymentMonths > 1) doc.text(`One-time total spread over ${data.paymentMonths} months.`);
      if (deposit) doc.text(deposit);
      rule();
    }

    // ── Scope of work ──
    if (data.sowText) {
      heading("Scope of work");
      doc.font("Helvetica").fontSize(10).fillColor(INK).text(data.sowText, { width: pageWidth });
      rule();
    }

    // ── Contract terms ──
    if (data.contractText) {
      heading("Contract terms");
      doc.font("Helvetica").fontSize(10).fillColor(INK).text(data.contractText, { width: pageWidth });
      rule();
    }

    if (data.comments) {
      heading("Notes");
      doc.font("Helvetica").fontSize(10).fillColor(INK).text(data.comments, { width: pageWidth });
      rule();
    }

    // ── E-signature record ──
    heading("Electronic signature record");
    doc.font("Helvetica").fontSize(9).fillColor(MUTED);
    const parts = [
      data.signedName ? `Signed by ${data.signedName}${data.signedEmail ? ` <${data.signedEmail}>` : ""}` : null,
      data.signedAt ? `on ${new Date(data.signedAt).toLocaleString("en-US", { dateStyle: "full", timeStyle: "long" })}` : null,
      data.signedIp ? `from IP ${data.signedIp}` : null,
    ].filter(Boolean);
    if (parts.length) doc.text(parts.join(", ") + ".");
    doc.text(
      `This is a legally binding electronic signature under the U.S. E-SIGN Act and applicable UETA.${data.termsLabel ? ` Signer agreed to BS LLC's Terms & Conditions, version ${data.termsLabel}.` : ""}`,
    );

    doc.end();
  });
}

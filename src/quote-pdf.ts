import PDFDocument from "pdfkit";

/**
 * A simple, no-frills PDF of a signed quote — attached to the invoice(s) it
 * bills so the client (and BS LLC's own records) always have the signed
 * terms alongside the bill. Not a replica of the branded /quote/:token page;
 * just the line items, total, and signature record in a portable form.
 */
export interface QuotePdfLine { name: string; amount: number; monthly: boolean }
export interface QuotePdfData {
  quoteNumber: string | null;
  clientName: string;
  lines: QuotePdfLine[];
  signedName: string | null;
  signedEmail: string | null;
  signedAt: string | null; // ISO
}

export async function buildQuotePdf(data: QuotePdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 54 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(18).fillColor("#111").text("BS LLC");
    doc.fontSize(11).fillColor("#666").text(`Signed Quote${data.quoteNumber ? ` — ${data.quoteNumber}` : ""}`);
    doc.moveDown(1);

    doc.fillColor("#111").fontSize(11);
    doc.text(`Client: ${data.clientName}`);
    if (data.signedAt) doc.text(`Signed: ${new Date(data.signedAt).toLocaleString("en-US")}`);
    if (data.signedName) doc.text(`Signed by: ${data.signedName}${data.signedEmail ? ` (${data.signedEmail})` : ""}`);
    doc.moveDown(1);

    doc.fontSize(12).text("Line items", { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(11);
    let total = 0;
    for (const line of data.lines) {
      total += line.amount;
      doc.text(`${line.name}${line.monthly ? " (monthly)" : ""} — $${line.amount.toFixed(2)}`);
    }
    doc.moveDown(0.5);
    doc.fontSize(12).text(`Total: $${total.toFixed(2)}`);

    doc.end();
  });
}

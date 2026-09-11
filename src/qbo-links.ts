/**
 * Deep links into the QuickBooks Online web app, per record type.
 *
 * URL shape (Intuit's own app routes, confirmed against the QBO UI and the
 * links the existing dashboard already uses for invoices):
 *   https://app.qbo.intuit.com/app/<route>?txnId=<Id>        transactions
 *   https://app.qbo.intuit.com/app/customerdetail?nameId=<Id> customer
 *   https://app.qbo.intuit.com/app/vendordetail?nameId=<Id>   vendor
 *   https://app.qbo.intuit.com/app/register?accountId=<Id>    account register
 *
 * The host "qbo.intuit.com" also resolves (it redirects to app.qbo.intuit.com)
 * — the dashboard's Financials page already uses that form for invoices.
 * The <route> depends on the transaction type as QBO REPORTS it (the txn_type
 * column in the General Ledger / Transaction List reports), which is why the
 * map below is keyed on those report labels rather than API entity names.
 * A type not in the map falls back to a search page — never a broken link.
 */
const ROUTE_BY_REPORT_TYPE: Record<string, string> = {
  "invoice": "invoice",
  "payment": "recvpayment",
  "sales receipt": "salesreceipt",
  "credit memo": "creditmemo",
  "refund": "refundreceipt",
  "refund receipt": "refundreceipt",
  "estimate": "estimate",
  "bill": "bill",
  "bill payment": "billpayment",
  "bill payment (check)": "billpayment",
  "bill payment (credit card)": "billpayment",
  "vendor credit": "vendorcredit",
  "expense": "expense",
  "cash expense": "expense",
  "check": "check",
  "credit card expense": "expense",
  "credit card credit": "creditcardcredit",
  "credit card payment": "cctransfer",
  "journal entry": "journal",
  "journal": "journal",
  "deposit": "deposit",
  "transfer": "transfer",
  "purchase order": "purchaseorder",
  "time activity": "timeactivity",
  "payroll check": "paycheck",
  "inventory qty adjust": "inventoryadjustment",
};
export const QBO_APP = "https://app.qbo.intuit.com/app";

export function qboTxnUrl(reportTxnType: string | null | undefined, txnId: string | null | undefined): string | null {
  if (!txnId) return null;
  const route = ROUTE_BY_REPORT_TYPE[(reportTxnType ?? "").trim().toLowerCase()];
  // Unknown type: QBO's own search page filtered to the id still lands the user
  // one click away instead of on a 404.
  return route ? `${QBO_APP}/${route}?txnId=${encodeURIComponent(txnId)}` : `${QBO_APP}/search?searchText=${encodeURIComponent(txnId)}`;
}
export const qboCustomerUrl = (id: string) => `${QBO_APP}/customerdetail?nameId=${encodeURIComponent(id)}`;
export const qboVendorUrl = (id: string) => `${QBO_APP}/vendordetail?nameId=${encodeURIComponent(id)}`;
export const qboAccountUrl = (id: string) => `${QBO_APP}/register?accountId=${encodeURIComponent(id)}`;

/** Report txn_type → which side of the ledger the "name" column refers to.
 *  Customer and Vendor ids are separate sequences in QBO (Customer 12 and
 *  Vendor 12 can both exist), so the id on a GL line can only be resolved
 *  once we know which entity family the transaction belongs to. */
export function nameSideForTxnType(reportTxnType: string | null | undefined): "customer" | "vendor" | "either" {
  const t = (reportTxnType ?? "").trim().toLowerCase();
  if (["invoice", "payment", "sales receipt", "credit memo", "refund", "refund receipt", "estimate"].includes(t)) return "customer";
  if (["bill", "bill payment", "bill payment (check)", "bill payment (credit card)", "vendor credit", "expense", "cash expense", "check", "credit card expense", "credit card credit", "purchase order"].includes(t)) return "vendor";
  return "either";
}

#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { QboClient, type QboReport, type QboReportRow, type QboReportCol } from "./qbo.js";
import { qboTxnUrl, nameSideForTxnType } from "./qbo-links.js";

/**
 * QBO depth — the layer under the Financials tab's summary numbers.
 *
 * import-qbo-financials stores five totals per P&L period. Nothing there can
 * be peeled back: no accounts, no customers, no vendors, no transactions.
 * This job pulls the same QuickBooks company (read-only, same OAuth scope)
 * and lands, in Postgres:
 *
 *   qbo_accounts / qbo_vendors / qbo_classes   the dimensions
 *   qbo_pnl_lines     P&L by account per month (trailing 24 months), and by
 *                     customer / class / vendor per month — with QBO's own
 *                     section totals stored beside the lines so the app can
 *                     show whether the parts add to the whole
 *   qbo_transactions  every posted General Ledger line (txn id/type/date,
 *                     account, customer or vendor, class, memo, amount) with
 *                     a deep link into QBO
 *   qbo_aging         AR by customer and AP by vendor in aging buckets, plus
 *                     the report's grand total
 *   qbo_bills         every vendor bill (AP counterpart of qbo_invoices)
 *   qbo_import_runs   one row per run — what range, how many rows, ok/fail —
 *                     so the Financials page can say when and by what each
 *                     panel was last refreshed
 *
 * Idempotent: dimension tables upsert by QBO id; report-derived rows are
 * replaced per (period / date range) inside one transaction, so a re-run
 * never duplicates and a failed pull never leaves a half-written month.
 *
 *   npm run import-qbo-depth                       incremental: current + 2 prior months
 *   npm run import-qbo-depth -- --full             trailing 24 months (weekly, and first run)
 *   npm run import-qbo-depth -- --since=2024-01-01 explicit backfill start
 *   npm run import-qbo-depth -- --dry-run          pull + parse, print counts, write nothing
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }
const arg = (k: string): string | undefined => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3).trim();
const flag = (k: string) => process.argv.includes(`--${k}`);
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const toCents = (v: string | number | null | undefined): number => {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const monthStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
const monthEnd = (d: Date) => new Date(d.getFullYear(), d.getMonth() + 1, 0);
const addMonths = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth() + n, 1);

// ── Schema safety net (the dashboard's ensureSchema is the source of truth; this keeps the worker runnable on a fresh DB) ──
export const DEPTH_DDL = `
CREATE TABLE IF NOT EXISTS qbo_accounts (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, fully_qualified_name TEXT, account_type TEXT, account_sub_type TEXT,
  classification TEXT, parent_id TEXT, active BOOLEAN NOT NULL DEFAULT true, current_balance_cents BIGINT,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS qbo_vendors (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT true, balance_cents BIGINT NOT NULL DEFAULT 0,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS qbo_classes (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, fully_qualified_name TEXT, active BOOLEAN NOT NULL DEFAULT true,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS qbo_pnl_lines (
  period_start TEXT NOT NULL, period_end TEXT NOT NULL,
  dimension TEXT NOT NULL, dimension_id TEXT NOT NULL DEFAULT '', dimension_name TEXT,
  line_type TEXT NOT NULL, account_id TEXT NOT NULL, account_name TEXT, section TEXT,
  amount_cents BIGINT NOT NULL DEFAULT 0, synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (period_start, period_end, dimension, dimension_id, line_type, account_id));
CREATE INDEX IF NOT EXISTS idx_qbo_pnl_lines_account ON qbo_pnl_lines (account_id, period_start);
CREATE INDEX IF NOT EXISTS idx_qbo_pnl_lines_dimension ON qbo_pnl_lines (dimension, dimension_id, period_start);
CREATE TABLE IF NOT EXISTS qbo_transactions (
  id TEXT PRIMARY KEY, txn_id TEXT NOT NULL, txn_type TEXT NOT NULL, txn_date TEXT NOT NULL, doc_number TEXT,
  account_id TEXT, account_name TEXT, name TEXT, name_id TEXT, customer_id TEXT, vendor_id TEXT,
  class_id TEXT, class_name TEXT, memo TEXT, split_account TEXT,
  amount_cents BIGINT NOT NULL DEFAULT 0, qbo_url TEXT, synced_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_qbo_transactions_account_date ON qbo_transactions (account_id, txn_date);
CREATE INDEX IF NOT EXISTS idx_qbo_transactions_date ON qbo_transactions (txn_date);
CREATE INDEX IF NOT EXISTS idx_qbo_transactions_txn ON qbo_transactions (txn_id);
CREATE INDEX IF NOT EXISTS idx_qbo_transactions_vendor ON qbo_transactions (vendor_id);
CREATE INDEX IF NOT EXISTS idx_qbo_transactions_customer ON qbo_transactions (customer_id);
CREATE TABLE IF NOT EXISTS qbo_aging (
  as_of_date TEXT NOT NULL, kind TEXT NOT NULL, entity_id TEXT NOT NULL, entity_name TEXT,
  current_cents BIGINT NOT NULL DEFAULT 0, d1_30_cents BIGINT NOT NULL DEFAULT 0, d31_60_cents BIGINT NOT NULL DEFAULT 0,
  d61_90_cents BIGINT NOT NULL DEFAULT 0, d91_plus_cents BIGINT NOT NULL DEFAULT 0, total_cents BIGINT NOT NULL DEFAULT 0,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (as_of_date, kind, entity_id));
CREATE TABLE IF NOT EXISTS qbo_bills (
  id TEXT PRIMARY KEY, vendor_id TEXT, vendor_name TEXT, doc_number TEXT, txn_date TEXT, due_date TEXT,
  total_cents BIGINT NOT NULL DEFAULT 0, balance_cents BIGINT NOT NULL DEFAULT 0, synced_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_qbo_bills_vendor ON qbo_bills (vendor_id);
CREATE TABLE IF NOT EXISTS qbo_import_runs (
  id TEXT PRIMARY KEY, importer TEXT NOT NULL, started_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ,
  ok BOOLEAN, range_start TEXT, range_end TEXT, stats_json TEXT, note TEXT);
CREATE INDEX IF NOT EXISTS idx_qbo_import_runs_importer ON qbo_import_runs (importer, started_at);
`;

// ── Report parsing ──
interface PnlLine { lineType: "account" | "section"; accountId: string; accountName: string; section: string | null; amounts: number[] }
const SECTION_GROUPS = new Set(["Income", "COGS", "Expenses", "OtherIncome", "OtherExpenses"]);
const COMPUTED_GROUPS = new Set(["GrossProfit", "NetOperatingIncome", "NetOtherIncome", "NetIncome"]);

/** Flattens a P&L report into account lines (one amounts[] per data column,
 *  the Total column dropped) plus one "section" line per QBO section total and
 *  computed total (Gross Profit, Net Income…). A parent account's own postings
 *  ride on its Header row; the Summary row (which includes the children) is
 *  skipped so nothing is counted twice. */
function parsePnl(report: QboReport): { columns: { title: string; key: string | null; start: string | null; end: string | null }[]; lines: PnlLine[] } {
  const cols = (report.Columns?.Column ?? []).slice(1); // first column is the row label
  const hasTotal = cols.length > 0 && /^total$/i.test(cols[cols.length - 1]?.ColTitle ?? "");
  const dataCols = hasTotal ? cols.slice(0, -1) : cols;
  const columns = dataCols.map((c) => {
    const meta = (n: string) => c.MetaData?.find((m) => m.Name === n)?.Value ?? null;
    return { title: c.ColTitle ?? "", key: meta("ColKey"), start: meta("StartDate"), end: meta("EndDate") };
  });
  const amountsOf = (cd?: QboReportCol[]) => dataCols.map((_, i) => toCents(cd?.[i + 1]?.value));
  const lines: PnlLine[] = [];
  const walk = (rows: QboReportRow[] | undefined, section: string | null) => {
    for (const row of rows ?? []) {
      const group = row.group ?? "";
      if (row.type === "Section" || row.Rows || row.Header || row.Summary) {
        const nextSection = SECTION_GROUPS.has(group) ? group : section;
        const head = row.Header?.ColData;
        const headId = head?.[0]?.id;
        if (headId) {
          const amounts = amountsOf(head);
          if (amounts.some((a) => a !== 0)) lines.push({ lineType: "account", accountId: headId, accountName: head?.[0]?.value ?? "", section: nextSection, amounts });
        }
        walk(row.Rows?.Row, nextSection);
        if (SECTION_GROUPS.has(group) || COMPUTED_GROUPS.has(group)) {
          const sum = row.Summary?.ColData;
          if (sum) lines.push({ lineType: "section", accountId: group, accountName: sum[0]?.value ?? group, section: SECTION_GROUPS.has(group) ? group : null, amounts: amountsOf(sum) });
        }
        continue;
      }
      const cd = row.ColData;
      const id = cd?.[0]?.id;
      if (id) lines.push({ lineType: "account", accountId: id, accountName: cd?.[0]?.value ?? "", section, amounts: amountsOf(cd) });
    }
  };
  walk(report.Rows?.Row, null);
  return { columns, lines };
}

interface GlLine { txnId: string; txnType: string; txnDate: string; docNumber: string | null; accountId: string | null; accountName: string | null; name: string | null; nameId: string | null; classId: string | null; className: string | null; memo: string | null; splitAccount: string | null; amountCents: number }
/** Flattens the General Ledger into one row per posted line. Section headers
 *  name the account (nested sections = sub-accounts); "Beginning Balance"
 *  and total rows carry no transaction id and are skipped. Column positions
 *  come from the report's own Columns block, not assumed. */
function parseGeneralLedger(report: QboReport): GlLine[] {
  const cols = report.Columns?.Column ?? [];
  const idx = (type: string, fallback: number) => { const i = cols.findIndex((c) => (c.ColType ?? "").toLowerCase() === type); return i >= 0 ? i : fallback; };
  const I = { date: idx("tx_date", 0), type: idx("txn_type", 1), doc: idx("doc_num", 2), name: idx("name", 3), memo: idx("memo", 4), split: idx("split_acc", 5), klass: idx("klass_name", 6), amount: idx("subt_nat_amount", 7) };
  const out: GlLine[] = [];
  const walk = (rows: QboReportRow[] | undefined, account: { id: string | null; name: string | null }) => {
    for (const row of rows ?? []) {
      if (row.type === "Section" || row.Rows || row.Header) {
        const head = row.Header?.ColData?.[0];
        const next = head?.id ? { id: head.id, name: head.value ?? null } : account;
        walk(row.Rows?.Row, next);
        continue;
      }
      const cd = row.ColData ?? [];
      const txnId = cd[I.type]?.id ?? null;
      const txnType = cd[I.type]?.value ?? "";
      const date = cd[I.date]?.value ?? "";
      if (!txnId || !txnType || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue; // beginning balance / total rows
      out.push({
        txnId, txnType, txnDate: date, docNumber: cd[I.doc]?.value || null,
        accountId: account.id, accountName: account.name,
        name: cd[I.name]?.value || null, nameId: cd[I.name]?.id || null,
        classId: cd[I.klass]?.id || null, className: cd[I.klass]?.value || null,
        memo: cd[I.memo]?.value || null, splitAccount: cd[I.split]?.value || null,
        amountCents: toCents(cd[I.amount]?.value),
      });
    }
  };
  walk(report.Rows?.Row, { id: null, name: null });
  return out;
}

interface AgingRow { entityId: string; entityName: string; buckets: number[]; total: number }
/** Aged receivables / payables: one row per leaf entity plus the report's own
 *  grand total (entityId "__total__") so the app can show whether the rows
 *  add up to what QBO says. Column order is read from the report, so a
 *  company with different aging settings still parses. */
function parseAging(report: QboReport): AgingRow[] {
  const cols = (report.Columns?.Column ?? []).slice(1);
  const bucketIdx = (re: RegExp) => cols.findIndex((c) => re.test(c.ColTitle ?? ""));
  const positions = [bucketIdx(/^current$/i), bucketIdx(/^1\s*-\s*30/i), bucketIdx(/^31\s*-\s*60/i), bucketIdx(/^61\s*-\s*90/i), bucketIdx(/^(91|> ?90|over)/i)];
  const totalIdx = bucketIdx(/^total$/i);
  const valueAt = (cd: QboReportCol[] | undefined, i: number) => (i >= 0 ? toCents(cd?.[i + 1]?.value) : 0);
  const rows: AgingRow[] = [];
  const walk = (list: QboReportRow[] | undefined) => {
    for (const row of list ?? []) {
      if (row.type === "Section" || row.Rows || row.Header) {
        // A parent customer with its own open balance carries it on the header row.
        const head = row.Header?.ColData;
        if (head?.[0]?.id) {
          const buckets = positions.map((i) => valueAt(head, i));
          const total = totalIdx >= 0 ? valueAt(head, totalIdx) : buckets.reduce((s, b) => s + b, 0);
          if (buckets.some((b) => b !== 0) || total !== 0) rows.push({ entityId: head[0]!.id!, entityName: head[0]!.value ?? "", buckets, total });
        }
        walk(row.Rows?.Row);
        if ((row.group ?? "").toLowerCase() === "grandtotal" && row.Summary?.ColData) {
          const s = row.Summary.ColData;
          const buckets = positions.map((i) => valueAt(s, i));
          rows.push({ entityId: "__total__", entityName: "TOTAL", buckets, total: totalIdx >= 0 ? valueAt(s, totalIdx) : buckets.reduce((a, b) => a + b, 0) });
        }
        continue;
      }
      const cd = row.ColData;
      const id = cd?.[0]?.id;
      const buckets = positions.map((i) => valueAt(cd, i));
      const total = totalIdx >= 0 ? valueAt(cd, totalIdx) : buckets.reduce((s, b) => s + b, 0);
      if (id) rows.push({ entityId: id, entityName: cd?.[0]?.value ?? "", buckets, total });
      else if (/^total$/i.test(cd?.[0]?.value ?? "") && !rows.some((r) => r.entityId === "__total__")) rows.push({ entityId: "__total__", entityName: "TOTAL", buckets, total });
    }
  };
  walk(report.Rows?.Row);
  return rows;
}

// ── Main ──
async function main() {
  const dryRun = flag("dry-run");
  const full = flag("full");
  const since = arg("since");
  const today = new Date();
  const todayIso = iso(today);
  // Range: --since wins; --full = trailing 24 months; default = current month + 2 prior.
  const rangeStart = since ? new Date(`${since}T00:00:00`) : full ? addMonths(monthStart(today), -23) : addMonths(monthStart(today), -2);
  if (Number.isNaN(rangeStart.getTime())) throw new Error("--since must be YYYY-MM-DD");
  const months: { start: string; end: string }[] = [];
  for (let d = monthStart(rangeStart); d <= today; d = addMonths(d, 1)) months.push({ start: iso(d), end: iso(monthEnd(d)) });
  const rangeStartIso = months[0]!.start;
  const mode = since ? `since ${since}` : full ? "full (24 months)" : "incremental (3 months)";
  console.log(`import-qbo-depth — ${mode}, ${months.length} month(s) ${rangeStartIso}..${todayIso}${dryRun ? " (dry-run: nothing written)" : ""}`);

  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  const runId = randomUUID();
  const stats: Record<string, number> = {};
  const errors: string[] = [];
  try {
    if (!dryRun) {
      await c.query(DEPTH_DDL);
      await c.query(`INSERT INTO qbo_import_runs (id, importer, started_at, range_start, range_end, note) VALUES ($1, 'qbo_depth', now(), $2, $3, $4)`, [runId, rangeStartIso, todayIso, mode]);
    }
    const qbo = new QboClient(c);
    await qbo.connect();

    // 1. Dimensions — small, full pull every run, upsert by id.
    const [accounts, vendors, classes, bills] = await Promise.all([qbo.getAccounts(), qbo.getVendors(), qbo.getClasses(), qbo.getBills()]);
    stats.accounts = accounts.length; stats.vendors = vendors.length; stats.classes = classes.length; stats.bills = bills.length;
    console.log(`  dimensions: ${accounts.length} account(s), ${vendors.length} vendor(s), ${classes.length} class(es), ${bills.length} bill(s)`);
    if (dryRun) {
      for (const a of accounts.slice(0, 5)) console.log(`    account ${a.id} ${a.fullyQualifiedName ?? a.name} [${a.classification}/${a.accountType}]`);
      for (const v of vendors.slice(0, 3)) console.log(`    vendor ${v.id} ${v.name}`);
      for (const b of bills.slice(0, 3)) console.log(`    bill ${b.id} ${b.vendorName} ${b.txnDate} $${b.totalAmt} (balance $${b.balance})`);
    } else {
      for (const a of accounts) await c.query(
        `INSERT INTO qbo_accounts (id, name, fully_qualified_name, account_type, account_sub_type, classification, parent_id, active, current_balance_cents, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, fully_qualified_name = EXCLUDED.fully_qualified_name, account_type = EXCLUDED.account_type,
           account_sub_type = EXCLUDED.account_sub_type, classification = EXCLUDED.classification, parent_id = EXCLUDED.parent_id, active = EXCLUDED.active,
           current_balance_cents = EXCLUDED.current_balance_cents, synced_at = now()`,
        [a.id, a.name, a.fullyQualifiedName, a.accountType, a.accountSubType, a.classification, a.parentId, a.active, a.currentBalance != null ? Math.round(a.currentBalance * 100) : null]);
      for (const v of vendors) await c.query(
        `INSERT INTO qbo_vendors (id, name, active, balance_cents, synced_at) VALUES ($1,$2,$3,$4, now())
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, active = EXCLUDED.active, balance_cents = EXCLUDED.balance_cents, synced_at = now()`,
        [v.id, v.name, v.active, Math.round(v.balance * 100)]);
      for (const k of classes) await c.query(
        `INSERT INTO qbo_classes (id, name, fully_qualified_name, active, synced_at) VALUES ($1,$2,$3,$4, now())
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, fully_qualified_name = EXCLUDED.fully_qualified_name, active = EXCLUDED.active, synced_at = now()`,
        [k.id, k.name, k.fullyQualifiedName, k.active]);
      for (const b of bills) await c.query(
        `INSERT INTO qbo_bills (id, vendor_id, vendor_name, doc_number, txn_date, due_date, total_cents, balance_cents, synced_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
         ON CONFLICT (id) DO UPDATE SET vendor_id = EXCLUDED.vendor_id, vendor_name = EXCLUDED.vendor_name, doc_number = EXCLUDED.doc_number, txn_date = EXCLUDED.txn_date,
           due_date = EXCLUDED.due_date, total_cents = EXCLUDED.total_cents, balance_cents = EXCLUDED.balance_cents, synced_at = now()`,
        [b.id, b.vendorId, b.vendorName, b.docNumber, b.txnDate, b.dueDate, Math.round(b.totalAmt * 100), Math.round(b.balance * 100)]);
    }
    const customerIds = new Set((await c.query<{ id: string }>(`SELECT id FROM qbo_customers`)).rows.map((r) => r.id));
    const vendorIds = new Set(vendors.map((v) => v.id));
    const vendorNameById = new Map(vendors.map((v) => [v.id, v.name]));
    const customerNameById = new Map((await c.query<{ id: string; name: string }>(`SELECT id, name FROM qbo_customers`)).rows.map((r) => [r.id, r.name]));
    const classesInUse = classes.some((k) => k.active);

    // 2. P&L by account, one column per month, one call for the whole range.
    const writePnl = async (dimension: string, periods: { start: string; end: string }[], rows: { periodStart: string; periodEnd: string; dimensionId: string; dimensionName: string | null; line: PnlLine; amount: number }[]) => {
      if (dryRun) return;
      await c.query("BEGIN");
      try {
        for (const p of periods) await c.query(`DELETE FROM qbo_pnl_lines WHERE dimension = $1 AND period_start = $2 AND period_end = $3`, [dimension, p.start, p.end]);
        for (const r of rows) await c.query(
          `INSERT INTO qbo_pnl_lines (period_start, period_end, dimension, dimension_id, dimension_name, line_type, account_id, account_name, section, amount_cents, synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
           ON CONFLICT (period_start, period_end, dimension, dimension_id, line_type, account_id) DO UPDATE SET amount_cents = qbo_pnl_lines.amount_cents + EXCLUDED.amount_cents, synced_at = now()`,
          [r.periodStart, r.periodEnd, dimension, r.dimensionId, r.dimensionName, r.line.lineType, r.line.accountId, r.line.accountName, r.line.section, r.amount]);
        await c.query("COMMIT");
      } catch (e) { await c.query("ROLLBACK"); throw e; }
    };
    try {
      const report = await qbo.getProfitAndLossBy(rangeStartIso, todayIso, "Month");
      const { columns, lines } = parsePnl(report);
      const rows: Parameters<typeof writePnl>[2] = [];
      const periods: { start: string; end: string }[] = [];
      columns.forEach((col, i) => {
        // Month columns carry StartDate/EndDate metadata; fall back to our own month list by position.
        const m = months[i];
        const start = col.start ?? m?.start; const end = col.end ?? m?.end;
        if (!start || !end) return;
        periods.push({ start, end });
        for (const line of lines) rows.push({ periodStart: start, periodEnd: end, dimensionId: "", dimensionName: null, line, amount: line.amounts[i] ?? 0 });
      });
      await writePnl("total", periods, rows);
      stats.pnlMonthAccountLines = rows.filter((r) => r.line.lineType === "account").length;
      console.log(`  ✓ P&L by month: ${columns.length} month column(s), ${lines.filter((l) => l.lineType === "account").length} account line(s), ${lines.filter((l) => l.lineType === "section").length} section total(s)`);
      if (dryRun) for (const l of lines.slice(0, 8)) console.log(`    ${l.lineType.padEnd(7)} ${l.section ?? "-"} ${l.accountId} ${l.accountName}: ${l.amounts.map((a) => (a / 100).toFixed(0)).join(" | ")}`);
    } catch (e) { const m = `P&L by month: ${e instanceof Error ? e.message : e}`; errors.push(m); console.log(`  ✗ ${m}`); }

    // 3. P&L by customer / class / vendor — one call per month per dimension.
    const dims: { key: string; by: "Customers" | "Classes" | "Vendors"; nameOf: (id: string) => string | undefined }[] = [
      { key: "customer", by: "Customers", nameOf: (id) => customerNameById.get(id) },
      { key: "vendor", by: "Vendors", nameOf: (id) => vendorNameById.get(id) },
      ...(classesInUse ? [{ key: "class", by: "Classes" as const, nameOf: (id: string) => classes.find((k) => k.id === id)?.name }] : []),
    ];
    if (!classesInUse) console.log("  classes: none active in QBO — class dimension skipped");
    for (const dim of dims) {
      let lineCount = 0;
      for (const m of months) {
        try {
          const report = await qbo.getProfitAndLossBy(m.start, m.end, dim.by);
          const { columns, lines } = parsePnl(report);
          const rows: Parameters<typeof writePnl>[2] = [];
          columns.forEach((col, i) => {
            const isUnspecified = !col.key || /not specified/i.test(col.title);
            const dimensionId = isUnspecified ? "unspecified" : col.key!;
            const dimensionName = isUnspecified ? "Not specified" : (dim.nameOf(col.key!) ?? col.title);
            for (const line of lines) {
              const amount = line.amounts[i] ?? 0;
              if (amount === 0) continue;
              rows.push({ periodStart: m.start, periodEnd: m.end, dimensionId, dimensionName, line, amount });
            }
          });
          await writePnl(dim.key, [m], rows);
          lineCount += rows.length;
          if (dryRun && m === months[months.length - 1]) for (const r of rows.slice(0, 6)) console.log(`    ${dim.key} ${r.dimensionName} · ${r.line.accountName}: $${(r.amount / 100).toFixed(2)}`);
        } catch (e) { const msg = `P&L by ${dim.key} ${m.start}: ${e instanceof Error ? e.message : e}`; errors.push(msg); console.log(`  ✗ ${msg}`); }
      }
      stats[`pnl_${dim.key}_lines`] = lineCount;
      console.log(`  ✓ P&L by ${dim.key}: ${lineCount} line(s) across ${months.length} month(s)`);
    }

    // 4. General ledger — one call per month, rows replaced per month.
    let txnCount = 0, unresolvedNames = 0;
    for (const m of months) {
      try {
        const report = await qbo.getGeneralLedger(m.start, m.end);
        const lines = parseGeneralLedger(report);
        const seen = new Map<string, number>();
        const rows = lines.map((l) => {
          const base = `${l.txnType}:${l.txnId}:${l.accountId ?? "-"}`;
          const n = (seen.get(base) ?? 0) + 1; seen.set(base, n);
          const side = nameSideForTxnType(l.txnType);
          let customerId: string | null = null, vendorId: string | null = null;
          if (l.nameId) {
            if (side === "customer" && customerIds.has(l.nameId)) customerId = l.nameId;
            else if (side === "vendor" && vendorIds.has(l.nameId)) vendorId = l.nameId;
            else if (side === "either") {
              // Journal entries / deposits: resolve by id AND name match on either side.
              if (vendorIds.has(l.nameId) && vendorNameById.get(l.nameId) === l.name) vendorId = l.nameId;
              else if (customerIds.has(l.nameId) && customerNameById.get(l.nameId) === l.name) customerId = l.nameId;
              else if (vendorIds.has(l.nameId) && !customerIds.has(l.nameId)) vendorId = l.nameId;
              else if (customerIds.has(l.nameId) && !vendorIds.has(l.nameId)) customerId = l.nameId;
            }
            if (!customerId && !vendorId) unresolvedNames++;
          }
          return { id: `${base}:${n}`, ...l, customerId, vendorId, url: qboTxnUrl(l.txnType, l.txnId) };
        });
        if (!dryRun) {
          await c.query("BEGIN");
          try {
            await c.query(`DELETE FROM qbo_transactions WHERE txn_date >= $1 AND txn_date <= $2`, [m.start, m.end]);
            for (const r of rows) await c.query(
              `INSERT INTO qbo_transactions (id, txn_id, txn_type, txn_date, doc_number, account_id, account_name, name, name_id, customer_id, vendor_id, class_id, class_name, memo, split_account, amount_cents, qbo_url, synced_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now())
               ON CONFLICT (id) DO UPDATE SET amount_cents = EXCLUDED.amount_cents, memo = EXCLUDED.memo, synced_at = now()`,
              [r.id, r.txnId, r.txnType, r.txnDate, r.docNumber, r.accountId, r.accountName, r.name, r.nameId, r.customerId, r.vendorId, r.classId, r.className, r.memo, r.splitAccount, r.amountCents, r.url]);
            await c.query("COMMIT");
          } catch (e) { await c.query("ROLLBACK"); throw e; }
        } else if (m === months[months.length - 1]) {
          for (const r of rows.slice(0, 8)) console.log(`    ${r.txnDate} ${r.txnType.padEnd(14)} ${(r.accountName ?? "").slice(0, 28).padEnd(28)} ${(r.name ?? "").slice(0, 24).padEnd(24)} $${(r.amountCents / 100).toFixed(2)}  ${r.url}`);
        }
        txnCount += rows.length;
      } catch (e) { const msg = `General ledger ${m.start}: ${e instanceof Error ? e.message : e}`; errors.push(msg); console.log(`  ✗ ${msg}`); }
    }
    stats.transactions = txnCount; stats.unresolvedNames = unresolvedNames;
    console.log(`  ✓ General ledger: ${txnCount} line(s) over ${months.length} month(s)${unresolvedNames ? ` (${unresolvedNames} with a name that matched neither a customer nor a vendor)` : ""}`);

    // 5. Aging — AR by customer, AP by vendor, as of today.
    for (const kind of ["ar", "ap"] as const) {
      try {
        const report = kind === "ar" ? await qbo.getAgedReceivables(todayIso) : await qbo.getAgedPayables(todayIso);
        const rows = parseAging(report);
        if (!dryRun) {
          await c.query("BEGIN");
          try {
            await c.query(`DELETE FROM qbo_aging WHERE as_of_date = $1 AND kind = $2`, [todayIso, kind]);
            for (const r of rows) await c.query(
              `INSERT INTO qbo_aging (as_of_date, kind, entity_id, entity_name, current_cents, d1_30_cents, d31_60_cents, d61_90_cents, d91_plus_cents, total_cents, synced_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
               ON CONFLICT (as_of_date, kind, entity_id) DO UPDATE SET entity_name = EXCLUDED.entity_name, current_cents = EXCLUDED.current_cents, d1_30_cents = EXCLUDED.d1_30_cents,
                 d31_60_cents = EXCLUDED.d31_60_cents, d61_90_cents = EXCLUDED.d61_90_cents, d91_plus_cents = EXCLUDED.d91_plus_cents, total_cents = EXCLUDED.total_cents, synced_at = now()`,
              [todayIso, kind, r.entityId, r.entityName, r.buckets[0] ?? 0, r.buckets[1] ?? 0, r.buckets[2] ?? 0, r.buckets[3] ?? 0, r.buckets[4] ?? 0, r.total]);
            // Keep the last 400 days of daily aging so a trend is possible without unbounded growth.
            await c.query(`DELETE FROM qbo_aging WHERE kind = $1 AND as_of_date < to_char(now() - interval '400 days', 'YYYY-MM-DD')`, [kind]);
            await c.query("COMMIT");
          } catch (e) { await c.query("ROLLBACK"); throw e; }
        }
        const total = rows.find((r) => r.entityId === "__total__");
        const sumRows = rows.filter((r) => r.entityId !== "__total__").reduce((s, r) => s + r.total, 0);
        stats[`aging_${kind}_rows`] = rows.length - (total ? 1 : 0);
        console.log(`  ✓ ${kind.toUpperCase()} aging: ${stats[`aging_${kind}_rows`]} ${kind === "ar" ? "customer" : "vendor"} row(s), rows sum $${(sumRows / 100).toFixed(2)}, report total ${total ? `$${(total.total / 100).toFixed(2)}` : "(no total row)"}`);
        if (dryRun) for (const r of rows.slice(0, 5)) console.log(`    ${r.entityName}: ${r.buckets.map((b) => (b / 100).toFixed(0)).join(" | ")} = $${(r.total / 100).toFixed(2)}`);
      } catch (e) { const msg = `${kind.toUpperCase()} aging: ${e instanceof Error ? e.message : e}`; errors.push(msg); console.log(`  ✗ ${msg}`); }
    }

    const ok = errors.length === 0;
    if (!dryRun) await c.query(`UPDATE qbo_import_runs SET finished_at = now(), ok = $2, stats_json = $3, note = $4 WHERE id = $1`, [runId, ok, JSON.stringify(stats), ok ? mode : `${mode}; ${errors.length} error(s): ${errors.join(" | ").slice(0, 900)}`]);
    console.log(`${ok ? "Done." : `Done with ${errors.length} error(s).`} ${JSON.stringify(stats)}`);
    if (!ok) process.exitCode = 1;
  } catch (e) {
    if (!dryRun) await c.query(`UPDATE qbo_import_runs SET finished_at = now(), ok = false, stats_json = $2, note = $3 WHERE id = $1`, [runId, JSON.stringify(stats), (e instanceof Error ? e.message : String(e)).slice(0, 900)]).catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

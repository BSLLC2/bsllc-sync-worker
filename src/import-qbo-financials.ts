#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { QboClient, findReportTotal, type QboReport, type QboReportRow } from "./qbo.js";

/**
 * Financials tab (Phase 1 actuals): pulls P&L (month-to-date, quarter-to-date,
 * year-to-date), a point-in-time Balance Sheet, and current cash position from
 * QuickBooks Online, and snapshots each into Postgres for the dashboard's
 * exec-only Financials page to read. Same QBO connection/scope already used
 * for import-qbo-invoices — no new OAuth consent.
 *
 * Idempotent: upserts by (report_type, period_type, period_start, period_end)
 * for financial_snapshots and by (as_of_date) for cash_position_snapshots, so
 * re-running the same day just refreshes the numbers.
 *
 *   npm run import-qbo-financials
 *   npm run import-qbo-financials -- --dry-run
 */
function env(n: string): string { const v = process.env[n]; if (!v?.trim()) throw new Error(`Missing ${n}`); return v.trim(); }
const iso = (d: Date) => d.toISOString().slice(0, 10);

function pnlSummary(report: QboReport) {
  return {
    totalIncomeCents: toCents(findReportTotal(report, ["Income", "TotalIncome"])),
    cogsCents: toCents(findReportTotal(report, ["COGS", "TotalCOGS"])),
    grossProfitCents: toCents(findReportTotal(report, ["GrossProfit"])),
    totalExpensesCents: toCents(findReportTotal(report, ["Expenses", "TotalExpenses"])),
    netIncomeCents: toCents(findReportTotal(report, ["NetIncome", "NetOperatingIncome"])),
  };
}
// QBO's own row-grouping is inconsistent between sections: the Assets
// section's subtotal is grouped "TotalAssets", but Liabilities/Equity
// subtotals are grouped by the bare section name ("Liabilities", "Equity")
// with no "Total" prefix — only the combined grand total row below them is
// "TotalLiabilitiesAndEquity". Confirmed against a live report via
// collectGroupNames() below; "TotalLiabilities"/"TotalEquity" are kept as
// fallbacks in case some other QBO company file does label it that way.
function balanceSheetSummary(report: QboReport) {
  return {
    totalAssetsCents: toCents(findReportTotal(report, ["TotalAssets"])),
    totalLiabilitiesCents: toCents(findReportTotal(report, ["Liabilities", "TotalLiabilities"])),
    totalEquityCents: toCents(findReportTotal(report, ["Equity", "TotalEquity"])),
    // Accounts Receivable — already invoiced, not yet collected. Confirmed
    // present as group "AR" in the live report via collectGroupNames() above
    // (same debug pass that found the Liabilities/Equity naming). Feeds the
    // dashboard's "already invoiced, awaiting collection" figure alongside
    // the Gap Analysis, since it's real committed cash QBO already knows
    // about but our own revenue_schedules can't see.
    arCents: toCents(findReportTotal(report, ["AR", "AccountsReceivable"])),
  };
}
/** Every `group` value present anywhere in a QBO report — a debug aid for
 *  when findReportTotal comes back null for a group name we assumed QBO
 *  uses (Intuit's own naming isn't consistent report-to-report). */
function collectGroupNames(report: QboReport): string[] {
  const names = new Set<string>();
  const walk = (rows?: QboReportRow[]) => {
    for (const row of rows ?? []) {
      if (row.group) names.add(row.group);
      walk(row.Rows?.Row);
    }
  };
  walk(report.Rows?.Row);
  return Array.from(names);
}
function cashFlowSummary(report: QboReport) {
  return {
    operatingCents: toCents(findReportTotal(report, ["OperatingActivities", "NetCashProvidedByOperatingActivities"])),
    investingCents: toCents(findReportTotal(report, ["InvestingActivities", "NetCashProvidedByInvestingActivities"])),
    financingCents: toCents(findReportTotal(report, ["FinancingActivities", "NetCashProvidedByFinancingActivities"])),
  };
}
function toCents(dollars: number | null): number | null {
  return dollars == null ? null : Math.round(dollars * 100);
}

async function upsertFinancialSnapshot(
  c: pg.Client,
  args: { reportType: string; periodType: string; periodStart: string; periodEnd: string; data: unknown; summary: unknown },
) {
  await c.query(
    `INSERT INTO financial_snapshots (id, period_type, period_start, period_end, report_type, currency, data_json, summary_json, source, synced_at)
     VALUES ($1, $2, $3, $4, $5, 'USD', $6, $7, 'qbo', now())
     ON CONFLICT (report_type, period_type, period_start, period_end)
     DO UPDATE SET data_json = EXCLUDED.data_json, summary_json = EXCLUDED.summary_json, synced_at = now()`,
    [randomUUID(), args.periodType, args.periodStart, args.periodEnd, args.reportType, JSON.stringify(args.data), JSON.stringify(args.summary)],
  );
}

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const c = new pg.Client({ connectionString: env("DATABASE_URL") });
  await c.connect();
  try {
    // Safety net — normally the dashboard's ensureSchema already made these.
    await c.query(`
      CREATE TABLE IF NOT EXISTS financial_snapshots (
        id TEXT PRIMARY KEY,
        period_type TEXT NOT NULL,
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        report_type TEXT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        data_json TEXT NOT NULL,
        summary_json TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'qbo',
        synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (report_type, period_type, period_start, period_end)
      )`);
    await c.query(`
      CREATE TABLE IF NOT EXISTS cash_position_snapshots (
        id TEXT PRIMARY KEY,
        as_of_date TEXT NOT NULL UNIQUE,
        cash_cents INTEGER NOT NULL,
        accounts_json TEXT NOT NULL,
        synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);

    const today = new Date();
    const todayIso = iso(today);
    const monthStart = iso(new Date(today.getFullYear(), today.getMonth(), 1));
    const quarterStart = iso(new Date(today.getFullYear(), Math.floor(today.getMonth() / 3) * 3, 1));
    const yearStart = iso(new Date(today.getFullYear(), 0, 1));
    const ninetyDaysAgo = iso(new Date(today.getTime() - 90 * 24 * 60 * 60 * 1000));

    console.log(`import-qbo-financials — as of ${todayIso}${dryRun ? " (dry-run)" : ""}`);
    const qbo = new QboClient(c);
    if (!dryRun) await qbo.connect();

    const periods: { periodType: string; start: string; end: string }[] = [
      { periodType: "month", start: monthStart, end: todayIso },
      { periodType: "quarter", start: quarterStart, end: todayIso },
      { periodType: "ytd", start: yearStart, end: todayIso },
    ];

    for (const p of periods) {
      if (dryRun) { console.log(`  would pull P&L ${p.periodType}: ${p.start}..${p.end}`); continue; }
      try {
        const report = await qbo.getProfitAndLoss(p.start, p.end);
        const summary = pnlSummary(report);
        await upsertFinancialSnapshot(c, { reportType: "profit_and_loss", periodType: p.periodType, periodStart: p.start, periodEnd: p.end, data: report, summary });
        console.log(`  ✓ P&L ${p.periodType} — net income ${summary.netIncomeCents != null ? `$${(summary.netIncomeCents / 100).toLocaleString("en-US")}` : "(unavailable)"}`);
      } catch (e) {
        console.log(`  ✗ P&L ${p.periodType}: ${e instanceof Error ? e.message : e}`);
      }
    }

    if (dryRun) {
      console.log(`  would pull Balance Sheet as of ${todayIso}`);
      console.log(`  would pull Cash Flow ${ninetyDaysAgo}..${todayIso}`);
      console.log(`  would pull cash account balances`);
    } else {
      try {
        const bs = await qbo.getBalanceSheet(todayIso);
        const summary = balanceSheetSummary(bs);
        await upsertFinancialSnapshot(c, { reportType: "balance_sheet", periodType: "as_of", periodStart: todayIso, periodEnd: todayIso, data: bs, summary });
        const fmt = (n: number | null) => (n != null ? `$${(n / 100).toLocaleString("en-US")}` : "(not found in report)");
        console.log(`  ✓ Balance Sheet as of ${todayIso} — assets ${fmt(summary.totalAssetsCents)}, liabilities ${fmt(summary.totalLiabilitiesCents)}, equity ${fmt(summary.totalEquityCents)}`);
        if (summary.totalLiabilitiesCents == null || summary.totalEquityCents == null) {
          console.log(`    (debug) actual group names in this report: ${collectGroupNames(bs).join(", ") || "(none found)"}`);
        }
      } catch (e) {
        console.log(`  ✗ Balance Sheet: ${e instanceof Error ? e.message : e}`);
      }

      try {
        const cf = await qbo.getCashFlow(ninetyDaysAgo, todayIso);
        const summary = cashFlowSummary(cf);
        await upsertFinancialSnapshot(c, { reportType: "cash_flow", periodType: "trailing_90", periodStart: ninetyDaysAgo, periodEnd: todayIso, data: cf, summary });
        console.log(`  ✓ Cash Flow (trailing 90d)`);
      } catch (e) {
        console.log(`  ✗ Cash Flow: ${e instanceof Error ? e.message : e}`);
      }

      try {
        const accounts = await qbo.getCashAccounts();
        const cashCents = Math.round(accounts.reduce((s, a) => s + a.balance, 0) * 100);
        await c.query(
          `INSERT INTO cash_position_snapshots (id, as_of_date, cash_cents, accounts_json, synced_at)
           VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (as_of_date) DO UPDATE SET cash_cents = EXCLUDED.cash_cents, accounts_json = EXCLUDED.accounts_json, synced_at = now()`,
          [randomUUID(), todayIso, cashCents, JSON.stringify(accounts)],
        );
        console.log(`  ✓ Cash position — $${(cashCents / 100).toLocaleString("en-US")} across ${accounts.length} account(s)`);
      } catch (e) {
        console.log(`  ✗ Cash position: ${e instanceof Error ? e.message : e}`);
      }
    }
    console.log("Done.");
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

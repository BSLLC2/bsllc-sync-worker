import { DEFAULT_RUN_BUDGET_CENTS, EST_USD_PER_DOMAIN } from "./types.js";

/** The run's budget in dollars, from BACKLINKS_RUN_BUDGET_CENTS. A missing or unusable value is the conservative default. */
export function budgetUsd(env: string | undefined): { usd: number; fromEnv: boolean } {
  const raw = (env ?? "").trim();
  const n = Number(raw);
  if (raw !== "" && Number.isFinite(n) && n > 0) return { usd: Math.round(n) / 100, fromEnv: true };
  return { usd: DEFAULT_RUN_BUDGET_CENTS / 100, fromEnv: false };
}

export const estimateUsd = (domains: number): number => Math.round(domains * EST_USD_PER_DOMAIN * 10000) / 10000;

export const money = (usd: number): string => `$${usd.toFixed(2)}`;

/** One sentence the run prints before it reads anything. */
export function estimateLine(domains: number, clients: number, budget: number): string {
  const est = estimateUsd(domains);
  return `${domains} domain${domains === 1 ? "" : "s"} across ${clients} client${clients === 1 ? "" : "s"}, estimated ${money(est)} (our own estimate of the published price) against a budget of ${money(budget)}.`;
}

/** Whether the whole plan fits. A plan over the budget is refused, not trimmed. */
export const fits = (domains: number, budget: number): boolean => estimateUsd(domains) <= budget + 1e-9;

/** Whether one more domain may be read after `spent`. */
export const mayRead = (spent: number, budget: number): boolean => spent + EST_USD_PER_DOMAIN <= budget + 1e-9;

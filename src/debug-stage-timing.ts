#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";

/**
 * One-off diagnostic: can we compute a REAL historical "days from entering
 * stage X to actually closing" per stage, to replace the pipeline's flat
 * "closeDate or next month" fallback with something grounded in this
 * business's actual sales-cycle behavior (mirrors the AR days-to-pay
 * pattern)? This only works if enough deals have real crm_activities
 * stage_change history rather than being bulk-imported straight to "won"
 * with no transition trail.
 */
function daysBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / 86_400_000;
}

async function main() {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    const { rows: wonDeals } = await c.query<{ id: string; closed_at: string | null; created_at: string }>(
      `SELECT id, closed_at, created_at FROM deals WHERE status = 'won' AND closed_at IS NOT NULL`,
    );
    const closedAtByDeal = new Map(wonDeals.map((d) => [d.id, new Date(d.closed_at!)]));
    const wonIds = wonDeals.map((d) => d.id);
    console.log(`Closed Won deals with a closed_at: ${wonDeals.length}`);
    if (wonIds.length === 0) return;

    const { rows: activities } = await c.query<{ deal_id: string; subject: string | null; occurred_at: string }>(
      `SELECT deal_id, subject, occurred_at FROM crm_activities WHERE kind = 'stage_change' AND deal_id = ANY($1::text[]) ORDER BY occurred_at ASC`,
      [wonIds],
    );
    console.log(`stage_change activity rows tied to a Closed Won deal: ${activities.length}`);

    const daysByStage = new Map<string, number[]>();
    let unparsable = 0;
    for (const a of activities) {
      const closedAt = closedAtByDeal.get(a.deal_id);
      if (!closedAt || !a.subject) continue;
      const arrow = a.subject.match(/^Stage: .+ → (.+)$/);
      const set = a.subject.match(/^Stage set: (.+)$/);
      const stage = arrow?.[1] ?? set?.[1] ?? null;
      if (!stage) { unparsable++; continue; }
      const days = daysBetween(new Date(a.occurred_at), closedAt);
      if (days < 0) continue;
      if (!daysByStage.has(stage)) daysByStage.set(stage, []);
      daysByStage.get(stage)!.push(days);
    }
    console.log(`unparsable subject lines: ${unparsable}`);
    console.log(`per-stage sample sizes and avg days-to-close:`);
    for (const [stage, arr] of daysByStage) {
      const avg = arr.reduce((s, d) => s + d, 0) / arr.length;
      console.log(`  ${stage}: n=${arr.length}, avg=${avg.toFixed(1)} days, min=${Math.min(...arr).toFixed(1)}, max=${Math.max(...arr).toFixed(1)}`);
    }

    // How many won deals have ZERO stage_change history at all (bulk-imported
    // straight to won, no real transition trail to learn from)?
    const dealsWithActivity = new Set(activities.map((a) => a.deal_id));
    const noHistoryCount = wonIds.filter((id) => !dealsWithActivity.has(id)).length;
    console.log(`Closed Won deals with NO stage_change activity at all: ${noHistoryCount} of ${wonIds.length}`);

    // Same question for currently OPEN deals -- can we date "how long has
    // this deal been in its current stage" for the deals we'd actually be
    // predicting against?
    const { rows: openDeals } = await c.query<{ id: string; stage: string; stage_entered_at: string; created_at: string }>(
      `SELECT id, stage, stage_entered_at, created_at FROM deals WHERE status = 'open'`,
    );
    console.log(`currently open deals: ${openDeals.length}`);
    console.log(JSON.stringify(openDeals.slice(0, 10).map((d) => ({ stage: d.stage, stageEnteredAt: d.stage_entered_at, createdAt: d.created_at })), null, 2));
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

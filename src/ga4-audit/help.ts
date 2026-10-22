/**
 * Help for the person presenting: a few plain talking points with their caveats, ranked
 * next steps backed by a figure, the questions advisors are likely to ask with honest
 * answers, and what this audit could not verify. Every sentence is built from figures
 * the audit read; nothing is written from memory.
 */
import { fmt, fmtChange, change, ratio } from "./metrics.js";
import { label, periodsFor } from "./periods.js";
import type { Audit } from "./run.js";

export interface Help {
  talkingPoints: Array<{ point: string; caveat: string }>;
  nextSteps: Array<{ step: string; because: string }>;
  questions: Array<{ q: string; a: string }>;
  unverified: string[];
}

const n = (v: number | null | undefined) => fmt(v ?? null, "count");

export function buildHelp(a: Audit): Help {
  const p = periodsFor(a.window);
  const h = a.reconciliation.headline;
  const comparable = a.reconciliation.comparable;
  const tp: Help["talkingPoints"] = [];
  const range = label(a.window);
  tp.push({
    point: `${range}: ${n(h[0].sessions)} visits, ${fmt(h[0].rate, "percent")} of them engaged${comparable.prior ? `, ${fmtChange(change(h[0].sessions, h[1].sessions))} on the period before` : ""}${comparable.priorYear ? ` and ${fmtChange(change(h[0].sessions, h[2].sessions))} on the same dates a year earlier` : ""}.`,
    caveat: `Counted with this rule: ${a.reconciliation.headlineFilter}.${a.reconciliation.warning ? " " + a.reconciliation.warning : ""} A "visit" is one session, not a person.`,
  });
  if (a.gsc?.available[0]) {
    const ov = a.gsc.tables[0]!.rows[0]!;
    tp.push({ point: `Google search sent ${n(ov.clicks as number)} clicks in the same dates${a.gsc.available[1] ? `, ${fmtChange(change(ov.clicks as number, a.gsc.tables[0]!.rows[1]!.clicks as number))} on the period before` : ""}.`, caveat: "From Search Console, which automated visits do not touch. It reports a query for only part of the clicks." });
  }
  const adv = a.advisors.tables.leaders.rows;
  if (adv.length) tp.push({ point: `${a.advisors.advisors.length} advisor microsites had visits. The busiest, ${adv[0]!.name}, had ${n(adv[0]!.sessions as number)}.`, caveat: "A visit counts once on an advisor's main page, and one visit can count for two advisors. The directory and the homepage are not counted as advisors." });
  const fl = a.funnel;
  tp.push({ point: `The site recorded ${n(fl.submitRequestLike[0])} form submit events on pages other than the homepage and directory${comparable.prior ? `, ${fmtChange(change(fl.submitRequestLike[0], fl.submitRequestLike[1]))} on the period before` : ""}.`, caveat: `A submit event is not an enquiry. It also fires on searches and counts repeats. ${n(fl.submitAll[0])} events in all, of which ${n(fl.searchSubmits[0])} came from advisor searches.` });
  const ai = a.sources.tables.ai.rows[0];
  if (ai && (ai.s0 as number) > 0) tp.push({ point: `AI assistants sent ${n(ai.s0 as number)} visits.`, caveat: "A floor: an assistant that passes no address lands in Direct." });

  const steps: Help["nextSteps"] = [];
  const searchShare = ratio(fl.searchSubmits[0], fl.submitAll[0]);
  steps.push({ step: "Add a success event on the form's thank-you page, and count that as the enquiry.", because: `Today's only event also fires on searches: ${n(fl.searchSubmits[0])} of ${n(fl.submitAll[0])} events (${fmt(searchShare, "percent")}) carry destination= in their address.` });
  const eff = a.reconciliation.scenarios;
  const auto = eff.find((s) => s.rule?.key === "auto_flood");
  const chan = eff.find((s) => s.rule?.key === "channels");
  if (auto && chan && auto.periods[0].sessions != null && chan.periods[0].sessions != null) steps.push({ step: "Replace the Direct and Unassigned exclusion with the narrower rule that removes only the automated landing paths.", because: `The narrow rule leaves ${n(auto.periods[0].sessions)} sessions against ${n(chan.periods[0].sessions)} for the whole-channel rule, so ${n(auto.periods[0].sessions - chan.periods[0].sessions)} more visits are kept. Whether those extra visits are real people should be checked on their engagement rate (${fmt(auto.periods[0].rate, "percent")} against ${fmt(chan.periods[0].rate, "percent")}).` });
  const direct = a.reconciliation.raw[0].sessions;
  steps.push({ step: "Add tracking codes to every Instagram and email link the team controls.", because: `Untagged links arrive as Direct and cannot be told from other Direct visits. ${n(direct)} sessions were counted before any rule in this window.` });
  const dead = a.advisors.advisors.filter((x) => (x.periods[0].sessions ?? 0) >= 30 && (x.periods[0].submits ?? 0) === 0);
  if (dead.length) steps.push({ step: "Look at advisor pages with visits and no form submit events.", because: `${dead.length} advisor pages had at least 30 visits and no submit event in the window.` });
  steps.push({ step: "Compare the Airtable lead count to submit events every month, so one can be trusted against the other.", because: "The audit cannot read the Airtable. About 800 real leads were recorded for the year to date against the submit events counted here." });

  const q: Help["questions"] = [
    { q: "Why does this differ from Looker Studio?", a: `Check the baseline section first. ${a.checks.find((c) => c.id === "looker")?.status === "holds" ? "The Looker figure for Jan 1 to Sep 30, 2026 was reproduced here with the same rule." : "The Looker figure was NOT reproduced within tolerance, so the difference should be traced before presenting."} Rules, date ranges and the way average engagement time is calculated all change the figure.` },
    { q: "Are the bots gone?", a: `Automated-looking traffic is flagged by low engagement on many sessions. The stored facts say a site-level throttle began on 2026-07-30; the check for that is ${a.checks.find((c) => c.id === "throttle")?.status ?? "not run"}. Flagged paths in this window: ${a.bots.floodPaths.length}.` },
    { q: "How many enquiries did advisors get?", a: "Analytics cannot say. A submit event is not an enquiry. The Airtable is the count of leads." },
    { q: "Why did form events change?", a: a.series[0]!.step ? `The largest shift in the weekly series is between ${a.series[0]!.step!.before} and ${a.series[0]!.step!.after}, ${fmtChange(a.series[0]!.step!.shift)} on the weeks before. The data shows where it moved and cannot say why. A change to the form, the tracking, or what fires the event would look the same.` : "No step change large enough was found in the weekly series. The data does not show a single point where it moved." },
    { q: "Can you forecast next quarter?", a: a.projection.ok ? `${a.projection.reason} Range: ${n(a.projection.low)} to ${n(a.projection.high)} sessions.` : a.projection.reason },
  ];
  const un = [
    "The Airtable lead count, which this audit cannot read.",
    "The list of key events and the engagement timer setting: the Analytics Admin API is disabled on the Google Cloud project, so only the two events checked through the isKeyEvent dimension are verified.",
    "Whether any traffic is a person or a robot. Every automated flag is an inference from engagement.",
    "Why any figure moved. Every driver in this report is a hypothesis with a test.",
    ...a.checks.filter((c) => c.status === "cannot verify").map((c) => `${c.claim}: ${c.found}`),
  ];
  return { talkingPoints: tp, nextSteps: steps, questions: q, unverified: Array.from(new Set(un)) };
}


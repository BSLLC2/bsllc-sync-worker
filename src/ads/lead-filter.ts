/**
 * Which `web_inquiries` rows are leads, for every ads row that counts them.
 *
 * ── THE DEFECT (2026-10-12) ────────────────────────────────────────────────
 *
 * The dashboard has ONE rule for what a lead is: not junk, not marked as our own
 * test, and not from one of our own addresses (any @bsllc.biz submitter, plus
 * the one personal address used while integrating a client's form). It lives in
 * the dashboard's `NOT_INTERNAL_TEST_INQUIRY` and is applied to every count it
 * makes. The ads audit asked a narrower question: it excluded the two statuses
 * and not the addresses, so a test post from our own team counted as a lead and
 * as a form with no click id, in the very row that tells somebody what their
 * leads are made of.
 *
 * So this file is the ads side of that one rule, in one place, used by every
 * query here that counts leads. `npm run verify:wiring` reads the dashboard's
 * statuses and addresses and fails if they part.
 *
 * ── THE RECORDED WAY TO MARK A LEAD AS SPAM ────────────────────────────────
 *
 * A person marks a row Junk (spam) or Our test on the dashboard's Website Leads
 * page, with their name and the date, and it leaves every count. Nothing here
 * guesses which row is a bot: a bot's number looks like a number, and a rule
 * that guessed would one day throw away a real enquiry that nobody could see
 * had gone. What the audit does is say how many it left out, so the count can
 * be read against what is on that page.
 *
 * Pure. SQL text only.
 */

/** The statuses that take a row out of every count. The dashboard's
 *  WEB_INQUIRY_EXCLUDED_STATUSES. */
export const LEAD_EXCLUDED_STATUSES = ["junk", "internal_test"] as const;

/** Our own submitters: a whole domain, and the one personal address. The
 *  dashboard's INTERNAL_TEST_EMAILS and its `%@bsllc.biz` clause. */
export const LEAD_INTERNAL_DOMAIN = "bsllc.biz";
export const LEAD_INTERNAL_ADDRESSES = ["sebastienhue@gmail.com"] as const;

const quoted = (xs: readonly string[]) => xs.map((x) => `'${x.replace(/'/g, "''")}'`).join(", ");

/** SQL: a row that counts as a lead. Column names are the table's own. */
export const COUNTED_LEAD_SQL =
  `((email IS NULL OR (email NOT ILIKE '%@${LEAD_INTERNAL_DOMAIN}' AND email <> ALL(ARRAY[${quoted(LEAD_INTERNAL_ADDRESSES)}]))) `
  + `AND status <> ALL(ARRAY[${quoted(LEAD_EXCLUDED_STATUSES)}]))`;

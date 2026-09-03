/**
 * OCH's website form log, exported by hand from the site's own form tool
 * (Elementor submissions) on 2026-08-24, covering Jul 1 – Aug 24 2026. This is
 * the ground truth for what the site actually received in that window — six
 * of the seven forms were never wired to our webhook, so most of these rows
 * exist nowhere else on our side.
 *
 * Used by debug-och-form-submissions-gap (reconciliation) and
 * oneoff-backfill-och-form-log (lands them in web_inquiries once).
 */
export interface FormLogRow { name: string; phone: string; date: string; via: string }

export const OCH_FORM_LOG_EXPORTED_AT = "2026-08-24";

export const OCH_FORM_LOG: FormLogRow[] = [
  { name: "Katherine Johnson", phone: "513-520-1345", date: "2026-07-01", via: "Verify Insurance" },
  { name: "Austin Grimes", phone: "513-923-0611", date: "2026-07-02", via: "Ads Landing Page" },
  { name: "Emmily Upper", phone: "937-307-9063", date: "2026-07-02", via: "Contact Page" },
  { name: "William Schroer", phone: "513-975-7533", date: "2026-07-02", via: "Verify Insurance" },
  { name: "Osmany Colindres", phone: "513-288-8276", date: "2026-07-04", via: "Ads Landing Page" },
  { name: "Marlene Scoenmann", phone: "602-920-4881", date: "2026-07-05", via: "Ads Landing Page" },
  { name: "Verline Dotson", phone: "513-509-4162", date: "2026-07-06", via: "Ads Landing Page" },
  { name: "William Jurgens", phone: "513-889-6692", date: "2026-07-06", via: "Contact Page" },
  { name: "Brad Seitz", phone: "513-407-8808", date: "2026-07-07", via: "Ads Landing Page" },
  { name: "Aaron Willen", phone: "283-222-6760", date: "2026-07-09", via: "Verify Insurance" },
  { name: "Jose Zertuche", phone: "956-351-2384", date: "2026-07-09", via: "Home Page" },
  { name: "William Townsend", phone: "937-212-1718", date: "2026-07-11", via: "Verify Insurance" },
  { name: "Keith Fitzpatrick", phone: "216-408-3390", date: "2026-07-14", via: "Ads Landing Page" },
  { name: "Bethany Copas", phone: "740-804-5458", date: "2026-07-14", via: "Ads Landing Page" },
  { name: "Joshua Gross", phone: "513-226-5109", date: "2026-07-16", via: "Ads Landing Page + Verify Insurance" },
  { name: "Crystal Kolb", phone: "513-709-1691", date: "2026-07-17", via: "PHP Page" },
  { name: "Sara Johnson", phone: "513-416-0975", date: "2026-07-23", via: "IOP Page" },
  { name: "Thomas Collins", phone: "336-520-8815", date: "2026-07-24", via: "Verify Insurance" },
  { name: "Melody Davis", phone: "513-680-1612", date: "2026-07-26", via: "Ads Landing Page" },
  { name: "Sammy Doss", phone: "330-322-7519", date: "2026-07-26", via: "Ads Landing Page" },
  { name: "Yahdah Hargrove", phone: "513-883-7234", date: "2026-07-27", via: "Ads Landing Page" },
  { name: "Heather Wilson", phone: "513-954-9080", date: "2026-07-27", via: "Verify Insurance" },
  { name: "Karie Leonard", phone: "513-857-6194", date: "2026-07-27", via: "Ads Landing Page" },
  { name: "Dexter Norman", phone: "513-834-1587", date: "2026-08-01", via: "Ads Landing Page" },
  { name: "Alexandrea Anglin", phone: "513-413-9335", date: "2026-08-03", via: "Ads Landing Page" },
  { name: "Layne Nyland", phone: "513-277-9687", date: "2026-08-06", via: "OCH East Page" },
  { name: "Jermaine Powell", phone: "283-223-2891", date: "2026-08-07", via: "Ads Landing Page" },
  { name: "George Clarke", phone: "740-963-5101", date: "2026-08-08", via: "Ads Landing Page" },
  { name: "John Leopold", phone: "513-903-9847", date: "2026-08-10", via: "Verify Insurance" },
  { name: "Kelly Harris", phone: "283-225-2661", date: "2026-08-10", via: "PHP Page" },
  { name: "Daneil Hill", phone: "513-233-1258", date: "2026-08-10", via: "Ads Landing Page" },
  { name: "Amy Nevil", phone: "513-255-6651", date: "2026-08-12", via: "Contact Page" },
  { name: "Josh Meyer", phone: "513-923-0239", date: "2026-08-14", via: "Verify Insurance" },
  { name: "patrick hollin", phone: "513-344-7228", date: "2026-08-18", via: "Verify Insurance" },
  { name: "Julie Adkins", phone: "", date: "2026-08-22", via: "Ads Landing Page" },
  { name: "Ryan Gibson", phone: "513-254-7672", date: "2026-08-23", via: "Verify Insurance" },
  { name: "Chloey Bynum", phone: "937-601-6791", date: "2026-08-24", via: "Ads Landing Page" },
];

/**
 * OCH's website form log, exported by hand from the site's own form tool
 * (Elementor submissions) on 2026-08-24, covering Jul 1 – Aug 24 2026. This is
 * the ground truth for what the site actually received in that window — six
 * of the seven forms were never wired to our webhook, so most of these rows
 * exist nowhere else on our side. Emails from the "OCH Missing Leads -
 * Jul-Aug 2026" sheet (Drive, 2026-09-01).
 *
 * Used by debug-och-form-submissions-gap (reconciliation) and
 * oneoff-backfill-och-form-log (lands them in web_inquiries once).
 */
export interface FormLogRow { name: string; phone: string; email: string; date: string; via: string }

export const OCH_FORM_LOG_EXPORTED_AT = "2026-08-24";

export const OCH_FORM_LOG: FormLogRow[] = [
  { name: "Katherine Johnson", phone: "513-520-1345", email: "johnson.3261@gmail.com", date: "2026-07-01", via: "Verify Insurance" },
  { name: "Austin Grimes", phone: "513-923-0611", email: "oziguy342@gmail.com", date: "2026-07-02", via: "Ads Landing Page" },
  { name: "Emmily Upper", phone: "937-307-9063", email: "emmilyupper@yahoo.com", date: "2026-07-02", via: "Contact Page" },
  { name: "William Schroer", phone: "513-975-7533", email: "williamschroer100@gmail.com", date: "2026-07-02", via: "Verify Insurance" },
  { name: "Osmany Colindres", phone: "513-288-8276", email: "espimoza_osmani@icloud.com", date: "2026-07-04", via: "Ads Landing Page" },
  { name: "Marlene Scoenmann", phone: "602-920-4881", email: "marlenescoenmann@gmail.com", date: "2026-07-05", via: "Ads Landing Page" },
  { name: "Verline Dotson", phone: "513-509-4162", email: "dotsonverline@gmail.com", date: "2026-07-06", via: "Ads Landing Page" },
  { name: "William Jurgens", phone: "513-889-6692", email: "willyj55@gmail.com", date: "2026-07-06", via: "Contact Page" },
  { name: "Brad Seitz", phone: "513-407-8808", email: "prestigelandscapedesignsllc@gmail.com", date: "2026-07-07", via: "Ads Landing Page" },
  { name: "Aaron Willen", phone: "283-222-6760", email: "funsize227kt@gmail.com", date: "2026-07-09", via: "Verify Insurance" },
  { name: "Jose Zertuche", phone: "956-351-2384", email: "toronegro106@gmail.com", date: "2026-07-09", via: "Home Page" },
  { name: "William Townsend", phone: "937-212-1718", email: "kcwilliet420@gmail.com", date: "2026-07-11", via: "Verify Insurance" },
  { name: "Keith Fitzpatrick", phone: "216-408-3390", email: "kfitz442@gmail.com", date: "2026-07-14", via: "Ads Landing Page" },
  { name: "Bethany Copas", phone: "740-804-5458", email: "copasgirl@gmail.com", date: "2026-07-14", via: "Ads Landing Page" },
  { name: "Joshua Gross", phone: "513-226-5109", email: "JoshuaJoseph333@icloud.com", date: "2026-07-16", via: "Ads Landing Page + Verify Insurance" },
  { name: "Crystal Kolb", phone: "513-709-1691", email: "crystalnicole122@gmail.com", date: "2026-07-17", via: "PHP Page" },
  { name: "Sara Johnson", phone: "513-416-0975", email: "twinmommy2x@gmail.com", date: "2026-07-23", via: "IOP Page" },
  { name: "Thomas Collins", phone: "336-520-8815", email: "thomasthestudcollins23@gmail.com", date: "2026-07-24", via: "Verify Insurance" },
  { name: "Melody Davis", phone: "513-680-1612", email: "pankmelody102@gmail.com", date: "2026-07-26", via: "Ads Landing Page" },
  { name: "Sammy Doss", phone: "330-322-7519", email: "sammydoss17@gmail.com", date: "2026-07-26", via: "Ads Landing Page" },
  { name: "Yahdah Hargrove", phone: "513-883-7234", email: "yahdahbenyisrayah@gmail.com", date: "2026-07-27", via: "Ads Landing Page" },
  { name: "Heather Wilson", phone: "513-954-9080", email: "hw5196kcw@gmail.com", date: "2026-07-27", via: "Verify Insurance" },
  { name: "Karie Leonard", phone: "513-857-6194", email: "davorris2327@gmail.com", date: "2026-07-27", via: "Ads Landing Page" },
  { name: "Dexter Norman", phone: "513-834-1587", email: "coachdexternorman@gmail.com", date: "2026-08-01", via: "Ads Landing Page" },
  { name: "Alexandrea Anglin", phone: "513-413-9335", email: "allieanglin24@gmail.com", date: "2026-08-03", via: "Ads Landing Page" },
  { name: "Layne Nyland", phone: "513-277-9687", email: "layne_nyland@hotmail.com", date: "2026-08-06", via: "OCH East Page" },
  { name: "Jermaine Powell", phone: "283-223-2891", email: "powelljermaine88@icloud.com", date: "2026-08-07", via: "Ads Landing Page" },
  { name: "George Clarke", phone: "740-963-5101", email: "newarkohiocustomdrywall.llc@gmail.com", date: "2026-08-08", via: "Ads Landing Page" },
  { name: "John Leopold", phone: "513-903-9847", email: "johnleopold25@gmail.com", date: "2026-08-10", via: "Verify Insurance" },
  { name: "Kelly Harris", phone: "283-225-2661", email: "kellykellyh2026@gmail.com", date: "2026-08-10", via: "PHP Page" },
  { name: "Daneil Hill", phone: "513-233-1258", email: "dannyhill2310@gmail.com", date: "2026-08-10", via: "Ads Landing Page" },
  { name: "Amy Nevil", phone: "513-255-6651", email: "amynevil7@gmail.com", date: "2026-08-12", via: "Contact Page" },
  { name: "Josh Meyer", phone: "513-923-0239", email: "jpatrickm23@gmail.com", date: "2026-08-14", via: "Verify Insurance" },
  { name: "patrick hollin", phone: "513-344-7228", email: "patrickjhollin@gmail.com", date: "2026-08-18", via: "Verify Insurance" },
  { name: "Julie Adkins", phone: "", email: "julieadkins478@gmail.com", date: "2026-08-22", via: "Ads Landing Page" },
  { name: "Ryan Gibson", phone: "513-254-7672", email: "ryan.gibson4444@outlook.com", date: "2026-08-23", via: "Verify Insurance" },
  { name: "Chloey Bynum", phone: "937-601-6791", email: "ccbynum18@gmail.com", date: "2026-08-24", via: "Ads Landing Page" },
];

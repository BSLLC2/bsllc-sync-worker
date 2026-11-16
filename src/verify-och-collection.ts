import { readFileSync } from "node:fs";
import { buildLeadIndex, matchAdmission } from "./och-lead-match.js";
import { resolveAdmissionColumns } from "./och-sheet-columns.js";

let fails = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) fails++; };
const d = (s: string) => new Date(s + "T12:00:00Z");

const idx = buildLeadIndex([
  { id: "L1", phone: "5135550101", dob: null, lastName: null, gclid: "g1", utmSource: null, utmMedium: null, rawJson: null, submittedAt: d("2026-10-01"), callLabel: "Search - Core", isCall: true },
  { id: "L2", phone: "5135550202", dob: null, lastName: null, gclid: null, utmSource: "google", utmMedium: "cpc", rawJson: null, submittedAt: d("2026-10-02"), callLabel: null, isCall: false, utmCampaign: "Brand" },
] as never);
const adm = d("2026-10-20");
const a = matchAdmission(idx, { phone: "5135550999", lastDob: null, referentPhone: "5135550101" }, adm);
ok(a.known?.id === "L1" && a.key === "referent_phone", "a referent phone finds the enquiry");
ok(a.known?.campaign === "Search - Core" && a.known?.campaignSource === "call_tracker", "a call's campaign says it came from the tracker");
const b = matchAdmission(idx, { phone: "5135550202", lastDob: null, referentPhone: "5135550101" }, adm);
ok(b.key === "phone" && b.known?.id === "L2" && b.known?.campaignSource === "utm_campaign", "patient phone is tried before referent phone; a form's campaign is utm_campaign");
ok(matchAdmission(idx, { phone: "5135550999", lastDob: null }, adm).known === null, "no key, no match");

const cols = resolveAdmissionColumns([["Phone Number","DOB","Status","Inquiry Received","Type","Referent","Referent Phone #","Level of Care","Drug of Choice","MAT","Comments","Insurance Info","Admitted"],["5135550101","1/1/1990","Admitted","10/1/2026","Lead","Google ad","5135550202","IOP","","","","","10/20/2026"]], { tab: "t", headerRowIndex: 0 }, { require: [] } as never) as never as Record<string, number>;
ok(cols.referentPhoneCol === 6 && cols.typeCol === 4 && cols.levelCol === 7, "referent phone, type and level of care resolve by heading");
ok(cols.phoneCol === 0, "the referent phone column is never the patient phone");
const src = readFileSync(new URL("./import-och.ts", import.meta.url), "utf8") + readFileSync(new URL("./och-sheet-columns.ts", import.meta.url), "utf8").replace(/\/\/.*$/gm, "");
const clinical = /(drug of choice|\bmat\b|comments|insurance)/i;
ok(!clinical.test(readFileSync(new URL("./import-och.ts", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")), "the importer never names a clinical column");
void src;
if (fails) { console.log(`${fails} failed`); process.exit(1); }
console.log("OCH collection checks passed.");

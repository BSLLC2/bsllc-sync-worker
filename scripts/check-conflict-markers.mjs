#!/usr/bin/env node
/**
 * Fail if any tracked file still contains a git conflict marker.
 *
 * Twenty-five agent branches were merged into master with hand-resolved
 * conflicts in one day, and markers were committed once already — caught by
 * luck, because a marker is valid-looking text to most tools and `tsc` only
 * notices it in a context where it happens to be a syntax error. In Markdown,
 * JSON comments, SQL strings or a .env example it compiles and ships.
 *
 *   node scripts/check-conflict-markers.mjs          # tracked files
 *   node scripts/check-conflict-markers.mjs --staged # only what's staged
 *
 * Exit 0 clean, 1 with a file:line list.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const staged = process.argv.includes("--staged");

// `<<<<<<<` / `>>>>>>>` need a following space or end-of-line so a line of
// seven angle brackets in, say, an ASCII diagram is not a false positive.
// `=======` alone is a Markdown heading underline, so it only counts when the
// file also carries one of the other two markers.
const START = /^<{7}( |$)/;
const END = /^>{7}( |$)/;
const MIDDLE = /^={7}$/;
const ANCESTOR = /^\|{7}( |$)/;

const git = (args) => {
  const r = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    console.error(`git ${args.join(" ")} failed: ${r.stderr}`);
    process.exit(2);
  }
  return r.stdout.split("\0").filter(Boolean);
};

const files = staged
  ? git(["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"])
  : git(["ls-files", "-z"]);

/** This file names the markers it looks for, so it would flag itself. */
const SELF = "scripts/check-conflict-markers.mjs";
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|eot|mp4|mp3|wasm|rtf|xlsx?|docx?)$/i;

const hits = [];
for (const file of files) {
  if (file === SELF || BINARY_EXT.test(file)) continue;
  let text;
  try {
    if (statSync(file).size > 8 * 1024 * 1024) continue;
    text = readFileSync(file, "utf8");
  } catch {
    continue; // deleted, or unreadable
  }
  if (text.includes("\0")) continue; // binary
  const lines = text.split("\n");
  const strong = lines.some((l) => START.test(l) || END.test(l) || ANCESTOR.test(l));
  if (!strong) continue;
  lines.forEach((line, i) => {
    if (START.test(line) || END.test(line) || ANCESTOR.test(line) || MIDDLE.test(line)) {
      hits.push(`${file}:${i + 1}: ${line.slice(0, 80)}`);
    }
  });
}

if (hits.length) {
  console.error(`Conflict markers found in ${new Set(hits.map((h) => h.split(":")[0])).size} file(s):\n`);
  for (const h of hits) console.error(`  ${h}`);
  console.error("\nResolve the merge properly — do not commit markers.");
  process.exit(1);
}
console.log(`No conflict markers in ${files.length} ${staged ? "staged" : "tracked"} file(s).`);

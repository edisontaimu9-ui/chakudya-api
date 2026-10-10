// Builds scripts/muac_for_age_seed.json from the WHO arm circumference-for-age
// "expanded z-score tables" (daily rows, day 91 = 3 months ... day 1856 = 60 months),
// saved as tab-separated text (one file per sex).
//
// Usage: node scripts/build_muac_seed.mjs <girls.txt> <boys.txt> [out.json]
//
// Each month m (3..60) is taken from the table row at day = round(m * 30.4375),
// WHO's own month-to-day convention. Months whose day row is missing from the
// input are skipped and listed, so a truncated export never produces bad rows.
import { readFileSync, writeFileSync } from "node:fs";

const SOURCE = "WHO Child Growth Standards: arm circumference-for-age (cm), expanded z-score tables, 3 to 60 months";

function load(path) {
  const days = new Map();
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const c = line.split("\t");
    if (c.length < 13 || !/^\d+$/.test(c[0])) continue;
    days.set(Number(c[0]), c.slice(1).map(Number));
  }
  return days;
}

const [girlsPath, boysPath, outPath = "scripts/muac_for_age_seed.json"] = process.argv.slice(2);
if (!girlsPath || !boysPath) {
  console.error("Usage: node scripts/build_muac_seed.mjs <girls.txt> <boys.txt> [out.json]");
  process.exit(1);
}
const r3 = (x) => Math.round(x * 1000) / 1000;
const items = [];
const skipped = [];
for (const [sex, path] of [["girls", girlsPath], ["boys", boysPath]]) {
  const days = load(path);
  for (let m = 3; m <= 60; m++) {
    const day = Math.round(m * 30.4375);
    const v = days.get(day);
    if (!v) { skipped.push(`${sex} ${m}`); continue; }
    const [L, M, S, , n3, n2, n1, med, p1, p2, p3] = v;
    items.push({
      sex, age_months: m, age_days: day,
      lms_l: L, lms_m: M, lms_s: S,
      sd_neg3: r3(n3), sd_neg2: r3(n2), sd_neg1: r3(n1), median: r3(med),
      sd_pos1: r3(p1), sd_pos2: r3(p2), sd_pos3: r3(p3),
      source: SOURCE,
    });
  }
}
writeFileSync(outPath, JSON.stringify({ items }));
console.log(`wrote ${items.length} rows to ${outPath}`);
if (skipped.length) console.log(`skipped (day row not in input): ${skipped.join(", ")}`);

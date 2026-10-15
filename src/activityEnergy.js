// Physical activity energy expenditure (kcal per hour by body weight).
// Data lives in the activity_energy_expenditure table (sql/033, scripts/activity_energy_seed.json), not in this file.
// Source: Krause and Mahan's Food and the Nutrition Care Process, 16th ed., Appendix 10 (copyright 2001 HealtheTech Inc.;
// from Hammond K, Nurs Clin North Am 32(4):779-790, 1997). Printed weights are 110, 130 ... 250 lb.
//
// Method: kcal for the person's weight is read straight from the table when the weight is a printed one, interpolated
// linearly between the two nearest printed weights otherwise, and scaled in proportion to weight outside 110-250 lb
// (the table has no basis there, so it is flagged). A printed cell listed in suspect_weights_lb is left out of the
// interpolation. Pure functions: the database read is in the route handler.

export const SOURCE = "Krause and Mahan's Food and the Nutrition Care Process, 16th ed., Appendix 10 (Physical Activity and Calories Expended Per Hour)";
export const TABLE_WEIGHTS_LB = [110, 130, 150, 170, 190, 210, 230, 250];
export const KG_PER_LB = 0.45359237;
export const KJ_PER_KCAL = 4.184;
// Krause Table 2.4 follows delta PAL per hour = (METs - 1) / 17.5 (fits all 24 rows within 0.005). METs here = kcal per hour / kg (1 MET = 1 kcal/kg/h).
export const DELTA_PAL_DIVISOR = 17.5;

const round = (x, d = 0) => { const f = 10 ** d; return Math.round((x + Number.EPSILON) * f) / f; };
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const present = (v) => v !== undefined && v !== null && v !== "";
const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/** weight from { weight_kg } or { weight_lb }. Returns { lb, kg } or { error }. */
export function parseWeight(inp) {
  const hasKg = present(inp?.weight_kg); const hasLb = present(inp?.weight_lb);
  if (hasKg && hasLb) return { error: "give weight_kg or weight_lb, not both" };
  if (!hasKg && !hasLb) return { error: "weight_kg (or weight_lb) is required" };
  const kg = hasKg ? Number(inp.weight_kg) : Number(inp.weight_lb) * KG_PER_LB;
  if (!isNum(kg) || kg < 20 || kg > 250) return { error: "weight must be between 20 and 250 kg (44 to 551 lb)" };
  return { kg, lb: kg / KG_PER_LB };
}

/** The usable (weight, kcal) points of a row, suspect cells removed. */
export function rowPoints(row) {
  const suspect = new Set((Array.isArray(row.suspect_weights_lb) ? row.suspect_weights_lb : []).map(Number));
  const points = [];
  for (const w of TABLE_WEIGHTS_LB) {
    const v = Number(row[`kcal_${w}`]);
    if (isNum(v) && v > 0 && !suspect.has(w)) points.push([w, v]);
  }
  return { points, suspect: [...suspect].sort((a, b) => a - b) };
}

/** kcal per hour at weightLb for one table row. Returns { kcal_per_hour, method, notes } or { error }. */
export function kcalPerHour(row, weightLb) {
  const { points, suspect } = rowPoints(row);
  if (points.length < 2) return { error: "row has too few usable values" };
  const notes = [];
  if (suspect.length) notes.push(`The printed value at ${suspect.join(", ")} lb looks like a misprint in the source and was not used.`);
  const exact = points.find(([w]) => w === Math.round(weightLb) && Math.abs(w - weightLb) < 0.05);
  if (exact) return { kcal_per_hour: exact[1], method: `table value at ${exact[0]} lb`, notes };
  const first = points[0]; const last = points[points.length - 1];
  if (weightLb < first[0]) {
    notes.push(`Weight is below the table range (${first[0]}-${last[0]} lb). The ${first[0]} lb value was scaled in proportion to weight, which is an estimate.`);
    return { kcal_per_hour: (first[1] * weightLb) / first[0], method: `scaled from ${first[0]} lb (outside table range)`, notes };
  }
  if (weightLb > last[0]) {
    notes.push(`Weight is above the table range (${first[0]}-${last[0]} lb). The ${last[0]} lb value was scaled in proportion to weight, which is an estimate.`);
    return { kcal_per_hour: (last[1] * weightLb) / last[0], method: `scaled from ${last[0]} lb (outside table range)`, notes };
  }
  let i = 1;
  while (weightLb > points[i][0]) i++;
  const [w0, v0] = points[i - 1]; const [w1, v1] = points[i];
  return { kcal_per_hour: v0 + ((weightLb - w0) / (w1 - w0)) * (v1 - v0), method: `interpolated between ${w0} lb and ${w1} lb`, notes };
}

/** Find a row by activity and optional type (case-insensitive). Returns { row } or { error }. */
export function findActivity(rows, activity, type) {
  const a = norm(activity); const t = norm(type);
  if (!a) return { error: "activity is required" };
  let matches = rows.filter((r) => norm(r.activity) === a);
  if (!matches.length) matches = rows.filter((r) => norm(`${r.activity} ${r.type}`).includes(a));
  if (!matches.length) return { error: `unknown activity '${String(activity).slice(0, 40)}'. See GET /activity-energy` };
  if (t) {
    const exact = matches.filter((r) => norm(r.type) === t);
    const partial = exact.length ? exact : matches.filter((r) => norm(r.type).includes(t));
    if (!partial.length) return { error: `no type '${String(type).slice(0, 40)}' for '${matches[0].activity}'. Types: ${matches.map((r) => r.type).join("; ")}` };
    if (partial.length > 1) return { error: `type '${String(type).slice(0, 40)}' matches more than one row for '${matches[0].activity}': ${partial.map((r) => r.type).join("; ")}` };
    return { row: partial[0] };
  }
  if (matches.length > 1) return { error: `'${matches[0].activity}' has more than one type, so send type. Types: ${matches.map((r) => r.type).join("; ")}` };
  return { row: matches[0] };
}

/** Browse the table: optional q (text), activity (exact name), and a weight to read kcal per hour at. */
export function listActivities(rows, { q, activity, weightLb } = {}) {
  let out = rows;
  if (present(activity)) out = out.filter((r) => norm(r.activity) === norm(activity));
  if (present(q)) { const s = norm(q); out = out.filter((r) => norm(`${r.activity} ${r.type}`).includes(s)); }
  return out.map((r) => {
    const base = { id: r.id, activity: r.activity, type: r.type };
    if (isNum(weightLb)) {
      const k = kcalPerHour(r, weightLb);
      return { ...base, kcal_per_hour: k.error ? null : round(k.kcal_per_hour), method: k.error ? null : k.method };
    }
    const table = {};
    for (const w of TABLE_WEIGHTS_LB) table[`${w}_lb`] = r[`kcal_${w}`];
    return { ...base, kcal_per_hour_by_weight: table, suspect_weights_lb: r.suspect_weights_lb || [] };
  });
}

/**
 * input: { weight_kg | weight_lb, activities: [{ activity, type?, minutes | hours }] }
 * rows: rows of activity_energy_expenditure. Returns { ok: true, data } or { ok: false, error }.
 */
export function computeActivityEnergy(input, rows) {
  const inp = input && typeof input === "object" && !Array.isArray(input) ? input : null;
  if (!inp) return { ok: false, error: "body must be a JSON object" };
  const w = parseWeight(inp);
  if (w.error) return { ok: false, error: w.error };
  if (!Array.isArray(inp.activities) || !inp.activities.length) return { ok: false, error: "activities must be a non-empty array of { activity, type?, minutes | hours }" };
  if (inp.activities.length > 50) return { ok: false, error: "at most 50 activities per request" };

  const warnings = []; const notes = [];
  const lines = [];
  for (let i = 0; i < inp.activities.length; i++) {
    const a = inp.activities[i];
    if (!a || typeof a !== "object") return { ok: false, error: `activities[${i}] must be an object` };
    const hasMin = present(a.minutes); const hasHr = present(a.hours);
    if (hasMin === hasHr) return { ok: false, error: `activities[${i}]: give minutes or hours (one of them)` };
    const hours = hasMin ? Number(a.minutes) / 60 : Number(a.hours);
    if (!isNum(hours) || hours <= 0 || hours > 24) return { ok: false, error: `activities[${i}]: duration must be above 0 and at most 24 hours` };
    const f = findActivity(rows, a.activity, a.type);
    if (f.error) return { ok: false, error: `activities[${i}]: ${f.error}` };
    const k = kcalPerHour(f.row, w.lb);
    if (k.error) return { ok: false, error: `activities[${i}]: ${k.error}` };
    const kcal = k.kcal_per_hour * hours;
    lines.push({ activity: f.row.activity, type: f.row.type, hours, minutes: round(hours * 60, 1), kcal_per_hour: round(k.kcal_per_hour, 1), kcal: round(kcal, 1), kcal_unrounded: kcal, method: k.method, notes: k.notes });
    for (const n of k.notes) if (!warnings.includes(n)) warnings.push(n);
  }
  const totalUnrounded = lines.reduce((s, l) => s + l.kcal_unrounded, 0);
  const totalHours = lines.reduce((s, l) => s + l.minutes, 0) / 60;
  if (totalHours > 24) warnings.push("The activities add up to more than 24 hours.");
  if (w.kg < 40) warnings.push("The table was built for adult body weights (110 lb / 50 kg and up). Treat figures for children with caution.");
  notes.push("Values are kcal per hour as printed in the source table. The source does not say whether resting energy is included, so do not add resting energy on top without checking your use.");
  notes.push("Estimates only. Individual energy cost varies with fitness, technique and conditions.");

  return {
    ok: true,
    data: {
      weight: { kg: round(w.kg, 1), lb: round(w.lb, 1) },
      activities: lines.map(({ kcal_unrounded, hours, ...rest }) => rest),
      total: { kcal: Math.round(totalUnrounded), kj: Math.round(totalUnrounded * KJ_PER_KCAL), minutes: round(totalHours * 60, 1) },
      warnings,
      notes,
      sources: [SOURCE],
    },
  };
}

export function activityEnergyCatalog() {
  return {
    table_weights_lb: TABLE_WEIGHTS_LB,
    method: "Table value at a printed weight, linear interpolation between printed weights, proportional scaling outside 110-250 lb (flagged). Cells listed in suspect_weights_lb are left out of the interpolation.",
    source: SOURCE,
  };
}

/**
 * Turn an activity log into entries for the energy engine's PAL calculation (POST /energy/requirements).
 * input: { weight_kg, activity_log: [{ activity, type?, minutes | hours }] }, rows: activity_energy_expenditure rows.
 * Each activity: kcal per hour at the person's weight -> METs (kcal per hour / kg) -> delta PAL per hour (METs - 1) / 17.5,
 * the relation Table 2.4 follows. Returns { entries, log } or { error }.
 */
export function activityLogToPalEntries(input, rows) {
  const r = computeActivityEnergy({ weight_kg: input?.weight_kg, activities: input?.activity_log }, rows);
  if (!r.ok) return { error: String(r.error).replace(/^activities\[/, "activity_log[").replace(/^activities must/, "activity_log must").replace(/^body must/, "request body must") };
  const kg = r.data.weight.kg;
  const entries = []; const lines = [];
  for (let i = 0; i < r.data.activities.length; i++) {
    const a = r.data.activities[i];
    const hours = input.activity_log[i].minutes !== undefined && input.activity_log[i].minutes !== null && input.activity_log[i].minutes !== "" ? Number(input.activity_log[i].minutes) / 60 : Number(input.activity_log[i].hours);
    const mets = a.kcal_per_hour / kg;
    const dph = Math.max(0, (mets - 1) / DELTA_PAL_DIVISOR);
    entries.push({ label: `${a.activity} (${a.type})`, delta_pal_per_hour: round(dph, 4), mets: round(mets, 2), hours });
    lines.push({ ...a, mets: round(mets, 2), delta_pal_per_hour: round(dph, 4), delta_pal: round(dph * hours, 3) });
  }
  const log = {
    source: SOURCE,
    method: "kcal per hour at the given weight (Appendix 10) / kg = METs; delta PAL per hour = (METs - 1) / 17.5, the relation Krause Table 2.4 follows; PAL = 1 + 0.1 (TEF) + sum of delta PAL, as in the chapter.",
    activities: lines,
    total_kcal: r.data.total.kcal,
    total_minutes: r.data.total.minutes,
    warnings: r.data.warnings,
    notes: [
      "The PAL counts only the activities you list. Add your everyday activities too (activities with Table 2.4 ids, see GET /energy/factors), otherwise the PAL, and the IOM estimate, will be low.",
      ...r.data.notes,
    ],
  };
  return { entries, log };
}

// Micronutrient assessment (POST /micronutrients/assess, GET /micronutrients/requirements, GET /micronutrients/reference).
// Pure functions, no I/O. A micronutrient-only view built on what the API already has:
//  - DRI tables (EAR / RDA / AI / UL, sodium CDRR) from ./dri_data.js, by life stage (age, sex, pregnancy, lactation)
//  - the EAR/RDA/AI adequacy judgement in assessDiet() from ./dietaryAssessment.js
// Intake is sent as nutrient totals (one day, or up to 7 days averaged). Foods are not resolved here: use POST /dietary-assessment for foods.

import { DRI_LIFE_STAGES, DRI_NUTRIENT_META, DRI_VALUES, resolveDriLifeStage, sodiumCdrrForAge } from "./dri_data.js";
import { assessDiet, assessableNutrients, parseAssessmentRequest } from "./dietaryAssessment.js";
import { normalizeSexMF } from "./energyEngine.js";

export const SOURCE = "NASEM Dietary Reference Intakes (EAR, RDA, AI, UL, sodium CDRR) from src/dri_data.js; adequacy rules from src/dietaryAssessment.js";

const NOT_MICRO = new Set(["protein_g", "carbs_g", "fiber_g"]);
const VITAMINS = new Set(["vita_rae_mcg", "vitc_mg", "vitd_mcg", "vite_mg", "vitk_mcg", "thiamin_mg", "riboflavin_mg", "niacin_mg", "vitb6_mg", "folate_mcg", "vitb12_mcg", "pantothenic_acid_mg", "biotin_mcg", "choline_mg"]);
const microKeys = () => assessableNutrients().filter((k) => !NOT_MICRO.has(k));
const groupOf = (k) => (VITAMINS.has(k) ? "vitamin" : "mineral");

// Context that helps read a gap. General reference notes, not computed from the request.
const CONTEXT = {
  iron_mg: "The RDA assumes a mixed diet. Non-heme iron from plants is absorbed less well (phytate lowers it, vitamin C and animal protein raise it), so a plant-based diet needs more.",
  zinc_mg: "Absorption falls with phytate (unrefined cereals, legumes). Strict vegetarian diets may need up to 50% more zinc than the RDA.",
  calcium_mg: "Absorption is lowered by oxalate (for example spinach) and phytate. Vitamin D status also matters.",
  vitb12_mcg: "Found naturally only in animal foods. Plant-based diets without fortified foods or a supplement are a high-risk pattern.",
  vita_rae_mcg: "Plant sources give provitamin A carotenoids, which convert less efficiently than preformed retinol. The RAE value already allows for that conversion.",
  vitd_mcg: "Sun exposure is not counted, so low dietary intake does not by itself mean low vitamin D status.",
  iodine_mcg: "Intake depends mostly on iodised salt and the iodine in local soil and water. Food table values vary widely.",
  folate_mcg: "The DRI is in dietary folate equivalents (DFE). Folic acid from fortified foods and supplements counts more than natural food folate.",
  riboflavin_mg: "Dairy and eggs are the main sources. Cereal-and-vegetable diets with little animal food are often low.",
  magnesium_mg: "Whole grains, legumes, nuts and green vegetables supply most of it. Refining cereals removes much of the magnesium.",
};
const PLANT_BASED_NOTES = [
  { nutrient: "iron_mg", note: CONTEXT.iron_mg },
  { nutrient: "zinc_mg", note: CONTEXT.zinc_mg },
  { nutrient: "vitb12_mcg", note: CONTEXT.vitb12_mcg },
  { nutrient: "calcium_mg", note: CONTEXT.calcium_mg },
  { nutrient: "vita_rae_mcg", note: CONTEXT.vita_rae_mcg },
  { nutrient: "iodine_mcg", note: CONTEXT.iodine_mcg },
];

const fail = (error) => ({ ok: false, error });
const present = (v) => v !== undefined && v !== null && v !== "";
const rnd = (n, d = 1) => { const f = 10 ** d; return Math.round(n * f) / f; };

function requirementRow(stage, ageYears, key) {
  const meta = DRI_NUTRIENT_META[key];
  const v = DRI_VALUES[stage.code]?.[key];
  if (!meta || !v) return null;
  if (key === "sodium_mg") {
    const cdrr = sodiumCdrrForAge(ageYears)?.mg_per_day ?? null;
    return { nutrient: key, label: meta.label, group: groupOf(key), unit: meta.unit, ear: null, rda: null, ai: v.ai ?? null, ul: null, cdrr, target_type: "limit", target: cdrr };
  }
  if (v.ear == null && v.rda == null && v.ai == null && v.ul == null) return null;
  const target = v.rda ?? v.ai ?? null;
  return { nutrient: key, label: meta.label, group: groupOf(key), unit: meta.unit, ear: v.ear ?? null, rda: v.rda ?? null, ai: v.ai ?? null, ul: v.ul ?? null, target_type: v.rda != null ? "rda" : v.ai != null ? "ai" : null, target };
}

function resolveStageFrom(inp) {
  if (present(inp.life_stage)) {
    const stage = DRI_LIFE_STAGES.find((s) => s.code === inp.life_stage);
    return stage ? { stage, ageYears: stage.age_min ?? null } : { error: `Unknown life_stage '${inp.life_stage}'. See GET /dri/life-stages for the valid codes` };
  }
  if (!present(inp.age)) return { error: "Provide either 'life_stage' or 'age' (plus 'sex' if age is 9 or more)" };
  const age = Number(inp.age);
  if (!Number.isFinite(age) || age < 0 || age > 120) return { error: "'age' must be a number between 0 and 120 (years)" };
  const type = inp.life_stage_type || "normal";
  if (!["normal", "pregnancy", "lactation"].includes(type)) return { error: "'life_stage_type' must be one of: normal, pregnancy, lactation" };
  const stage = resolveDriLifeStage(age, normalizeSexMF(inp.sex) || inp.sex, type);
  if (!stage) return { error: "Could not resolve a life stage from that age, sex and life_stage_type. Send 'sex' (male or female) for age 9 or more; pregnancy and lactation apply to females only." };
  return { stage, ageYears: age };
}

/** GET /micronutrients/requirements: the reference values for one life stage. */
export function micronutrientRequirements(inp = {}) {
  const r = resolveStageFrom(inp);
  if (r.error) return fail(r.error);
  const rows = microKeys().map((k) => requirementRow(r.stage, r.ageYears, k)).filter(Boolean);
  const wanted = present(inp.group) ? String(inp.group).toLowerCase() : null;
  if (wanted && !["vitamin", "mineral"].includes(wanted)) return fail("'group' must be 'vitamin' or 'mineral'");
  const list = wanted ? rows.filter((x) => x.group === wanted) : rows;
  return { ok: true, data: { life_stage: r.stage.code, life_stage_label: r.stage.label, count: list.length, requirements: list, notes: REQ_NOTES, source: SOURCE } };
}
const REQ_NOTES = [
  "EAR is the intake that meets the needs of half of a group. RDA covers about 97% of a group. Where no RDA exists the AI is the target. The UL is the highest intake unlikely to cause harm.",
  "Sodium is a limit (the chronic disease risk reduction intake, CDRR), not a target.",
  "Some ULs apply only to supplements or fortified foods (for example folic acid, magnesium, vitamin E).",
];

/** POST /micronutrients/assess */
export function computeMicronutrientAssessment(body = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail("Body must be a JSON object");
  if (body.meals != null || body.ingredients != null || (Array.isArray(body.days) && body.days.some((d) => d && (d.meals != null || d.ingredients != null)))) {
    return fail("This route takes nutrient totals as 'intake' (or days: [{intake}]). To assess foods, use POST /dietary-assessment.");
  }
  const parsed = parseAssessmentRequest(body);
  if (!parsed.ok) return fail(parsed.error);
  const req = parsed.data;

  const days = req.days.map((d) => ({ date: d.date, totals: d.intake, groups: null }));
  const micro = new Set(microKeys());
  const supplied = new Set(days.flatMap((d) => Object.keys(d.totals)).filter((k) => micro.has(k)));
  if (!supplied.size) return fail(`'intake' has no micronutrient values. Send fields such as iron_mg, calcium_mg, vitc_mg, vitb12_mcg, folate_mcg (see GET /micronutrients/reference).`);

  const res = assessDiet({ stage: req.stage, ageYears: req.ageYears, weightKg: req.weightKg, days, energy: null, coverage: null });
  if (!res.ok) return fail(res.error);
  const a = res.data;

  const plantBased = body.plant_based_diet === true || body.plant_based_diet === "true";
  const nutrients = a.nutrients.filter((e) => micro.has(e.nutrient)).map((e) => {
    const ctx = e.gap_level && CONTEXT[e.nutrient] ? [CONTEXT[e.nutrient]] : [];
    return { ...e, group: groupOf(e.nutrient), notes: [...e.notes, ...ctx] };
  });
  const gapView = (e) => ({ nutrient: e.nutrient, label: e.label, group: e.group, gap_level: e.gap_level, average_intake: e.average_intake, target: e.target, ear: e.ear, unit: e.unit, percent_of_target: e.percent_of_target, percent_of_ear: e.percent_of_ear, days_below_target: e.days_below_target });
  const rank = { likely_inadequate: 0, borderline: 1, possibly_low: 2 };
  const gaps = nutrients.filter((e) => e.gap_level).sort((x, y) => rank[x.gap_level] - rank[y.gap_level] || (x.percent_of_ear ?? x.percent_of_target ?? 100) - (y.percent_of_ear ?? y.percent_of_target ?? 100));
  const excesses = nutrients.filter((e) => e.exceeds_ul || e.exceeds_limit);
  const counts = { likely_inadequate: 0, borderline: 0, possibly_low: 0 };
  for (const g of gaps) counts[g.gap_level]++;

  const requirements = [...micro].map((k) => requirementRow(req.stage, req.ageYears, k)).filter(Boolean);
  const notProvided = requirements.filter((r) => !supplied.has(r.nutrient)).map((r) => ({ nutrient: r.nutrient, label: r.label, group: r.group, unit: r.unit, target: r.target }));
  const n = days.length;
  const parts = [];
  if (counts.likely_inadequate) parts.push(`${counts.likely_inadequate} likely inadequate`);
  if (counts.borderline) parts.push(`${counts.borderline} borderline`);
  if (counts.possibly_low) parts.push(`${counts.possibly_low} possibly low (below AI)`);
  const headline = `${nutrients.length} micronutrients assessed over ${n} day${n === 1 ? "" : "s"}: ${parts.length ? parts.join(", ") : "no gaps found"}${excesses.length ? `; ${excesses.length} above a safe limit` : ""}.`;

  const notes = [
    "Screening against DRI reference values, not a diagnosis. It does not replace clinical, dietary history or biochemical assessment.",
    "EAR-based adequacy is strictly valid for groups. For one person, read 'likely inadequate' as a high chance of inadequate intake and 'borderline' as a lower chance.",
    "A nutrient you did not send is not assessed (see not_provided); it is not treated as zero.",
    "Supplements, fortified foods, cooking losses and bioavailability are only as good as the intake numbers you send.",
  ];
  if (n < 3) notes.unshift(`Only ${n} day${n === 1 ? "" : "s"} of intake. Day-to-day intake varies a lot, so 3 or more days gives a better picture of usual intake.`);

  return {
    ok: true,
    data: {
      life_stage: req.stage.code,
      life_stage_label: req.stage.label,
      days_assessed: n,
      summary: { headline, nutrients_assessed: nutrients.length, gap_counts: counts, above_limit_count: excesses.length, priority_gaps: gaps.slice(0, 5).map(gapView) },
      potential_inadequacies: gaps.map(gapView),
      excesses: excesses.map((e) => ({ nutrient: e.nutrient, label: e.label, group: e.group, average_intake: e.average_intake, unit: e.unit, limit: e.ul ?? e.limit, limit_type: e.exceeds_ul ? "ul" : "cdrr", notes: e.notes })),
      adequate: nutrients.filter((e) => e.type === "target" && !e.gap_level).map((e) => e.nutrient),
      nutrients,
      requirements,
      not_provided: notProvided,
      ...(plantBased ? { plant_based_diet_notes: PLANT_BASED_NOTES } : {}),
      notes,
      source: SOURCE,
    },
  };
}

export function micronutrientReference() {
  const keys = microKeys();
  return {
    ok: true,
    data: {
      nutrients: keys.map((k) => ({ nutrient: k, label: DRI_NUTRIENT_META[k]?.label ?? k, unit: DRI_NUTRIENT_META[k]?.unit ?? null, group: groupOf(k) })),
      request_fields: {
        who: "age + sex (sex for age 9 or more), or life_stage code; life_stage_type normal|pregnancy|lactation",
        intake: "intake {nutrient: amount}, or days: [{date?, intake}] for up to 7 days (averaged)",
        options: "plant_based_diet: true adds absorption notes for iron, zinc, B12, calcium, vitamin A and iodine",
      },
      judgement: { rda_and_ear: "below EAR = likely inadequate; EAR to RDA = borderline; RDA or more = adequate", ai_only: "below AI = possibly low (not proof of inadequacy)", ul: "average intake above the UL is flagged", sodium: "a limit (CDRR), not a target" },
      related: ["GET /dri", "POST /dri/compare", "POST /dietary-assessment (foods, macronutrients and energy)"],
      source: SOURCE,
    },
  };
}

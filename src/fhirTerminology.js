// FHIR R4 conformance resources served by the facade, so every canonical URL
// the API emits actually resolves:
//
//   GET /fhir/CodeSystem/{name}          the code lists used in Observation/
//                                        Condition/... codings (static here;
//                                        `ncp-diagnosis` is the exception — it
//                                        lives in Supabase, see fhirNcp.js)
//   GET /fhir/OperationDefinition/{id}   one per operation in /fhir/metadata
//                                        (id = "<Resource>-<operation>")
//   GET /fhir/StructureDefinition/{name} the Extensions the facade attaches
//
// Pure functions, no I/O. The consistency test in test/fhirNcp.test.js walks
// real operation output and fails if an emitted system/code/extension/operation
// link has no definition here — add the definition when you add the field.

const DATE = "2026-10-10";

// ─── CodeSystems ───────────────────────────────────────────────────────────

const c = (code, display, definition) => ({ code, display, ...(definition ? { definition } : {}) });

const CODE_SYSTEMS = {
  "ncp-step": {
    title: "Nutrition Care Process step",
    description: "Which step of the Nutrition Care Process a resource belongs to. Used as a category on Observation, Condition, Goal, CarePlan and ServiceRequest, and as the section code in the ADIME document.",
    concepts: [
      c("nutrition-screening", "Nutrition screening"),
      c("nutrition-assessment", "Nutrition assessment"),
      c("nutrition-diagnosis", "Nutrition diagnosis"),
      c("nutrition-intervention", "Nutrition intervention"),
      c("nutrition-monitoring", "Nutrition monitoring and evaluation"),
    ],
  },
  "ncp-assessment-domain": {
    title: "NCP nutrition assessment domain",
    description: "The five data domains of the nutrition assessment step.",
    concepts: [
      c("FH", "Food/nutrition-related history"),
      c("AD", "Anthropometric measurements"),
      c("BD", "Biochemical data, medical tests and procedures"),
      c("PD", "Nutrition-focused physical findings"),
      c("CH", "Client history"),
    ],
  },
  "ncp-diagnosis-domain": {
    title: "NCP nutrition diagnosis domain",
    description: "The three domains of nutrition diagnoses.",
    concepts: [
      c("intake", "Nutrition intake"),
      c("clinical", "Nutrition clinical"),
      c("behavioral-environmental", "Nutrition behavioral/environmental"),
    ],
  },
  "ncp-intervention-domain": {
    title: "NCP nutrition intervention domain",
    description: "Intervention strategies carried as ServiceRequests. Food/nutrient delivery is carried as NutritionOrder resources instead.",
    concepts: [
      c("education", "Nutrition education"),
      c("counseling", "Nutrition counseling"),
      c("coordination", "Coordination of nutrition care"),
    ],
  },
  "ncp-document-type": {
    title: "NCP document type",
    description: "Composition type for documents assembled by Bundle/$ncp-document.",
    concepts: [c("adime-note", "Nutrition Care Process (ADIME) note")],
  },
  "ncp-indicator": {
    title: "Chakudya nutrition indicators",
    description:
      "Indicators computed by Observation/$assess-nutrition and $screen. This list is a fragment: callers may also send their own indicator codes in this system via the 'indicator' parameter when they give no code system.",
    content: "fragment",
    concepts: [
      c("usual-weight", "Usual weight"),
      c("weight-change-percent", "Weight change (positive = loss)"),
      c("energy-requirement", "Energy requirement"),
      c("protein-requirement", "Protein requirement"),
      c("energy-intake-adequacy", "Energy intake vs requirement"),
      c("energy-intake", "Energy intake"),
      c("protein-intake-adequacy", "Protein intake vs requirement"),
      c("protein-intake", "Protein intake"),
      c("glim-malnutrition", "GLIM malnutrition criteria"),
      c("must-risk-category", "MUST risk category"),
      c("nrs-initial-screening-positive", "NRS-2002 initial screening positive", "Any of the four initial questions answered yes."),
      c("nrs-nutritional-status-score", "NRS-2002 impaired nutritional status score (0-3)"),
      c("nrs-disease-severity-score", "NRS-2002 severity of disease score (0-3)"),
      c("nrs-age-adjustment", "NRS-2002 age adjustment", "1 if age is 70 or over, else 0."),
      c("nrs-risk-category", "NRS-2002 risk category"),
      c("mna-screening-score", "MNA screening score (0-14)", "Items A-F of the Mini Nutritional Assessment."),
      c("mna-assessment-score", "MNA assessment score (0-16)", "Items G-R; present only when the screening score is 11 or less."),
      c("mna-risk-category", "MNA risk category", "From the Malnutrition Indicator Score when the assessment was done, otherwise from the screening score."),
    ],
  },
  "screening-tool": {
    title: "Nutrition screening tools",
    description: "Validated screening tools supported by Observation/$screen.",
    concepts: [
      c("must", "MUST score (adult)", "Malnutrition Universal Screening Tool: BMI score + weight-loss score + acute-disease score."),
      c("nrs-2002", "NRS-2002 (adult)", "Nutritional Risk Screening 2002: initial screening, then nutritional-status + disease-severity score, +1 if age 70 or over."),
      c("mna", "MNA (older adults)", "Mini Nutritional Assessment: screening items A-F (max 14), then assessment items G-R (max 16) when the screening score is 11 or less; total max 30."),
    ],
  },
  "must-risk": {
    title: "MUST risk category",
    description: "MUST total score 0 = low, 1 = medium, 2 or more = high risk.",
    concepts: [c("low", "Low risk"), c("medium", "Medium risk"), c("high", "High risk")],
  },
  "nrs-risk": {
    title: "NRS-2002 risk category",
    description: "Total score 3 or more = at risk; below 3 = re-screen weekly; an all-negative initial screening skips final screening.",
    concepts: [
      c("at-risk", "Nutritionally at risk", "Age-adjusted total score 3 or more: initiate a nutritional care plan."),
      c("not-at-risk", "Not at risk", "Age-adjusted total score below 3: re-screen weekly."),
      c("final-screening-not-required", "Final screening not required", "All four initial questions answered no: re-screen weekly."),
    ],
  },
  "mna-risk": {
    title: "MNA risk category",
    description: "Malnutrition Indicator Score: 24-30 normal, 17-23.5 at risk, below 17 malnourished. When only screening was done: 12-14 normal.",
    concepts: [
      c("normal", "Normal nutritional status", "Total 24-30, or screening score 12-14."),
      c("at-risk", "At risk of malnutrition", "Total 17-23.5."),
      c("malnourished", "Malnourished", "Total below 17."),
    ],
  },
  "who-adult-bmi-class": {
    title: "WHO adult BMI class",
    description: "WHO adult (18+) BMI classification.",
    concepts: [
      c("severe-thinness", "Severe thinness", "BMI < 16.0"),
      c("moderate-thinness", "Moderate thinness", "BMI 16.0-16.99"),
      c("mild-thinness", "Mild thinness", "BMI 17.0-18.49"),
      c("normal", "Normal range", "BMI 18.5-24.99"),
      c("overweight", "Overweight (pre-obese)", "BMI 25.0-29.99"),
      c("obesity-class-1", "Obesity class I", "BMI 30.0-34.99"),
      c("obesity-class-2", "Obesity class II", "BMI 35.0-39.99"),
      c("obesity-class-3", "Obesity class III", "BMI >= 40"),
    ],
  },
  "weight-loss-significance": {
    title: "Weight-loss significance",
    description: "Significance of % weight loss over the standard intervals (1 week, 1, 3 and 6 months). Never extrapolated to other intervals.",
    concepts: [
      c("not-significant", "Not significant"),
      c("significant", "Significant"),
      c("severe", "Severe"),
      c("no-standard-threshold", "No standard threshold for this interval"),
    ],
  },
  glim: {
    title: "GLIM malnutrition criteria",
    description: "Components and severity values of the GLIM criteria evaluation (Cederholm 2019).",
    concepts: [
      c("phenotypic-criteria-met", "Phenotypic criteria met"),
      c("etiologic-criteria-met", "Etiologic criteria met"),
      c("malnutrition-criteria-met", "GLIM malnutrition criteria met"),
      c("severity", "Severity"),
      c("moderate", "Moderate malnutrition (stage 1)"),
      c("severe", "Severe malnutrition (stage 2)"),
    ],
  },
  "growth-metric": {
    title: "Growth metric",
    description: "Component codes of a growth-classification Observation.",
    concepts: [c("z-score", "Z-score"), c("percentile", "Percentile"), c("status", "Growth status")],
  },
  "growth-status": {
    title: "Growth status",
    description: "Plain-language status from the Fenton preterm (small/appropriate/large) and WHO 2007 BMI-for-age references.",
    concepts: [
      c("small", "Small", "Fenton: z < -2"),
      c("appropriate", "Appropriate", "Fenton: z within +/-2"),
      c("large", "Large", "Fenton: z > +2"),
      c("severe thinness", "Severe thinness", "WHO BMI-for-age: below -3 SD"),
      c("thinness", "Thinness", "WHO BMI-for-age: -3 SD to below -2 SD"),
      c("normal", "Normal", "WHO BMI-for-age: -2 SD to +1 SD"),
      c("overweight", "Overweight", "WHO BMI-for-age: above +1 SD to +2 SD"),
      c("obesity", "Obesity", "WHO BMI-for-age: above +2 SD"),
    ],
  },
};

export const STATIC_CODE_SYSTEM_NAMES = Object.keys(CODE_SYSTEMS);

export function codeSystemResource(base, name) {
  const d = CODE_SYSTEMS[name];
  if (!d) return null;
  return {
    resourceType: "CodeSystem",
    id: name,
    url: `${base}/fhir/CodeSystem/${name}`,
    version: "1",
    name: name.replace(/(^|-)([a-z0-9])/g, (_, __, ch) => ch.toUpperCase()),
    title: d.title,
    status: "active",
    date: DATE,
    publisher: "Chakudya Nutrition Registry",
    description: d.description,
    caseSensitive: true,
    content: d.content ?? "complete",
    ...(d.content === "fragment" ? {} : { count: d.concepts.length }),
    concept: d.concepts,
  };
}

// ─── OperationDefinitions ──────────────────────────────────────────────────

const P = (name, type, min, max, documentation, part) => ({
  name, use: "in", min, max, type, documentation, ...(part ? { part } : {}),
});
const part = (name, type, min, max, documentation) => ({ name, use: "in", min, max, type, documentation });

const SUBJECT_OPT = P("subject", "string", 0, "1", 'Patient reference, e.g. "Patient/123".');
const SUBJECT_REQ = P("subject", "string", 1, "1", 'Patient reference, e.g. "Patient/123".');
const EFFECTIVE = P("effectiveDateTime", "dateTime", 0, "1", "When the measurements apply. Defaults to now.");
const QUANTITY_NOTE = " Units are never guessed: weight kg|g, height cm|m.";

const OPERATIONS = {
  "Observation-evaluate-growth": {
    resource: "Observation", code: "evaluate-growth", title: "Evaluate paediatric growth",
    description:
      "Classifies growth with the Fenton preterm chart (22-50 weeks gestation) or WHO 2007 BMI-for-age (5y1m-19y0m). WHO 0-59-month standards are not covered and return an OperationOutcome.",
    parameters: [
      P("sex", "code", 1, "1", "male | female"),
      P("gestationalAgeWeeks", "integer", 0, "1", "22-50. Use this or birthDate."),
      P("gestationalAgeDays", "integer", 0, "1", "0-6, with gestationalAgeWeeks."),
      P("birthDate", "date", 0, "1", "Use this or gestationalAgeWeeks."),
      P("referenceYear", "integer", 0, "1", "Fenton reference year, if not the default."),
      EFFECTIVE,
      P("measurement", "Element", 1, "*", "One or more measurements.", [
        part("type", "code", 1, "1", "weight | length | hc | bmi"),
        part("value", "Quantity", 1, "1", "The measured value with unit."),
      ]),
    ],
  },
  "Observation-screen": {
    resource: "Observation", code: "screen", title: "Nutrition screening (MUST, NRS-2002 or MNA)",
    description:
      "tool=must (default): Malnutrition Universal Screening Tool score and risk category; provide bmi, or weight + height; and weightLossPercent3to6Months, or usualWeight + weight. " +
      "tool=nrs-2002: two-stage NRS-2002 as printed in the source appendix (initial screening, then nutritional status + disease severity + age 70+); disease severity and impaired general condition are clinician inputs. " +
      "tool=mna: Mini Nutritional Assessment as printed on the Nestle form; screening items A-F always, assessment items G-R only when the screening score is 11 or less (12-14 stops at normal). Measured items are scored from raw values, judgement items are sent as the printed option score." + QUANTITY_NOTE,
    parameters: [
      P("tool", "code", 0, "1", "must (default) | nrs-2002 | mna"),
      P("bmi", "decimal", 0, "1", "BMI in kg/m2. Alternative to weight + height."),
      P("weight", "Quantity", 0, "1", "Current weight."),
      P("height", "Quantity", 0, "1", "Height."),
      P("weightLossPercent3to6Months", "decimal", 0, "1", "MUST: unplanned weight loss over 3-6 months, in percent (0 if none)."),
      P("usualWeight", "Quantity", 0, "1", "MUST: usual weight; with weight it derives the loss."),
      P("acuteDiseaseNoIntake", "boolean", 0, "1", "MUST (required): acutely ill AND no nutritional intake, or likely none, for more than 5 days."),
      P("ageYears", "integer", 0, "1", "NRS-2002: age in years. Use this or birthDate."),
      P("birthDate", "date", 0, "1", "NRS-2002: use this or ageYears."),
      P("weightLossPercent", "decimal", 0, "1", "NRS-2002 (required): weight loss in percent, 0 if none."),
      P("weightLossPeriodMonths", "decimal", 0, "1", "NRS-2002: months over which the loss occurred. Required when weightLossPercent > 0."),
      P("intakePercentOfRequirement", "decimal", 0, "1", "NRS-2002 (required): intake in the preceding week as % of normal requirement."),
      P("impairedGeneralCondition", "boolean", 0, "1", "NRS-2002: required when BMI is 20.5 or below."),
      P("diseaseSeverityScore", "integer", 0, "1", "NRS-2002: severity of disease 0 absent, 1 mild, 2 moderate, 3 severe. Required when initial screening is positive."),
      P("severelyIll", "boolean", 0, "1", "NRS-2002 initial question 4. Defaults to diseaseSeverityScore = 3."),
      P("reducedIntakeLastWeek", "boolean", 0, "1", "NRS-2002 initial question 3. Defaults to intakePercentOfRequirement < 100."),
      P("foodIntakeDeclineScore", "integer", 0, "1", "MNA A (required): food intake over the past 3 months. 0 severe decrease, 1 moderate decrease, 2 no decrease."),
      P("weightLossKg3Months", "decimal", 0, "1", "MNA B: kg lost over the last 3 months (0 or negative if none): over 3 scores 0, 1 to 3 scores 2, none scores 3. Required unless weightLossUnknown is true."),
      P("weightLossUnknown", "boolean", 0, "1", "MNA B: true when the patient does not know whether weight was lost (scores 1)."),
      P("mobilityScore", "integer", 0, "1", "MNA C (required): 0 bed or chair bound, 1 gets out of bed/chair but does not go out, 2 goes out."),
      P("psychologicalStressOrAcuteDisease", "boolean", 0, "1", "MNA D (required): psychological stress or acute disease in the past 3 months (true scores 0, false 2)."),
      P("neuropsychologicalScore", "integer", 0, "1", "MNA E (required): 0 severe dementia or depression, 1 mild dementia, 2 no psychological problems."),
      P("livesIndependently", "boolean", 0, "1", "MNA G: lives independently, not in a nursing home or hospital. Required when the screening score is 11 or less."),
      P("moreThan3PrescriptionDrugs", "boolean", 0, "1", "MNA H: more than 3 prescription drugs per day."),
      P("pressureSoresOrUlcers", "boolean", 0, "1", "MNA I: pressure sores or skin ulcers."),
      P("fullMealsPerDay", "decimal", 0, "1", "MNA J: full meals eaten daily (1 or fewer 0, 2 scores 1, 3 or more scores 2)."),
      P("dairyDaily", "boolean", 0, "1", "MNA K: at least one serving of dairy products per day."),
      P("legumesOrEggsTwiceWeekly", "boolean", 0, "1", "MNA K: two or more servings of legumes or eggs per week."),
      P("meatFishPoultryDaily", "boolean", 0, "1", "MNA K: meat, fish or poultry every day. K scores 0 for 0-1 yes, 0.5 for 2, 1 for 3."),
      P("fruitOrVegetablesTwoPlusServings", "boolean", 0, "1", "MNA L: two or more servings of fruit or vegetables per day."),
      P("fluidCupsPerDay", "decimal", 0, "1", "MNA M: cups of fluid per day (under 3 scores 0, 3 to 5 scores 0.5, over 5 scores 1)."),
      P("modeOfFeedingScore", "integer", 0, "1", "MNA N: 0 unable to eat without assistance, 1 self-fed with some difficulty, 2 self-fed without any problem."),
      P("selfViewNutritionScore", "integer", 0, "1", "MNA O: 0 views self as malnourished, 1 uncertain, 2 sees no nutritional problem."),
      P("selfViewHealthScore", "decimal", 0, "1", "MNA P: health compared with others of the same age: 0 not as good, 0.5 does not know, 1 as good, 2 better."),
      P("midArmCircumferenceCm", "decimal", 0, "1", "MNA Q: mid-arm circumference in cm (under 21 scores 0, 21 to 22 scores 0.5, over 22 scores 1)."),
      P("calfCircumferenceCm", "decimal", 0, "1", "MNA R: calf circumference in cm (under 31 scores 0, 31 or more scores 1)."),
      SUBJECT_OPT, EFFECTIVE,
    ],
  },
  "Observation-assess-nutrition": {
    resource: "Observation", code: "assess-nutrition", title: "Nutrition assessment (adults)",
    description:
      "NCP step 1 for adults (18+): BMI and WHO class, % weight change, Mifflin-St Jeor energy needs, protein needs, intake adequacy, GLIM criteria, and generic FH/AD/BD/PD/CH indicators. Children are redirected (422) to Observation/$evaluate-growth." + QUANTITY_NOTE,
    parameters: [
      SUBJECT_OPT, EFFECTIVE,
      P("sex", "code", 0, "1", "male | female (needed for energy requirement)."),
      P("ageYears", "integer", 0, "1", "Age in years. Use this or birthDate."),
      P("birthDate", "date", 0, "1", "Use this or ageYears."),
      P("weight", "Quantity", 0, "1", "Current weight."),
      P("height", "Quantity", 0, "1", "Height."),
      P("usualWeight", "Quantity", 0, "1", "Usual weight."),
      P("usualWeightPeriodDays", "integer", 0, "1", "Days over which the change occurred; significance is graded only for 1 week, 1, 3 or 6 months."),
      P("requirementWeight", "Quantity", 0, "1", "Weight to use for requirements (e.g. adjusted). Defaults to weight."),
      P("energyFactor", "decimal", 0, "1", "Clinician-chosen activity/stress factor applied to BEE. No default."),
      P("proteinGPerKg", "decimal", 0, "1", "Clinician-chosen protein target in g/kg/day. No default."),
      P("energyIntakeKcalPerDay", "decimal", 0, "1", "Measured/estimated energy intake."),
      P("proteinIntakeGPerDay", "decimal", 0, "1", "Measured/estimated protein intake."),
      P("screeningPositive", "boolean", 0, "1", "Result of a validated screen. GLIM is skipped when false."),
      P("muscleMass", "code", 0, "1", "none | mild-moderate | severe (GLIM)."),
      P("inflammation", "code", 0, "1", "none | acute-disease-or-injury | chronic-disease (GLIM)."),
      P("intakePercentOfRequirement", "decimal", 0, "1", "GLIM reduced intake, if not derivable."),
      P("intakeReductionDays", "integer", 0, "1", "How long intake has been reduced (GLIM)."),
      P("malabsorption", "boolean", 0, "1", "Reduced assimilation / GI condition (GLIM)."),
      P("glimBmiCutoffSet", "code", 0, "1", "default | asian"),
      P("indicator", "Element", 0, "*", "A generic assessment indicator.", [
        part("domain", "code", 1, "1", "FH | AD | BD | PD | CH"),
        part("display", "string", 0, "1", "Indicator name. Display and/or code is required."),
        part("code", "string", 0, "1", "Indicator code."),
        part("system", "uri", 0, "1", "Code system for 'code'. Defaults to the ncp-indicator system."),
        part("value", "Element", 1, "1", "Quantity, string, boolean, decimal or integer."),
        part("effectiveDateTime", "dateTime", 0, "1", "Overrides the operation-level time."),
      ]),
    ],
  },
  "Condition-diagnose": {
    resource: "Condition", code: "diagnose", title: "Nutrition diagnosis (PES statement)",
    description:
      "NCP step 2. Shapes clinician-supplied PES statements into Condition resources; it does not choose the diagnosis. problemCode values such as NI-5.2 are resolved against the NCP diagnostic terminology (CodeSystem ncp-diagnosis).",
    parameters: [
      SUBJECT_REQ,
      P("diagnosis", "Element", 1, "*", "One PES statement.", [
        part("problemCode", "string", 0, "1", "NI-/NC-/NB- term code (resolves problem and domain), a public shortcut, or your own code with problemSystem."),
        part("problemSystem", "uri", 0, "1", "Your own code system for problemCode."),
        part("problemDisplay", "string", 0, "1", "Display for your own code."),
        part("problemSpecify", "string", 0, "1", 'Required for terms marked "(specify)".'),
        part("domain", "code", 0, "1", "intake | clinical | behavioral-environmental. Derived from problemCode when omitted."),
        part("problem", "string", 0, "1", "Diagnosis label. Required unless problemCode is an NI/NC/NB term."),
        part("etiology", "string", 1, "*", 'The "related to" part.'),
        part("signsSymptoms", "string", 1, "*", 'The "as evidenced by" part.'),
        part("severity", "code", 0, "1", "mild | moderate | severe"),
        part("verificationStatus", "code", 0, "1", "provisional (default) | confirmed"),
        part("evidence", "string", 0, "*", "References to supporting Observations (e.g. urn:uuid)."),
        part("recordedDate", "dateTime", 0, "1", "Defaults to now."),
      ]),
    ],
  },
  "CarePlan-intervene": {
    resource: "CarePlan", code: "intervene", title: "Nutrition intervention plan",
    description:
      "NCP step 3. Shapes clinician-supplied goals, nutrition orders, education, counseling and care coordination into a CarePlan Bundle. Defaults to status draft / intent proposal.",
    parameters: [
      SUBJECT_REQ,
      P("addresses", "string", 0, "*", "Condition references the plan addresses."),
      P("title", "string", 0, "1", "Care plan title."),
      P("status", "code", 0, "1", "draft (default) | active"),
      P("intent", "code", 0, "1", "proposal (default) | plan | order"),
      EFFECTIVE,
      P("goal", "Element", 0, "*", "A goal.", [
        part("description", "string", 1, "1", "Goal text."),
        part("measure", "string", 0, "1", "What is measured."),
        part("measureCode", "string", 0, "1", "Code for the measure."),
        part("measureSystem", "uri", 0, "1", "System for measureCode."),
        part("direction", "code", 0, "1", "increase | decrease | maintain"),
        part("baseline", "Quantity", 0, "1", "Starting value."),
        part("target", "Quantity", 0, "1", "Target value."),
        part("dueDate", "date", 0, "1", "Due date."),
        part("startDate", "dateTime", 0, "1", "Start date."),
        part("priority", "code", 0, "1", "high | medium | low"),
      ]),
      P("nutritionOrder", "Element", 0, "*", "A nutrition order.", [
        part("kind", "code", 1, "1", "oral-diet | supplement | enteral-formula"),
        part("type", "string", 0, "1", "Diet or supplement type."),
        part("nutrient", "Element", 0, "*", "oral-diet nutrient target: parts name (string) and amount (Quantity)."),
        part("texture", "string", 0, "*", "oral-diet texture."),
        part("fluidConsistency", "string", 0, "*", "oral-diet fluid consistency."),
        part("instruction", "string", 0, "1", "Free-text instruction."),
        part("productName", "string", 0, "1", "supplement / enteral-formula product."),
        part("quantity", "Quantity", 0, "1", "supplement quantity."),
        part("baseFormulaType", "string", 0, "1", "enteral-formula base type."),
        part("route", "string", 0, "1", "enteral-formula route."),
        part("rate", "Quantity", 0, "1", "enteral-formula rate."),
        part("maxVolume", "Quantity", 0, "1", "enteral-formula maximum volume."),
      ]),
      P("education", "Element", 0, "*", "Nutrition education.", [
        part("topic", "string", 1, "1", "Topic."), part("audience", "string", 0, "1", "Audience."),
        part("method", "string", 0, "1", "Method."), part("note", "string", 0, "1", "Note."),
      ]),
      P("counseling", "Element", 0, "*", "Nutrition counseling.", [
        part("topic", "string", 1, "1", "Topic."), part("approach", "string", 0, "1", "Approach."), part("note", "string", 0, "1", "Note."),
      ]),
      P("coordination", "Element", 0, "*", "Coordination of nutrition care.", [
        part("reason", "string", 1, "1", "Reason."), part("with", "string", 0, "1", "With whom."), part("note", "string", 0, "1", "Note."),
      ]),
    ],
  },
  "Goal-evaluate": {
    resource: "Goal", code: "evaluate", title: "Nutrition monitoring and evaluation",
    description:
      "NCP step 4. Compares current values to baseline/target and returns Goals with achievementStatus plus outcome Observations. Direction of change is not guessed without a baseline; all quantities must share one unit.",
    parameters: [
      SUBJECT_REQ, EFFECTIVE,
      P("goal", "Element", 1, "*", "A goal to evaluate.", [
        part("description", "string", 1, "1", "Goal text."),
        part("direction", "code", 1, "1", "increase | decrease | maintain"),
        part("current", "Quantity", 1, "1", "Value measured now."),
        part("target", "Quantity", 0, "1", "Required for increase/decrease."),
        part("baseline", "Quantity", 0, "1", "Without it, direction of change is not assessed."),
        part("lowerBound", "Quantity", 0, "1", "maintain: lower limit."),
        part("upperBound", "Quantity", 0, "1", "maintain: upper limit."),
        part("measure", "string", 0, "1", "What is measured."),
        part("measureCode", "string", 0, "1", "Code for the measure."),
        part("measureSystem", "uri", 0, "1", "System for measureCode."),
        part("noChangeTolerance", "decimal", 0, "1", "Fraction of the baseline-to-target gap counted as no change. Default 0.02."),
      ]),
    ],
  },
  "Bundle-ncp-document": {
    resource: "Bundle", code: "ncp-document", title: "ADIME document",
    description:
      "Assembles resources or Bundles returned by the other NCP operations into a Composition document Bundle (screening, assessment, diagnosis, intervention, monitoring and evaluation sections). Pass whole Bundles to keep urn:uuid links valid.",
    parameters: [
      SUBJECT_REQ,
      P("author", "string", 1, "1", 'A reference ("Practitioner/123") or the dietitian\'s name.'),
      P("resource", "Resource", 1, "*", "Observation, Condition, Goal, NutritionOrder, ServiceRequest or CarePlan; or a Bundle of them."),
      P("title", "string", 0, "1", "Document title."),
      P("date", "dateTime", 0, "1", "Document date. Defaults to now."),
      P("encounter", "string", 0, "1", "Encounter reference."),
    ],
  },
};

export const OPERATION_DEFINITION_IDS = Object.keys(OPERATIONS);

export function operationDefinitionResource(base, id) {
  const o = OPERATIONS[id];
  if (!o) return null;
  return {
    resourceType: "OperationDefinition",
    id,
    url: `${base}/fhir/OperationDefinition/${id}`,
    version: "1",
    name: id.replace(/(^|-)([A-Za-z0-9])/g, (_, __, ch) => ch.toUpperCase()),
    title: o.title,
    status: "active",
    kind: "operation",
    date: DATE,
    publisher: "Chakudya Nutrition Registry",
    description: o.description + " Stateless: nothing is stored.",
    affectsState: false,
    code: o.code,
    resource: [o.resource],
    system: false,
    type: true,
    instance: false,
    parameter: [
      ...o.parameters,
      {
        name: "return", use: "out", min: 1, max: "1", type: "Bundle",
        documentation: "A Bundle on success; an OperationOutcome on failure (400 malformed, 422 valid but unsupported).",
      },
    ],
  };
}

// ─── Extension StructureDefinitions ────────────────────────────────────────

const X = (valueType, context, description) => ({ valueType, context, description });

const EXTENSIONS = {
  "addresses-condition": X("Reference", ["NutritionOrder"], "The nutrition diagnosis (Condition) this order addresses."),
  "goal-baseline": X("Quantity", ["Goal"], "Baseline value the goal started from."),
  "goal-direction": X("code", ["Goal"], "Intended direction of change: increase | decrease | maintain."),
  "goal-progress-fraction": X("decimal", ["Goal"], "Progress from baseline to target (1 = reached, negative = moved away)."),
  "growth-reference-used": X("string", ["Observation"], "Which growth reference produced the classification (Fenton or WHO 2007 BMI-for-age)."),
  "gestational-age": X("string", ["Observation"], "Gestational age used, as weeks+days, e.g. 32w3d."),
  "postnatal-age-months": X("string", ["Observation"], "Postnatal age in completed months at the time of measurement."),
  "period-days": X("integer", ["Observation"], "Number of days over which a change was measured."),
  "pes-etiology": X("string", ["Condition"], 'The "related to" part of the PES statement.'),
  "pes-signs-symptoms": X("string", ["Condition"], 'The "as evidenced by" part of the PES statement.'),
  "pes-specify": X("string", ["Condition"], 'The specifying detail for diagnosis terms marked "(specify)", e.g. Iron.'),
};

export const STRUCTURE_DEFINITION_NAMES = Object.keys(EXTENSIONS);

export function structureDefinitionResource(base, name) {
  const x = EXTENSIONS[name];
  if (!x) return null;
  const url = `${base}/fhir/StructureDefinition/${name}`;
  return {
    resourceType: "StructureDefinition",
    id: name,
    url,
    version: "1",
    name: name.replace(/(^|-)([a-z0-9])/g, (_, __, ch) => ch.toUpperCase()),
    title: name,
    status: "active",
    date: DATE,
    publisher: "Chakudya Nutrition Registry",
    description: x.description,
    fhirVersion: "4.0.1",
    kind: "complex-type",
    abstract: false,
    context: x.context.map((expression) => ({ type: "element", expression })),
    type: "Extension",
    baseDefinition: "http://hl7.org/fhir/StructureDefinition/Extension",
    derivation: "constraint",
    differential: {
      element: [
        { id: "Extension", path: "Extension", short: x.description, definition: x.description, min: 0, max: "1" },
        { id: "Extension.url", path: "Extension.url", fixedUri: url },
        { id: "Extension.value[x]", path: "Extension.value[x]", min: 1, type: [{ code: x.valueType }] },
      ],
    },
  };
}

/** Router helper: GET /fhir/<param>/<id> for the static resources. */
export function staticConformanceResource(param, id, base) {
  if (param === "CodeSystem") return codeSystemResource(base, id);
  if (param === "OperationDefinition") return operationDefinitionResource(base, id);
  if (param === "StructureDefinition") return structureDefinitionResource(base, id);
  return null;
}

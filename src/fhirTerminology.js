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

import { ASSESSMENT_ITEM_CONCEPTS, NFPE_SEVERITY, APPETITE_LEVELS } from "./fhirAssessment.js";

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
      c("sga-weight-loss-percent-6-months", "SGA weight loss over 6 months (%)", "Positive = loss."),
      c("sga-weight-change-6-months-grade", "SGA weight change over 6 months (A/B/C)", "0-<5% loss A, 5-10% B, >10% C."),
      c("sga-weight-change-2-weeks-grade", "SGA weight change over 2 weeks (A/B/C)"),
      c("sga-dietary-intake-grade", "SGA dietary intake (A/B/C)"),
      c("sga-gi-symptoms-grade", "SGA gastrointestinal symptoms (A/B/C)", "None daily for over 2 weeks A, some B, all four C."),
      c("sga-functional-capacity-grade", "SGA functional capacity (A/B/C)"),
      c("sga-functional-change-2-weeks-grade", "SGA functional capacity change over 2 weeks (A/B/C)"),
      c("sga-physical-exam-finding", "SGA physical examination finding", "One component per graded site; the site is in code.text."),
      c("pgsga-weight-loss-percent", "PG-SGA weight loss (%)", "Over 1 month when 1-month data exist, else over 6 months (the period is in code.text). Positive = loss."),
      c("pgsga-box1-weight-score", "PG-SGA Box 1 weight score", "Worksheet 1 points, plus 1 if weight decreased in the past 2 weeks."),
      c("pgsga-box2-food-intake-score", "PG-SGA Box 2 food intake score", "Higher of the two Box 2 answers."),
      c("pgsga-box3-symptoms-score", "PG-SGA Box 3 symptoms score", "Sum of the symptoms checked."),
      c("pgsga-box4-activity-score", "PG-SGA Box 4 activities and function score"),
      c("pgsga-short-form-score", "PG-SGA short form score (A)", "Additive score of Boxes 1-4."),
      c("pgsga-disease-score", "PG-SGA disease score (B)", "Worksheet 2: 1 point per condition, including age over 65."),
      c("pgsga-metabolic-score", "PG-SGA metabolic demand score (C)", "Worksheet 3: fever (intensity or duration, whichever is greater) plus corticosteroids."),
      c("pgsga-physical-exam-score", "PG-SGA physical exam score (D)", "Worksheet 4: the clinician's overall rating of total body deficit, 0-3."),
      c("pgsga-triage-category", "PG-SGA triage category", "From the total score A+B+C+D."),
      c("pgsga-global-category", "PG-SGA global category (Stage A/B/C)", "Entered by the assessor; never computed."),
      c("pgsga-nutrition-impact-symptom", "PG-SGA nutrition impact symptom", "One component per symptom checked in Box 3; the symptom is in code.text and the points are the value."),
      c("pgsga-body-composition-rating", "PG-SGA global body composition rating (0-3)", "Muscle, fat or fluid rating from Worksheet 4, recorded only; the rating is in code.text."),
      c("nacs-muac", "MUAC (mm)", "Mid-upper arm circumference of the left arm, in millimetres."),
      c("nacs-muac-status", "NACS MUAC nutritional status", "Cutoffs depend on age group and pregnancy/postpartum status."),
      c("nacs-bmi", "BMI (NACS, adults)", "kg/m2, rounded to 1 decimal before banding."),
      c("nacs-bmi-status", "NACS adult BMI nutritional status"),
      c("nacs-bmi-for-age-z-score", "BMI-for-age z-score (5-17 years)", "As supplied by the caller."),
      c("nacs-bmi-for-age-status", "NACS BMI-for-age nutritional status"),
      c("nacs-pre-pregnancy-bmi", "Pre-pregnancy BMI", "kg/m2, rounded to 1 decimal before banding."),
      c("nacs-pre-pregnancy-bmi-category", "Pre-pregnancy BMI category"),
      c("nacs-edema-grade", "Bilateral pitting edema grade", "0 none, 1 grade +, 2 grade ++, 3 grade +++; the grade text is in code.text."),
      c("nacs-edema-disposition", "Management route for bilateral pitting edema", "As stated in the NACS guide."),
    ],
  },
  "screening-tool": {
    title: "Nutrition screening tools",
    description: "Validated screening tools supported by Observation/$screen.",
    concepts: [
      c("must", "MUST score (adult)", "Malnutrition Universal Screening Tool: BMI score + weight-loss score + acute-disease score."),
      c("nrs-2002", "NRS-2002 (adult)", "Nutritional Risk Screening 2002: initial screening, then nutritional-status + disease-severity score, +1 if age 70 or over."),
      c("mna", "MNA (older adults)", "Mini Nutritional Assessment: screening items A-F (max 14), then assessment items G-R (max 16) when the screening score is 11 or less; total max 30."),
      c("sga", "SGA (adult)", "Subjective Global Assessment: history and physical-examination descriptors under columns A, B, C, then an overall rating A, B or C entered by the assessor."),
      c("pg-sga", "PG-SGA (adult)", "Scored Patient-Generated Subjective Global Assessment: boxes 1-4 (A) + disease (B) + metabolic demand (C) + physical exam (D), triaged 0-1, 2-3, 4-8, 9 or more."),
      c("nacs", "NACS classification", "NACS User's Guide Module 2 classification: MUAC by age group and pregnancy status, adult BMI, BMI-for-age z-score, pre-pregnancy BMI and bilateral pitting edema. Children and adults."),
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
  "sga-grade": {
    title: "SGA form column",
    description: "Column of the SGA form that a descriptor or examination finding sits in.",
    concepts: [c("A", "Column A"), c("B", "Column B"), c("C", "Column C")],
  },
  "sga-rating": {
    title: "SGA overall rating",
    description: "Overall SGA rating entered by the assessor. The labels are Detsky's standard wording, not printed on the form.",
    concepts: [
      c("A", "A: well nourished"),
      c("B", "B: moderately malnourished or suspected malnutrition"),
      c("C", "C: severely malnourished"),
    ],
  },
  "pgsga-triage": {
    title: "PG-SGA triage category",
    description: "Nutritional triage by PG-SGA total score as printed on the form: 0-1, 2-3, 4-8, 9 or more.",
    concepts: [
      c("no-intervention", "No intervention required", "Total 0-1: re-assess routinely during treatment."),
      c("education-and-symptom-management", "Education and symptom management", "Total 2-3: patient and family education, with pharmacologic intervention as indicated by the symptom survey and lab values."),
      c("dietitian-intervention", "Requires dietitian intervention", "Total 4-8: dietitian, in conjunction with nurse or physician as indicated by symptoms."),
      c("critical-need", "Critical need", "Total 9 or more: critical need for improved symptom management and/or nutrient intervention options."),
    ],
  },
  "pgsga-category": {
    title: "PG-SGA global category",
    description: "Global PG-SGA category rating entered by the assessor (Worksheet 5). The form lists descriptors per stage but no rule to compute it.",
    concepts: [c("A", "Stage A", "Well-nourished."), c("B", "Stage B", "Moderate or suspected malnutrition."), c("C", "Stage C", "Severely malnourished.")],
  },
  "nacs-status": {
    title: "NACS nutritional status",
    description: "Nutritional status classes as printed in the NACS User's Guide Module 2. Not one scale: children's MUAC uses sam/mam/normal, adult MUAC uses sam/moderate-malnutrition/normal, adult BMI and BMI-for-age use the severe/moderate/mild/normal/overweight/obesity classes.",
    concepts: [
      c("sam", "Severe acute malnutrition (SAM)", "MUAC under the severe cutoff, or bilateral pitting edema."),
      c("mam", "Moderate acute malnutrition (MAM)", "Children's MUAC between the severe and normal cutoffs."),
      c("severe-malnutrition", "Severe malnutrition", "Adult BMI under 16, or BMI-for-age z-score under -3."),
      c("moderate-malnutrition", "Moderate malnutrition", "Adult BMI 16 to under 17, BMI-for-age z-score -3 to under -2, or adult MUAC between the SAM and normal cutoffs."),
      c("mild-malnutrition", "Mild malnutrition", "Adult BMI 17 to under 18.5."),
      c("normal", "Normal nutritional status"),
      c("overweight", "Overweight", "Adult BMI 25 to under 30, or BMI-for-age z-score over +1 to +2."),
      c("obesity", "Obesity", "Adult BMI 30 or more, or BMI-for-age z-score over +2."),
    ],
  },
  "nacs-disposition": {
    title: "NACS management route for bilateral pitting edema",
    description: "The guide states: grade +++ is admitted for inpatient management of severe acute malnutrition; grades + or ++ with appetite and no medical complications are treated on an outpatient basis. Other combinations are not stated.",
    concepts: [
      c("inpatient-sam-management", "Inpatient management of SAM", "Grade +++, even with appetite and no medical complications."),
      c("outpatient-sam-treatment", "Outpatient treatment of SAM", "Grade + or ++ with appetite and no medical complications."),
      c("not-stated-by-guide", "Not stated by the guide", "Grade + or ++ without appetite or with medical complications: the clinician decides."),
    ],
  },
  "nacs-prepregnancy-bmi": {
    title: "NACS recommended pre-pregnancy BMI category",
    description: "Underweight under 18.5, normal weight 18.5-24.9, overweight 25.0-29.9, obese 30 or more.",
    concepts: [c("underweight", "Underweight"), c("normal-weight", "Normal weight"), c("overweight", "Overweight"), c("obese", "Obese")],
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
    concepts: [
      c("z-score", "Z-score"), c("percentile", "Percentile"), c("status", "Growth status"),
      c("indicator", "Growth indicator", "Which WHO indicator this Observation is (see growth-indicator)"),
      c("scheme", "Fixed MUAC scheme", "who_hiv_2008 or cmam"),
      c("reason", "Reason", "Why an acute-malnutrition signal was raised"),
      c("oedema-assessed", "Oedema assessed", "Always false: bilateral pitting oedema cannot be assessed from measurements"),
    ],
  },
  "growth-indicator": {
    title: "Growth indicator",
    description: "The WHO growth indicators evaluated by Observation/$evaluate-growth for a child from birth to 19 years.",
    concepts: [
      c("length-height-for-age", "Length/height-for-age", "WHO 2006 (0-60 months) and WHO 2007 (5-19 years)"),
      c("weight-for-age", "Weight-for-age", "WHO 2006 (0-60 months) and WHO 2007 (to 10 years)"),
      c("weight-for-length-height", "Weight-for-length/height", "WHO 2006, 0-60 months"),
      c("bmi-for-age", "BMI-for-age", "WHO 2006 under 5 years; WHO 2007 (Malawi MoH annex) for 5-19 years"),
      c("hc-for-age", "Head circumference-for-age", "WHO 2006, 0-60 months"),
      c("muac-for-age", "MUAC-for-age", "WHO 2006, 3-60 months"),
      c("muac-fixed-cutoffs", "MUAC fixed cut-offs", "who_hiv_2008 chart or CMAM 115/125 mm"),
      c("acute-malnutrition-signals", "Acute malnutrition signals", "Weight-for-length/height plus MUAC summary; oedema is not assessed"),
    ],
  },
  "acute-malnutrition-level": {
    title: "Acute malnutrition level",
    description: "Signal level from weight-for-length/height and MUAC (CMAM 115/125 mm). A screening aid, not a diagnosis.",
    concepts: [c("none", "None"), c("moderate", "Moderate"), c("severe", "Severe")],
  },
  "growth-status": {
    title: "Growth status",
    description: "Plain-language status from the Fenton preterm chart and the WHO growth indicators (birth to 19 years).",
    concepts: [
      c("small", "Small", "Fenton: z < -2"),
      c("appropriate", "Appropriate", "Fenton: z within +/-2"),
      c("large", "Large", "Fenton: z > +2"),
      c("normal", "Normal", "Within the normal range of the indicator"),
      c("severe thinness", "Severe thinness", "WHO BMI-for-age 5-19: below -3 SD"),
      c("thinness", "Thinness", "WHO BMI-for-age 5-19: -3 SD to below -2 SD"),
      c("overweight", "Overweight", "BMI-for-age or weight-for-length/height: above +2 SD (5-19: above +1 SD)"),
      c("obesity", "Obesity", "BMI-for-age or weight-for-length/height: above +3 SD (5-19: above +2 SD)"),
      c("possible risk of overweight", "Possible risk of overweight", "Under 5: above +1 SD to +2 SD"),
      c("moderate wasting", "Moderate wasting", "Under 5: -3 SD to below -2 SD"),
      c("severe wasting", "Severe wasting", "Under 5: below -3 SD"),
      c("stunted", "Stunted", "Length/height-for-age: -3 SD to below -2 SD"),
      c("severely stunted", "Severely stunted", "Length/height-for-age: below -3 SD"),
      c("tall", "Tall", "Length/height-for-age: above +2 SD"),
      c("very tall", "Very tall", "Length/height-for-age: above +3 SD"),
      c("underweight", "Underweight", "Weight-for-age: -3 SD to below -2 SD"),
      c("severely underweight", "Severely underweight", "Weight-for-age: below -3 SD"),
      c("high weight-for-age", "High weight-for-age", "Weight-for-age: above +2 SD"),
      c("very high weight-for-age", "Very high weight-for-age", "Weight-for-age: above +3 SD"),
      c("severe microcephaly", "Severe microcephaly", "Head circumference below -3 SD"),
      c("microcephaly", "Microcephaly", "Head circumference -3 SD to below -2 SD"),
      c("macrocephaly", "Macrocephaly", "Head circumference above +2 SD"),
      c("severe macrocephaly", "Severe macrocephaly", "Head circumference above +3 SD"),
      c("very low", "Very low", "MUAC-for-age: below -3 SD"),
      c("low", "Low", "MUAC-for-age: -3 SD to below -2 SD"),
      c("within expected range", "Within expected range", "MUAC-for-age: -2 SD to +2 SD"),
      c("high", "High", "MUAC-for-age: above +2 SD"),
      c("very high", "Very high", "MUAC-for-age: above +3 SD"),
      c("moderate", "Moderate", "Fixed MUAC cut-offs: moderate"),
      c("severe", "Severe", "Fixed MUAC cut-offs: severe"),
    ],
  },
  "assessment-item": {
    title: "Nutrition assessment items",
    description: "Assessment items that have no LOINC code: nutrition-impact symptoms, dietary intake summary items and nutrition-focused physical examination (NFPE) findings recorded by POST /fhir/Bundle/$nutrition-assessment and the built-in Questionnaires.",
    concepts: ASSESSMENT_ITEM_CONCEPTS.map((x) => c(x.code, x.display, x.definition)),
  },
  "nfpe-severity": {
    title: "NFPE finding severity",
    description: "Severity of a muscle or fat finding at an NFPE site. The grade is the examiner's judgement; Chakudya records it and never derives it.",
    concepts: NFPE_SEVERITY.map((x) => c(x.code, x.display, x.definition)),
  },
  "appetite-level": {
    title: "Appetite level",
    description: "Reported appetite, as recorded in the dietary intake summary.",
    concepts: APPETITE_LEVELS.map((x) => c(x.code, x.display)),
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
      "Classifies growth with the Fenton preterm chart (22-50 weeks gestation) or, from birthDate, with every WHO indicator the measurements allow from birth to 19 years: length/height-for-age, weight-for-age, weight-for-length/height, BMI-for-age, head circumference-for-age, MUAC-for-age, fixed MUAC cut-offs and acute-malnutrition signals. Returns an Observation or a Bundle of Observations.",
    parameters: [
      P("sex", "code", 1, "1", "male | female"),
      P("gestationalAgeWeeks", "integer", 0, "1", "22-50. Use this or birthDate."),
      P("gestationalAgeDays", "integer", 0, "1", "0-6, with gestationalAgeWeeks."),
      P("birthDate", "date", 0, "1", "Use this or gestationalAgeWeeks."),
      P("referenceYear", "integer", 0, "1", "Fenton reference year, if not the default."),
      P("measured", "code", 0, "1", "lying | standing. How length/height was measured; default lying under 24 months, standing from 24."),
      P("muacScheme", "code", 0, "1", "who_hiv_2008 | cmam. Fixed MUAC scheme; default cmam for 6-59 months."),
      EFFECTIVE,
      P("measurement", "Element", 1, "*", "One or more measurements.", [
        part("type", "code", 1, "1", "weight | length | hc | bmi | muac (muac in cm or mm; each type at most once; length is length or height, see measured)"),
        part("value", "Quantity", 1, "1", "The measured value with unit."),
      ]),
    ],
  },
  "Observation-screen": {
    resource: "Observation", code: "screen", title: "Nutrition screening (MUST, NRS-2002, MNA, SGA, PG-SGA or NACS classification)",
    description:
      "tool=must (default): Malnutrition Universal Screening Tool score and risk category; provide bmi, or weight + height; and weightLossPercent3to6Months, or usualWeight + weight. " +
      "tool=nrs-2002: two-stage NRS-2002 as printed in the source appendix (initial screening, then nutritional status + disease severity + age 70+); disease severity and impaired general condition are clinician inputs. " +
      "tool=mna: Mini Nutritional Assessment as printed on the Nestle form; screening items A-F always, assessment items G-R only when the screening score is 11 or less (12-14 stops at normal). Measured items are scored from raw values, judgement items are sent as the printed option score. " +
      "tool=sga: Subjective Global Assessment as printed on the NEMO form; history descriptors are mapped to their printed columns, % weight loss is derived, physical-examination grades are checked against the columns the form has, and the overall A/B/C rating is the assessor's own input (the form gives no rule to compute it). " +
      "tool=pg-sga: scored PG-SGA as printed on the form (v3.22.15): total = boxes 1-4 + disease + metabolic demand + physical exam, triaged 0-1, 2-3, 4-8, 9 or more; the physical-exam score is the clinician's overall deficit rating and the Stage A/B/C category is an optional assessor input. " +
      "tool=nacs: NACS User's Guide Module 2 classification, children and adults: MUAC by age group and pregnancy status, adult BMI, BMI-for-age z-score, pre-pregnancy BMI, and bilateral pitting edema (severe malnutrition on its own). Each indicator is reported separately; a single value is set only when exactly one was classified." + QUANTITY_NOTE,
    parameters: [
      P("tool", "code", 0, "1", "must (default) | nrs-2002 | mna | sga | pg-sga | nacs"),
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
      P("weightLossPercent6Months", "decimal", 0, "1", "SGA: weight loss over 6 months in percent (negative = gain). Alternative to usualWeight + weight."),
      P("weightChange2Weeks", "code", 0, "1", "SGA (required): no-change-normal-weight | increase-within-5-percent | increase-1-level-above | no-change-below-usual-weight | increase-within-5-10-percent | decrease."),
      P("weightChange2WeeksGrade", "code", 0, "1", "SGA: A or B, required when weightChange2Weeks is increase-1-level-above (listed in both columns)."),
      P("dietaryIntake", "code", 0, "1", "SGA (required): no-change-adequate | no-change-inadequate | suboptimal-diet | full-liquid | hypocaloric-liquid | starvation | borderline-increasing | borderline-decreasing | poor-no-change | poor-increasing | poor-decreasing."),
      P("dietaryIntakeGrade", "code", 0, "1", "SGA: B or C, required when dietaryIntake is poor-no-change (listed in both columns)."),
      P("nauseaDailyOver2Weeks", "boolean", 0, "1", "SGA (required): nausea daily for more than 2 weeks."),
      P("vomitingDailyOver2Weeks", "boolean", 0, "1", "SGA (required): vomiting daily for more than 2 weeks."),
      P("diarrhoeaDailyOver2Weeks", "boolean", 0, "1", "SGA (required): diarrhoea daily for more than 2 weeks."),
      P("anorexiaDailyOver2Weeks", "boolean", 0, "1", "SGA (required): anorexia daily for more than 2 weeks. GI grade: none A, one to three B, all four C."),
      P("functionalCapacity", "code", 0, "1", "SGA (required): no-dysfunction | difficulty-with-activities | bed-chair-ridden."),
      P("functionalChange2Weeks", "code", 0, "1", "SGA (required): improved | no-change | regressed."),
      P("overallRating", "code", 0, "1", "SGA (required): the assessor's overall rating, A, B or C. Never computed."),
      P("underEyesFat", "code", 0, "1", "SGA exam grade A or C (the form has no B for this site). Same for tricepsFat, bicepsFat, calf, knee, interosseousMuscle."),
      P("temple", "code", 0, "1", "SGA exam grade A, B or C. Same for clavicle, shoulder, scapulaRibs, quadriceps, oedema, ascites. All exam sites are optional."),
      P("weightOneMonthAgo", "Quantity", 0, "1", "PG-SGA: weight one month ago; with weight it derives the 1-month loss. 1-month data take priority over 6-month."),
      P("weightSixMonthsAgo", "Quantity", 0, "1", "PG-SGA: weight six months ago; used only when there is no 1-month data."),
      P("weightLossPercent1Month", "decimal", 0, "1", "PG-SGA: weight loss over 1 month in percent (negative = gain). Alternative to weightOneMonthAgo + weight. One of the 1-month or 6-month inputs is required."),
      P("pgsgaWeightChange2Weeks", "code", 0, "1", "PG-SGA Box 1 (required): decreased (1 point) | not-changed | increased."),
      P("pgsgaIntakeVsUsual", "code", 0, "1", "PG-SGA Box 2 (required): unchanged | more-than-usual | less-than-usual (1 point)."),
      P("pgsgaCurrentIntake", "code", 0, "1", "PG-SGA Box 2: normal-food-less-than-normal-amount (1) | little-solid-food (2) | only-liquids (3) | only-nutritional-supplements (3) | very-little-of-anything (4) | only-tube-feeding-or-parenteral (0). Box 2 takes the higher of the two answers."),
      P("pgsgaSymptom", "code", 0, "*", "PG-SGA Box 3 (at least one required, repeatable): no-problems-eating (0, cannot be combined) | no-appetite (3) | nausea (1) | vomiting (3) | constipation (1) | diarrhoea (3) | dry-mouth (1) | mouth-sores (2) | smells-bother-me (1) | taste-changes (1) | feel-full-quickly (1) | problems-swallowing (2) | fatigue (1) | pain (3) | other (1). Points are added."),
      P("pgsgaActivity", "code", 0, "1", "PG-SGA Box 4 (required): normal (0) | fairly-normal-activities (1) | in-bed-or-chair-less-than-half-day (2) | little-activity-most-of-day-in-bed-or-chair (3) | bed-ridden (3)."),
      P("cancer", "boolean", 0, "1", "PG-SGA Worksheet 2: 1 point each for cancer, aids, pulmonaryOrCardiacCachexia, chronicRenalInsufficiency, decubitusOpenWoundOrFistula, trauma (all booleans; not sent = absent). Age over 65 adds 1 from ageYears or birthDate (required for PG-SGA)."),
      P("feverTemperatureC", "decimal", 0, "1", "PG-SGA Worksheet 3: highest temperature in degrees Celsius. Above 37.2 scores 1, 38.3 or more 2, 38.8 or more 3. Not sent = no fever."),
      P("feverDurationHours", "decimal", 0, "1", "PG-SGA Worksheet 3: required when feverTemperatureC is above 37.2. Under 72 hours scores 1, 72 hours 2, over 72 hours 3. The greater of intensity and duration is scored."),
      P("corticosteroidPrednisoneEquivalentMgPerDay", "decimal", 0, "1", "PG-SGA Worksheet 3: under 10 mg scores 1, 10 to under 30 mg 2, 30 mg or more 3. Not sent or 0 = none."),
      P("physicalExamDeficit", "code", 0, "1", "PG-SGA Worksheet 4 (required): the clinician's overall rating of total body deficit: none (0) | mild (1) | moderate (2) | severe (3). Muscle deficit takes precedence over fat or fluid on the form. Never computed."),
      P("muscleStatusRating", "integer", 0, "1", "PG-SGA Worksheet 4, optional, recorded only: global muscle rating 0-3. Same for fatStoresRating and fluidStatusRating."),
      P("pgsgaGlobalCategory", "code", 0, "1", "PG-SGA Worksheet 5, optional: the assessor's Stage A, B or C. Never computed."),
      P("ageMonths", "integer", 0, "1", "NACS: age in months (required under 5 years; alternatively birthDate). ageYears (5 or over) also works."),
      P("pregnantOrPostpartum", "boolean", 0, "1", "NACS: pregnant or up to 6 months postpartum. Selects the pregnancy MUAC column; BMI is refused (422) for this group."),
      P("muacMm", "decimal", 0, "1", "NACS: mid-upper arm circumference in millimetres (50 to 500). Not for infants under 6 months (422)."),
      P("bmiForAgeZScore", "decimal", 0, "1", "NACS: BMI-for-age z-score for 5 to 17 years (Observation/$evaluate-growth can compute it). Under 18 a bmi or weight + height alone is a 400."),
      P("prePregnancyBmi", "decimal", 0, "1", "NACS: pre-pregnancy BMI; reported as underweight, normal weight, overweight or obese."),
      P("edemaGrade", "integer", 0, "1", "NACS: bilateral pitting edema grade 0-3 (0 none, 1 +, 2 ++, 3 +++). Above 0 needs edemaBothFeetOrLegs."),
      P("edemaBothFeetOrLegs", "boolean", 0, "1", "NACS: edema is in both feet or both legs. Only then is it a sign of severe malnutrition; the result is SAM and no anthropometry is classified."),
      P("hasAppetite", "boolean", 0, "1", "NACS: required for edema grade 1 or 2 (outpatient route needs appetite)."),
      P("hasMedicalComplications", "boolean", 0, "1", "NACS: required for edema grade 1 or 2 (outpatient route needs no medical complications)."),
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
  "Bundle-nutrition-assessment": {
    resource: "Bundle", code: "nutrition-assessment", title: "Structured nutrition assessment",
    description:
      "NCP step 1 foundation. Validates a Patient (or takes a reference), an Encounter (or a reference) and the assessment data, and returns one collection Bundle of Patient, Encounter, QuestionnaireResponses and Observations linked to them: anthropometry, biochemical, clinical findings, dietary intake and NFPE. Units are never guessed and plausibility, timestamps and missing data are checked; several problems are reported at once. Computes BMI (with the WHO adult class for 18+) and the MUST score when the nutrition-screening form is submitted. Does not grade NFPE findings or invent reference ranges.",
    parameters: [
      P("patient", "Resource", 0, "1", "A Patient resource (identifier or name needed; telecom, address etc. are not carried). Give this or subject."),
      P("subject", "string", 0, "1", 'A reference to an existing patient, e.g. "Patient/123". Give this or patient.'),
      P("encounter", "Resource", 1, "1", 'An Encounter resource (status and class required), or a reference string such as "Encounter/456".'),
      P("effectiveDateTime", "dateTime", 0, "1", "Default time of the observations. Defaults to the encounter's period.start, else now."),
      P("author", "string", 0, "1", 'A reference ("Practitioner/123") or the assessor\'s name; set as performer.'),
      P("ageYears", "integer", 0, "1", "Age in whole years if no full Patient.birthDate; used for the WHO adult BMI class and the MUST adult check."),
      P("observation", "Element", 0, "*", "One measurement, up to 100. Registered codes (see GET /fhir/CodeSystem/assessment-item and the LOINC items in the README) or a custom system + code + display.", [
        part("code", "code", 1, "1", "Registered measurement code, e.g. weight, height, hemoglobin, systolic-bp, energy-intake-kcal, temple-muscle. With system: your own code."),
        part("value", "Quantity", 0, "1", "A Quantity with unit (quantities), integer, boolean, code (appetite, NFPE severity) or string, depending on the code. Absent only with dataAbsentReason."),
        part("domain", "code", 0, "1", "anthropometry | biochemical | clinical | dietary | nfpe. Checked against a registered code; required for a custom code."),
        part("effectiveDateTime", "dateTime", 0, "1", "When this was measured; overrides the default."),
        part("referenceLow", "Quantity", 0, "1", "The lab's own lower reference limit, same unit as the value. Gives an interpretation flag."),
        part("referenceHigh", "Quantity", 0, "1", "The lab's own upper reference limit, same unit as the value."),
        part("interpretation", "code", 0, "1", "N | L | H | LL | HH | A | AA, if you want to state it."),
        part("dataAbsentReason", "code", 0, "1", "unknown | asked-unknown | not-asked | asked-declined | not-performed | not-applicable, instead of a value."),
        part("note", "string", 0, "1", "Free-text note."),
        part("system", "uri", 0, "1", "Code system of a custom code."),
        part("display", "string", 0, "1", "Display of a custom code; required with system."),
      ]),
      P("questionnaireResponse", "Resource", 0, "*", "A QuestionnaireResponse, up to 10. Built-in forms (GET /fhir/Questionnaire) are validated item by item and their answers become Observations; other forms are checked structurally."),
    ],
  },
  "QuestionnaireResponse-validate": {
    resource: "QuestionnaireResponse", code: "validate", title: "Validate a nutrition questionnaire response",
    returnType: "OperationOutcome",
    returnDoc: "An OperationOutcome listing every issue (200 even when invalid; check issue severity). Nothing is built or stored.",
    description:
      "Checks a QuestionnaireResponse against a built-in Questionnaire (GET /fhir/Questionnaire): linkIds, answer types, units and ranges, answer options and required items. A form that is not built in is checked structurally only.",
    parameters: [
      P("resource", "QuestionnaireResponse", 1, "1", "The QuestionnaireResponse to check."),
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
        name: "return", use: "out", min: 1, max: "1", type: o.returnType ?? "Bundle",
        documentation: o.returnDoc ?? "A Bundle on success; an OperationOutcome on failure (400 malformed, 422 valid but unsupported).",
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
  "growth-reference-used": X("string", ["Observation"], "Which growth reference produced the classification (Fenton, or a WHO 2006/2007 standard such as who-2006-weight-for-age)."),
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

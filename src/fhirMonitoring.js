// FHIR R4 facade: Nutrition monitoring and evaluation (NCP step 4).
//
//   POST /fhir/CarePlan/$monitor
//
// Records a follow-up visit against an existing care plan and shows progress:
//
//   * follow-up measurements: `observation` and `questionnaireResponse` parts
//     are validated by the same code as $nutrition-assessment (anthropometry,
//     dietary intake, laboratory results, clinical findings, NFPE; repeated
//     questionnaires), then tagged as step 4 Observations. Each one is linked
//     to the patient, the encounter and the care plan (Observation.basedOn);
//   * comparison with baseline: pass the $nutrition-assessment Bundle as
//     `baseline` (and earlier $monitor Bundles as `previous`). A numeric
//     follow-up value gets the change and the percent change from baseline,
//     and from the previous value, with references to the Observations
//     compared. Units are never converted: a unit mismatch is reported and
//     nothing is compared;
//   * goal status: pass the $intervene Bundle as `resource`. Each Goal is
//     matched to the follow-up value of its measure (or to an explicit
//     `current`), judged with the same rules as Goal/$evaluate, and returned
//     with achievementStatus, statusDate, an outcome reference, a progress
//     note and the patient's response when one is given;
//   * plan revision: when a goal is worsening, unchanged, not achieved or past
//     its due date unmet, a plan-review Task is created per goal and a DRAFT
//     successor CarePlan (replaces the current one) carries the plan forward
//     for the dietitian to revise. The original plan is never edited;
//   * one Provenance for everything recorded, when an author is given.
//
// STATELESS and pure, like the rest of the facade. Chakudya compares and
// shapes what the dietitian supplies; it does not decide that a goal is met
// or what the revised plan should be, and it does not notify anyone.

import { readParams, requireParameters, stepCategory, evaluateOneGoal } from "./fhirNcp.js";
import { evaluateNutritionAssessment, parseFhirTime, ITEMS } from "./fhirAssessment.js";

const GOAL_ACHIEVEMENT = "http://terminology.hl7.org/CodeSystem/goal-achievement";
const PROV_PARTICIPANT = "http://terminology.hl7.org/CodeSystem/provenance-participant-type";
const V3_DATA_OPERATION = "http://terminology.hl7.org/CodeSystem/v3-DataOperation";
const UCUM = "http://unitsofmeasure.org";
const NCP_STEP_ASSESSMENT = "nutrition-assessment";
const NCP_STEP_MONITORING = "nutrition-monitoring";

const str = (x) => (typeof x === "string" && x.trim() ? x.trim() : undefined);
const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const round = (x, dp) => { const f = 10 ** dp; return Math.round(x * f) / f; };
const cs = (base, name) => `${base}/fhir/CodeSystem/${name}`;
const sd = (base, name) => `${base}/fhir/StructureDefinition/${name}`;
const newUuid = (ctx) => `urn:uuid:${(ctx.uuid ?? (() => crypto.randomUUID()))()}`;
const unitKey = (q) => (q?.code || q?.unit || "").toLowerCase();

const REF_ENCOUNTER = /^(https?:\/\/\S+\/)?Encounter\/[A-Za-z0-9\-.]{1,64}$|^urn:uuid:[0-9a-fA-F-]{36}$/;
const REF_ANY = /^(https?:\/\/\S+\/)?[A-Za-z]+\/[A-Za-z0-9\-.]{1,64}$|^urn:uuid:[0-9a-fA-F-]{36}$/;
const MAX_GOALS = 50;

const party = (value) => {
  const s = str(value);
  if (!s) return null;
  return REF_ANY.test(s) ? { reference: s } : { display: s.slice(0, 200) };
};
const fail = (issues, status = 400) => ({
  ok: false, status,
  outcome: { resourceType: "OperationOutcome", issue: issues.map((diagnostics) => ({ severity: "error", code: "invalid", diagnostics })) },
});

/** A resource's reference inside a Bundle: its fullUrl, else Type/id. */
const refOf = (entry) => entry.fullUrl ?? (entry.resource?.id ? `${entry.resource.resourceType}/${entry.resource.id}` : undefined);

/** Flattens `resource` / `baseline` / `previous` params (Bundles or single resources) to [{ref, resource}]. */
function collect(values) {
  const out = [];
  for (const v of values) {
    if (!isObj(v)) continue;
    if (v.resourceType === "Bundle") for (const en of v.entry ?? []) { if (isObj(en?.resource)) out.push({ ref: refOf(en), resource: en.resource }); }
    else if (v.resourceType) out.push({ ref: refOf({ resource: v }), resource: v });
  }
  return out;
}

const codingsOf = (obs) => (obs.code?.coding ?? []).filter((c) => c?.code);
const keysOf = (obs) => codingsOf(obs).map((c) => `${c.system ?? ""}|${c.code}`);
const msOf = (obs) => {
  const t = typeof obs.effectiveDateTime === "string" ? parseFhirTime(obs.effectiveDateTime) : null;
  return t ? t.ms : null;
};
const numericQuantity = (obs) => (isNum(obs.valueQuantity?.value) ? obs.valueQuantity : null);
const labelOf = (obs) => obs.code?.text ?? codingsOf(obs)[0]?.display ?? codingsOf(obs)[0]?.code ?? "measurement";

/** Numeric Observations from supplied history, with a sortable time. */
function observationPool(entries) {
  return entries
    .filter((e) => e.resource.resourceType === "Observation" && numericQuantity(e.resource) && e.resource.status !== "entered-in-error" && e.resource.status !== "cancelled")
    .map((e) => ({ ref: e.ref, obs: e.resource, ms: msOf(e.resource) }))
    .filter((x) => x.ms !== null);
}

const extValue = (resource, name) => (resource.extension ?? []).find((x) => typeof x?.url === "string" && x.url.endsWith(`/StructureDefinition/${name}`));

export function evaluateMonitor(body, ctx) {
  const e = requireParameters(body);
  if (e) return e;
  const p = readParams(body);
  const base = ctx.base;
  const nowMs = Date.parse(ctx.now);
  const today = Math.floor(nowMs / 86400000) * 86400000;
  const errors = [];
  const notes = [];
  const warn = (diagnostics, code = "business-rule") => notes.push({ severity: "warning", code, diagnostics });
  const info = (diagnostics) => notes.push({ severity: "information", code: "informational", diagnostics });

  // 1. The plan, its goals, and the history to compare with
  const supplied = collect(p.all("resource"));
  const plans = supplied.filter((x) => x.resource.resourceType === "CarePlan");
  if (plans.length > 1) errors.push("Supply one CarePlan in 'resource': monitoring is recorded against a single plan.");
  const plan = plans[0] ?? null;
  const planRef = plan?.ref;
  if (plan && !planRef) errors.push("The supplied CarePlan has no id or fullUrl, so follow-up results cannot be linked to it. Pass the Bundle returned by CarePlan/$intervene.");
  const planGoals = supplied.filter((x) => x.resource.resourceType === "Goal");
  for (const g of planGoals) if (!g.ref) errors.push("A supplied Goal has no id or fullUrl, so its progress cannot be traced. Pass the Bundle returned by CarePlan/$intervene.");

  const baselinePool = observationPool(collect(p.all("baseline")));
  const previousPool = observationPool(collect(p.all("previous")));

  // 2. Patient and encounter
  let subject = str(p.get("subject"));
  const planSubjects = [...new Set([plan?.resource.subject?.reference, ...planGoals.map((g) => g.resource.subject?.reference)].filter(Boolean))];
  if (planSubjects.length > 1) errors.push(`The supplied plan and goals belong to different patients (${planSubjects.join(", ")}).`);
  else if (planSubjects.length === 1) {
    if (subject && subject !== planSubjects[0]) errors.push(`'subject' ${subject} is not the patient of the supplied plan (${planSubjects[0]}).`);
    subject = subject ?? planSubjects[0];
  }
  if (!subject) errors.push("'subject' is required (e.g. valueString \"Patient/123\"), unless the supplied plan names the patient.");
  const encounter = str(p.get("encounter"));
  if (!encounter) errors.push("'encounter' is required: follow-up results belong to an encounter (e.g. \"Encounter/456\").");
  else if (!REF_ENCOUNTER.test(encounter)) errors.push(`'encounter' must be an Encounter reference such as "Encounter/456" (got "${encounter.slice(0, 80)}").`);
  if (p.all("resource").length === 0 && p.all("goal").length === 0 && p.all("observation").length === 0 && p.all("questionnaireResponse").length === 0) {
    errors.push("Nothing to monitor: supply 'resource' (the care plan Bundle), 'observation' / 'questionnaireResponse' parts, or 'goal' parts.");
  }

  const author = p.get("author") !== undefined ? party(p.get("author")) : null;
  const sources = p.all("source").map(str).filter(Boolean);
  if (sources.length && !author) errors.push("'source' needs an 'author': provenance records who recorded the follow-up from which sources.");
  const effective = str(p.get("effectiveDateTime")) ?? ctx.now;
  const effT = parseFhirTime(effective);
  if (!effT) errors.push(`effectiveDateTime "${effective}" is not a valid FHIR date or dateTime.`);
  const reviewDue = str(p.get("reviewDueDate"));
  if (reviewDue !== undefined) {
    const t = parseFhirTime(reviewDue);
    if (!t || t.precision !== "day") errors.push(`reviewDueDate "${reviewDue}" must be a full date (YYYY-MM-DD).`);
    else if (t.ms < today) errors.push(`reviewDueDate ${reviewDue} is in the past.`);
  }
  const goalParts = p.all("goal");
  if (goalParts.length + planGoals.length > MAX_GOALS) errors.push(`At most ${MAX_GOALS} goals per request.`);
  if (errors.length) return fail(errors);

  // 3. Follow-up observations: same validation as $nutrition-assessment
  const hasData = p.all("observation").length + p.all("questionnaireResponse").length > 0;
  const newObs = []; // { ref, resource }
  const newQr = [];
  if (hasData) {
    const forward = [
      { name: "subject", valueString: subject },
      { name: "encounter", valueString: encounter },
      { name: "effectiveDateTime", valueString: effective },
      ...(p.get("author") !== undefined ? [{ name: "author", valueString: str(p.get("author")) }] : []),
      ...(p.get("ageYears") !== undefined ? [{ name: "ageYears", valueInteger: p.get("ageYears") }] : []),
      ...(body.parameter ?? []).filter((x) => x?.name === "observation" || x?.name === "questionnaireResponse"),
    ];
    const r = evaluateNutritionAssessment({ resourceType: "Parameters", parameter: forward }, ctx);
    if (!r.ok) return r;
    for (const en of r.body.entry) {
      const res = en.resource;
      if (res.resourceType === "Observation") {
        // step 4, not step 1; link to the plan
        res.category = (res.category ?? []).map((c) => ({
          ...c,
          coding: (c.coding ?? []).map((k) => (k.system === cs(base, "ncp-step") && k.code === NCP_STEP_ASSESSMENT ? { ...k, code: NCP_STEP_MONITORING } : k)),
        }));
        if (planRef) res.basedOn = [{ reference: planRef }];
        newObs.push({ ref: en.fullUrl, resource: res });
      } else if (res.resourceType === "QuestionnaireResponse") {
        if (planRef) res.basedOn = [{ reference: planRef }];
        newQr.push({ ref: en.fullUrl, resource: res });
      } else if (res.resourceType === "OperationOutcome") {
        for (const i of res.issue ?? []) if (!/^No \w+ data supplied\.$/.test(i.diagnostics ?? "") && !/^BMI not computed: body (height|weight) is missing\.$/.test(i.diagnostics ?? "")) notes.push(i);
      }
    }
  }
  if (!planRef && hasData) info("No care plan was supplied, so the follow-up Observations are not linked to a plan (pass the CarePlan/$intervene Bundle as 'resource').");

  // 4. Compare each numeric follow-up value with baseline and previous
  const baselineUsed = new Map(); // ref -> observation
  const compare = (nObs, nMs, pool, picker) => {
    const q = numericQuantity(nObs);
    const keys = new Set(keysOf(nObs));
    const cands = pool.filter((c) => c.ms < nMs && keysOf(c.obs).some((k) => keys.has(k)));
    if (!cands.length) return null;
    const hit = picker(cands);
    const hq = numericQuantity(hit.obs);
    if (unitKey(hq) !== unitKey(q)) {
      warn(`${labelOf(nObs)}: not compared with ${hit.ref ?? "an earlier value"} because the units differ ("${unitKey(hq) || "none"}" vs "${unitKey(q) || "none"}"). Units are never converted.`);
      return null;
    }
    return { hit, change: q.value - hq.value, from: hq };
  };
  const earliest = (c) => c.reduce((a, b) => (b.ms < a.ms ? b : a));
  const latest = (c) => c.reduce((a, b) => (b.ms > a.ms ? b : a));
  const changeQuantity = (v, q) => ({ value: round(v, 4), ...(q.unit ? { unit: q.unit } : {}), ...(q.system ? { system: q.system } : {}), ...(q.code ? { code: q.code } : {}) });
  let compared = 0;
  for (const { resource: o } of newObs) {
    const q = numericQuantity(o);
    const nMs = msOf(o);
    if (!q || nMs === null) continue;
    const ext = [];
    const b = compare(o, nMs, baselinePool, earliest);
    if (b) {
      compared++;
      if (b.hit.ref) { ext.push({ url: sd(base, "baseline-observation"), valueReference: { reference: b.hit.ref } }); baselineUsed.set(b.hit.ref, b.hit.obs); }
      ext.push({ url: sd(base, "change-from-baseline"), valueQuantity: changeQuantity(b.change, q) });
      if (b.from.value !== 0) ext.push({ url: sd(base, "percent-change-from-baseline"), valueDecimal: round((b.change / b.from.value) * 100, 1) });
    }
    const prev = compare(o, nMs, [...baselinePool, ...previousPool], latest);
    if (prev && !(b && prev.hit.ref && prev.hit.ref === b.hit.ref)) {
      if (prev.hit.ref) ext.push({ url: sd(base, "previous-observation"), valueReference: { reference: prev.hit.ref } });
      ext.push({ url: sd(base, "change-from-previous"), valueQuantity: changeQuantity(prev.change, q) });
    }
    if (ext.length) o.extension = [...(o.extension ?? []), ...ext];
  }
  if ((baselinePool.length || previousPool.length) && newObs.length && compared === 0) {
    info("No follow-up value could be compared with the supplied baseline (no earlier Observation with the same code and unit).");
  }

  // 5. Goals
  const goalInputs = []; // { origin: "plan"|"inline", entry?, view, part? }
  const overrides = new Map(); // goal ref -> part reader
  const inline = [];
  for (const [i, g] of goalParts.entries()) {
    if (typeof g?.get !== "function") { errors.push(`goal[${i}] must be a part with nested parts.`); continue; }
    const reference = str(g.get("reference"));
    if (reference) {
      if (!planGoals.some((x) => x.ref === reference)) errors.push(`goal[${i}].reference ${reference} does not resolve to a Goal in the supplied plan.`);
      else overrides.set(reference, g);
    } else inline.push({ g, i });
  }
  if (errors.length) return fail(errors);

  const viewOfPlanGoal = (entry) => {
    const g = entry.resource;
    const t = g.target?.[0] ?? {};
    return {
      description: g.description?.text,
      direction: extValue(g, "goal-direction")?.valueCode,
      baseline: extValue(g, "goal-baseline")?.valueQuantity,
      target: t.detailQuantity,
      due: t.dueDate,
      measureText: t.measure?.text,
      measureCode: t.measure?.coding?.[0]?.code,
    };
  };
  for (const entry of planGoals) {
    const lc = entry.resource.lifecycleStatus;
    if (["completed", "cancelled", "rejected", "entered-in-error"].includes(lc)) { info(`Goal ${entry.ref} is ${lc} and was not re-evaluated.`); continue; }
    goalInputs.push({ origin: "plan", entry, view: viewOfPlanGoal(entry), part: overrides.get(entry.ref) });
  }
  for (const { g, i } of inline) {
    goalInputs.push({
      origin: "inline", label: `goal[${i}]`, part: g,
      view: {
        description: str(g.get("description")), direction: str(g.get("direction")),
        baseline: g.get("baseline"), target: g.get("target"), due: str(g.get("dueDate")),
        measureText: str(g.get("measure")), measureCode: str(g.get("measureCode")),
      },
    });
  }

  const findFollowUp = (view) => {
    const wanted = new Set();
    if (view.measureCode) { wanted.add(view.measureCode); if (ITEMS[view.measureCode]?.loinc) wanted.add(ITEMS[view.measureCode].loinc); }
    const text = view.measureText?.toLowerCase();
    const hits = newObs.filter(({ resource: o }) => {
      if (!numericQuantity(o)) return false;
      if (codingsOf(o).some((c) => wanted.has(c.code))) return true;
      return Boolean(text) && [o.code?.text, ...codingsOf(o).map((c) => c.display)].some((t) => t && t.toLowerCase() === text);
    });
    if (!hits.length) return null;
    return hits.reduce((a, b) => ((msOf(b.resource) ?? 0) > (msOf(a.resource) ?? 0) ? b : a));
  };

  const goalEntries = [];
  const outcomeEntries = [];
  const evaluated = []; // { ref, status, due, description }
  const newGoalEntries = [];
  const created = [];
  const asAuthorNote = (text) => ({ text, time: ctx.now, ...(author?.reference ? { authorReference: author } : author?.display ? { authorString: author.display } : {}) });

  for (const gi of goalInputs) {
    const label = gi.origin === "plan" ? `Goal ${gi.entry.ref}` : gi.label;
    const v = gi.view;
    const part = gi.part;
    const fatal = (m) => { if (gi.origin === "inline") errors.push(`${label}: ${m}`); else warn(`${label} was not evaluated: ${m}`); };
    if (!v.description) { fatal("a description is required."); continue; }
    const direction = str(part?.get("direction")) ?? v.direction;
    if (!direction) { fatal("it has no direction (increase, decrease or maintain)."); continue; }

    // current value: explicit, else the follow-up Observation for the measure
    let current = part?.get("current");
    let source = null;
    if (current !== undefined) {
      if (!isObj(current) || !isNum(current.value)) { fatal("'current' must be a Quantity with a numeric value."); continue; }
    } else {
      source = findFollowUp(v);
      if (!source) { fatal(`no follow-up value for "${v.measureText ?? v.measureCode ?? "its measure"}" was supplied (record the measurement, or pass 'current').`); continue; }
      current = numericQuantity(source.resource);
    }

    // baseline: goal baseline, else the baseline Observation of the same measure
    let baselineQ = part?.get("baseline") ?? v.baseline;
    let derivedBaseline = null;
    if (!baselineQ) {
      const probe = source ? source.resource : null;
      const hit = probe ? (() => {
        const keys = new Set(keysOf(probe));
        const c = baselinePool.filter((x) => keysOf(x.obs).some((k) => keys.has(k)));
        return c.length ? earliest(c) : null;
      })() : null;
      if (hit && unitKey(numericQuantity(hit.obs)) === unitKey(current)) { baselineQ = numericQuantity(hit.obs); derivedBaseline = hit; }
    }

    const parts = [
      { name: "description", valueString: v.description },
      { name: "direction", valueString: direction },
      { name: "current", valueQuantity: current },
      ...(v.target ? [{ name: "target", valueQuantity: v.target }] : []),
      ...(baselineQ ? [{ name: "baseline", valueQuantity: baselineQ }] : []),
      ...(part?.get("lowerBound") ? [{ name: "lowerBound", valueQuantity: part.get("lowerBound") }] : []),
      ...(part?.get("upperBound") ? [{ name: "upperBound", valueQuantity: part.get("upperBound") }] : []),
      ...(isNum(part?.get("noChangeTolerance")) ? [{ name: "noChangeTolerance", valueDecimal: part.get("noChangeTolerance") }] : []),
      ...(v.measureText ? [{ name: "measure", valueString: v.measureText }] : []),
    ];
    const r = evaluateOneGoal(readParams({ parameter: parts }), label);
    if (!r.ok) { fatal(r.outcome.issue[0].diagnostics); continue; }

    // outcome Observation: the follow-up one, or one made from an explicit 'current'
    let outcomeRef;
    if (source) outcomeRef = source.ref;
    else {
      outcomeRef = newUuid(ctx);
      const synthetic = {
        resourceType: "Observation", status: "final",
        category: stepCategory(base, "monitoring"),
        code: v.measureCode
          ? { coding: [{ system: cs(base, "ncp-indicator"), code: v.measureCode, ...(v.measureText ? { display: v.measureText } : {}) }], text: v.measureText ?? v.measureCode }
          : { text: v.measureText ?? v.description },
        subject: { reference: subject }, encounter: { reference: encounter },
        effectiveDateTime: effective, ...(author ? { performer: [author] } : {}),
        ...(planRef ? { basedOn: [{ reference: planRef }] } : {}),
        valueQuantity: r.current,
      };
      outcomeEntries.push({ fullUrl: outcomeRef, resource: synthetic });
    }

    const response = str(part?.get("response"));
    const extList = [];
    const progressUrl = sd(base, "goal-progress-fraction");
    const orig = gi.entry?.resource;
    const prior = (orig?.extension ?? []).filter((x) => x.url !== progressUrl);
    extList.push(...prior);
    if (derivedBaseline && !extValue({ extension: prior }, "goal-baseline")) extList.push({ url: sd(base, "goal-baseline"), valueQuantity: r.baseline });
    if (r.progress !== null) extList.push({ url: progressUrl, valueDecimal: round(r.progress, 3) });
    if (derivedBaseline?.ref) baselineUsed.set(derivedBaseline.ref, derivedBaseline.obs);
    if (!extValue({ extension: extList }, "goal-direction")) extList.push({ url: sd(base, "goal-direction"), valueCode: direction });

    const goal = orig ? structuredClone(orig) : {
      resourceType: "Goal",
      category: [{ coding: [{ system: cs(base, "ncp-step"), code: NCP_STEP_MONITORING }] }],
      description: { text: v.description }, subject: { reference: subject },
    };
    goal.lifecycleStatus = r.status === "achieved" ? "completed" : "active";
    goal.achievementStatus = { coding: [{ system: GOAL_ACHIEVEMENT, code: r.status }] };
    goal.statusDate = effective.slice(0, 10);
    goal.outcomeReference = [...(goal.outcomeReference ?? []), { reference: outcomeRef }];
    if (!goal.target && v.target) goal.target = [{ ...(v.measureText ? { measure: { text: v.measureText } } : {}), detailQuantity: v.target, ...(v.due ? { dueDate: v.due } : {}) }];
    goal.note = [...(goal.note ?? []), asAuthorNote(r.reason), ...(response ? [asAuthorNote(`Patient response: ${response}`)] : [])];
    goal.extension = extList;

    const ref = gi.origin === "plan" ? gi.entry.ref : newUuid(ctx);
    const out = { fullUrl: ref, resource: goal };
    (gi.origin === "plan" ? goalEntries : newGoalEntries).push(out);
    evaluated.push({ ref, status: r.status, due: v.due, description: v.description, progress: r.progress });
  }
  if (errors.length) return fail(errors);

  // 6. Review: which goals need the plan revisited
  const todayStr = effective.slice(0, 10);
  const needsReview = evaluated.filter((g) => {
    if (["worsening", "no-change", "not-achieved"].includes(g.status)) return true;
    return Boolean(g.due) && g.due < todayStr && !["achieved", "sustaining"].includes(g.status);
  });
  const reviewReason = (g) => (["worsening", "no-change", "not-achieved"].includes(g.status) ? `status is ${g.status}` : `due date ${g.due} has passed and the goal is ${g.status}`);

  const tasks = [];
  for (const g of needsReview) {
    tasks.push({
      fullUrl: newUuid(ctx),
      resource: {
        resourceType: "Task", status: "requested", intent: "proposal",
        ...(planRef ? { basedOn: [{ reference: planRef }] } : {}),
        focus: { reference: g.ref },
        code: { coding: [{ system: cs(base, "ncp-monitoring-action"), code: "plan-review", display: "Review and revise the nutrition care plan" }] },
        description: `Review the nutrition intervention for the goal "${g.description}": ${reviewReason(g)}.`,
        for: { reference: subject }, encounter: { reference: encounter },
        authoredOn: ctx.now, lastModified: ctx.now,
        ...(author ? { requester: author } : {}),
        ...(reviewDue ? { restriction: { period: { end: reviewDue } } } : {}),
        reasonCode: { text: `Goal ${reviewReason(g)}` },
      },
    });
  }

  let successor = null;
  if (needsReview.length && plan) {
    const cp = structuredClone(plan.resource);
    delete cp.id; delete cp.meta;
    cp.status = "draft"; cp.intent = "proposal";
    cp.replaces = [{ reference: planRef }];
    cp.created = ctx.now;
    cp.encounter = { reference: encounter };
    if (author) cp.author = author;
    cp.title = `${plan.resource.title ?? "Nutrition care plan"} (revision)`;
    const refs = [...new Set([...newObs.map((o) => o.ref), ...outcomeEntries.map((o) => o.fullUrl)])];
    if (refs.length) cp.supportingInfo = [...(plan.resource.supportingInfo ?? []), ...refs.map((reference) => ({ reference }))];
    cp.note = [...(plan.resource.note ?? []), { text: `Draft revision after monitoring on ${todayStr}. Goals to review: ${needsReview.map((g) => `"${g.description}" (${reviewReason(g)})`).join("; ")}. Edit the activities, then record the revised plan with CarePlan/$intervene.`, time: ctx.now }];
    successor = { fullUrl: newUuid(ctx), resource: cp };
  } else if (needsReview.length && !plan) {
    info("Goals need review, but no CarePlan was supplied, so no draft revision was made (pass the CarePlan/$intervene Bundle as 'resource').");
  }
  if (evaluated.length && needsReview.length === 0 && evaluated.every((g) => ["achieved", "sustaining"].includes(g.status))) {
    info("Every evaluated goal is achieved or sustained: consider closing the plan or setting new goals. The plan was not changed.");
  }
  if (evaluated.length) {
    const tally = {};
    for (const g of evaluated) tally[g.status] = (tally[g.status] ?? 0) + 1;
    info(`Evaluated ${evaluated.length} goal(s): ${Object.entries(tally).map(([k, n]) => `${n} ${k}`).join(", ")}.`);
  }
  if (goalInputs.length === 0 && planGoals.length === 0 && goalParts.length === 0 && hasData) {
    info("No goals were supplied, so only the follow-up measurements were recorded (pass the CarePlan/$intervene Bundle as 'resource' to evaluate goals).");
  }

  // 7. Assemble
  const asEntry = (x) => ({ fullUrl: x.ref, resource: x.resource });
  const entries = [...newQr.map(asEntry), ...newObs.map(asEntry), ...outcomeEntries, ...goalEntries, ...newGoalEntries, ...tasks, ...(successor ? [successor] : [])];
  if (entries.length === 0) {
    return fail(["Nothing was recorded or evaluated. Supply follow-up 'observation' parts, or a plan with goals and matching measurements."], 422);
  }
  created.push(...entries);
  if (author) {
    entries.push({
      fullUrl: newUuid(ctx),
      resource: {
        resourceType: "Provenance",
        target: created.map((x) => ({ reference: x.fullUrl })),
        recorded: ctx.now,
        activity: { coding: [{ system: V3_DATA_OPERATION, code: "CREATE", display: "create" }] },
        agent: [{ type: { coding: [{ system: PROV_PARTICIPANT, code: "author", display: "Author" }] }, who: author }],
        entity: [
          ...(planRef ? [{ role: "derivation", what: { reference: planRef } }] : []),
          ...[...baselineUsed.keys()].map((reference) => ({ role: "source", what: { reference } })),
          ...sources.map((display) => ({ role: "source", what: { display } })),
        ],
      },
    });
  }
  if (notes.length) entries.push({ fullUrl: newUuid(ctx), resource: { resourceType: "OperationOutcome", issue: notes } });

  return { ok: true, status: 200, body: { resourceType: "Bundle", type: "collection", timestamp: ctx.now, entry: entries } };
}

export const MONITORING_OPERATIONS = { "CarePlan/$monitor": evaluateMonitor };
export const monitoringOperationFor = (param, action) => MONITORING_OPERATIONS[`${param}/${action}`] ?? null;

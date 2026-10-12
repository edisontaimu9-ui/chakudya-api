// FHIR R4 facade — Nutrition intervention (NCP step 3), structured.
//
//   POST /fhir/CarePlan/$intervene
//
// Builds on the base operation in src/fhirNcp.js (CarePlan, Goal,
// NutritionOrder for oral diets / supplements / enteral formula, and
// ServiceRequest for education, counseling and coordination) and adds what a
// documented, trackable intervention needs:
//
//   * a link to the nutrition diagnosis: pass the $diagnose Bundle as
//     `resource` and the plan, goals, orders, requests and tasks all address
//     its Condition(s); explicit `addresses` references are checked against it
//     (they must resolve, belong to the same patient, and not be refuted);
//   * measurable goals with target dates: dates must be valid and in order,
//     a target needs a unit, baseline and target must share a unit and agree
//     with the direction of change, and missing measure / direction / target
//     date are flagged;
//   * validated orders: units are never guessed, enteral rates are mL/h and
//     volumes mL, and an order can carry a schedule, food preferences,
//     exclusions and allergy references;
//   * Tasks: who does what by when, for education, counseling, coordination,
//     follow-up and referrals (a Task per activity that has an owner or a due
//     date, always for follow-up and referral), pointing at the CarePlan and
//     the ServiceRequest;
//   * `followUp` (a dated review) and `referral` (to another professional or
//     service, with priority and reason) as ServiceRequests;
//   * recorder / encounter links and one Provenance for the whole plan.
//
// STATELESS and pure, like the rest of the facade. Chakudya shapes and
// validates what the dietitian supplies; it does not decide the plan, and it
// does not send referrals or notify anyone: the Tasks are for the caller's
// system to carry out.
//
// Backward compatible: every input the base operation accepted still works.

import { readParams, requireParameters, evaluateIntervene } from "./fhirNcp.js";
import { parseFhirTime } from "./fhirAssessment.js";

const UCUM = "http://unitsofmeasure.org";
const SNOMED = "http://snomed.info/sct";
const PROV_PARTICIPANT = "http://terminology.hl7.org/CodeSystem/provenance-participant-type";
const V3_DATA_OPERATION = "http://terminology.hl7.org/CodeSystem/v3-DataOperation";

const str = (x) => (typeof x === "string" && x.trim() ? x.trim() : undefined);
const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const cs = (base, name) => `${base}/fhir/CodeSystem/${name}`;

const REF_CONDITION = /^(https?:\/\/\S+\/)?Condition\/[A-Za-z0-9\-.]{1,64}$|^urn:uuid:[0-9a-fA-F-]{36}$/;
const REF_ENCOUNTER = /^(https?:\/\/\S+\/)?Encounter\/[A-Za-z0-9\-.]{1,64}$|^urn:uuid:[0-9a-fA-F-]{36}$/;
const REF_ANY = /^(https?:\/\/\S+\/)?[A-Za-z]+\/[A-Za-z0-9\-.]{1,64}$|^urn:uuid:[0-9a-fA-F-]{36}$/;
const REF_ALLERGY = /^(https?:\/\/\S+\/)?AllergyIntolerance\/[A-Za-z0-9\-.]{1,64}$/;
const REF_ORDERER = /^(https?:\/\/\S+\/)?(Practitioner|PractitionerRole)\/[A-Za-z0-9\-.]{1,64}$/;
const PRIORITIES = ["routine", "urgent", "asap", "stat"];
const DOMAIN_DISPLAY = { education: "Nutrition education", counseling: "Nutrition counseling", coordination: "Coordination of nutrition care" };

const party = (value) => {
  const s = str(value);
  if (!s) return null;
  return REF_ANY.test(s) ? { reference: s } : { display: s.slice(0, 200) };
};
const newUuid = (ctx) => `urn:uuid:${(ctx.uuid ?? (() => crypto.randomUUID()))()}`;
const fail = (issues, status = 400) => ({
  ok: false, status,
  outcome: { resourceType: "OperationOutcome", issue: issues.map((diagnostics) => ({ severity: "error", code: "invalid", diagnostics })) },
});

// Units: never guessed. Rates are mL/h, volumes mL (L is converted), nutrient amounts need a known unit.
const RATE_UNITS = new Set(["ml/h", "ml/hr", "ml/hour"]);
const VOLUME_UNITS = { ml: 1, l: 1000 };
const NUTRIENT_UNITS = new Set(["g", "mg", "ug", "µg", "mcg", "kcal", "kj", "mmol", "meq", "g/d", "mg/d", "ug/d", "µg/d", "kcal/d", "kj/d", "mmol/d", "meq/d"]);
const unitOf = (q) => str(q?.code) ?? str(q?.unit);

export function evaluateInterveneStructured(body, ctx) {
  const e = requireParameters(body);
  if (e) return e;
  const p = readParams(body);
  const base = ctx.base;
  const nowMs = Date.parse(ctx.now);
  const today = Math.floor(nowMs / 86400000) * 86400000;
  const errors = [];
  const notes = []; // warnings / information for the trailing OperationOutcome

  const rawParams = Array.isArray(body.parameter) ? body.parameter : [];

  // ── 1. The diagnosis the plan addresses ─────────────────────────────────
  const conditions = [];
  for (const r of p.all("resource")) {
    const list = r?.resourceType === "Bundle" ? (r.entry ?? []) : [{ fullUrl: undefined, resource: r }];
    for (const en of list) {
      const c = en?.resource;
      if (c?.resourceType !== "Condition") continue;
      const ref = en.fullUrl ?? (c.id ? `Condition/${c.id}` : undefined);
      if (ref) conditions.push({ ref, resource: c });
    }
  }
  for (const c of conditions) {
    const ver = c.resource.verificationStatus?.coding?.[0]?.code;
    if (ver === "entered-in-error" || ver === "refuted") errors.push(`Condition ${c.ref} is ${ver}; a plan cannot address it.`);
    const clin = c.resource.clinicalStatus?.coding?.[0]?.code;
    if (clin === "resolved" || clin === "inactive" || clin === "remission") notes.push({ severity: "warning", code: "business-rule", diagnostics: `Condition ${c.ref} is ${clin}; check that the plan still needs to address it.` });
  }

  let subject = str(p.get("subject"));
  const condSubjects = [...new Set(conditions.map((c) => c.resource.subject?.reference).filter(Boolean))];
  if (condSubjects.length > 1) errors.push(`The supplied Conditions belong to different patients (${condSubjects.join(", ")}).`);
  else if (condSubjects.length === 1) {
    if (subject && subject !== condSubjects[0]) errors.push(`'subject' ${subject} is not the patient of the supplied diagnosis (${condSubjects[0]}).`);
    subject = subject ?? condSubjects[0];
  }
  if (!subject) return errors.length ? fail(errors) : evaluateIntervene(body, ctx); // else keeps the base operation's message

  const explicit = p.all("addresses").map(str).filter(Boolean);
  for (const a of explicit) {
    if (!REF_CONDITION.test(a)) errors.push(`addresses "${a.slice(0, 80)}" must be a Condition reference ("Condition/123" or a urn:uuid).`);
    else if (conditions.length && !conditions.some((c) => c.ref === a)) errors.push(`addresses ${a} does not resolve in the supplied diagnosis Bundle.`);
  }
  const addresses = explicit.length ? explicit : conditions.map((c) => c.ref);

  // ── 2. Plan-level inputs ────────────────────────────────────────────────
  const encounterStr = str(p.get("encounter"));
  if (encounterStr && !REF_ENCOUNTER.test(encounterStr)) errors.push(`'encounter' must be an Encounter reference such as "Encounter/456" (got "${encounterStr.slice(0, 80)}").`);
  const author = p.get("author") !== undefined ? party(p.get("author")) : null;
  const sources = p.all("source").map(str).filter(Boolean);
  if (sources.length && !author) errors.push("'source' needs an 'author': provenance records who recorded the plan from which sources.");
  const status = str(p.get("status")) ?? "draft";
  const intent = str(p.get("intent")) ?? "proposal";
  if (!["draft", "active"].includes(status)) errors.push("'status' must be draft or active.");
  if (!["proposal", "plan", "order"].includes(intent)) errors.push("'intent' must be proposal, plan or order.");

  const startStr = str(p.get("effectiveDateTime"));
  const planStart = startStr ? parseFhirTime(startStr) : null;
  if (startStr && !planStart) errors.push(`effectiveDateTime "${startStr}" is not a valid FHIR date or dateTime.`);
  const endStr = str(p.get("endDate"));
  if (endStr !== undefined) {
    const t = parseFhirTime(endStr);
    if (!t || t.precision !== "day") errors.push(`endDate "${endStr}" must be a full date (YYYY-MM-DD).`);
    else if (planStart && t.ms < Math.floor(planStart.ms / 86400000) * 86400000) errors.push("endDate is before the plan's start.");
    else if (!planStart && t.ms < today) errors.push("endDate is in the past.");
  }

  /** A due date: valid FHIR date/dateTime, not in the past. Returns the string or undefined. */
  const dueDate = (raw, label) => {
    const s = str(raw);
    if (s === undefined) return undefined;
    const t = parseFhirTime(s);
    if (!t || (t.precision !== "day" && t.precision !== "instant")) { errors.push(`${label}.dueDate "${s}" must be a FHIR date (YYYY-MM-DD) or dateTime with timezone.`); return undefined; }
    if (t.precision === "day" ? t.ms < today : t.ms < nowMs - 5 * 60000) { errors.push(`${label}.dueDate ${s} is in the past.`); return undefined; }
    return s;
  };
  const priorityOf = (raw, label) => {
    const s = str(raw);
    if (s === undefined) return undefined;
    if (!PRIORITIES.includes(s)) { errors.push(`${label}.priority must be one of ${PRIORITIES.join(", ")}.`); return undefined; }
    return s;
  };

  // ── 3. Goals: measurable, dated, consistent ─────────────────────────────
  const goalInfo = [];
  for (const [i, g] of p.all("goal").entries()) {
    const label = `goal[${i}]`;
    if (typeof g?.get !== "function") { goalInfo.push({}); continue; }
    const startS = str(g.get("startDate"));
    const start = startS ? parseFhirTime(startS) : null;
    if (startS && !start) errors.push(`${label}.startDate "${startS}" is not a valid FHIR date or dateTime.`);
    const dueS = str(g.get("dueDate"));
    if (dueS !== undefined) {
      const due = parseFhirTime(dueS);
      if (!due || due.precision !== "day") errors.push(`${label}.dueDate "${dueS}" must be a full date (YYYY-MM-DD).`);
      else if (start && due.ms < Math.floor(start.ms / 86400000) * 86400000) errors.push(`${label}.dueDate ${dueS} is before its startDate.`);
      else if (!start && due.ms < today) errors.push(`${label}.dueDate ${dueS} is in the past.`);
    } else {
      notes.push({ severity: "warning", code: "incomplete", diagnostics: `${label} has no dueDate: a goal needs a target date to be reviewed against.`, expression: [label] });
    }
    const target = g.get("target"), baseline = g.get("baseline");
    const direction = str(g.get("direction"));
    if (isObj(target) && isNum(target.value)) {
      if (!unitOf(target)) errors.push(`${label}.target needs a unit; units are never guessed.`);
      if (isObj(baseline) && isNum(baseline.value)) {
        if (!unitOf(baseline)) errors.push(`${label}.baseline needs a unit; units are never guessed.`);
        else if (unitOf(target) && unitOf(baseline).toLowerCase() !== unitOf(target).toLowerCase()) errors.push(`${label}: baseline unit "${unitOf(baseline)}" differs from target unit "${unitOf(target)}"; use one unit so progress can be evaluated.`);
        if (direction === "increase" && target.value <= baseline.value) errors.push(`${label}: target ${target.value} is not above baseline ${baseline.value} for an increase goal.`);
        if (direction === "decrease" && target.value >= baseline.value) errors.push(`${label}: target ${target.value} is not below baseline ${baseline.value} for a decrease goal.`);
      }
      if (!str(g.get("measure"))) notes.push({ severity: "warning", code: "incomplete", diagnostics: `${label} has a target but no 'measure' (what is measured).`, expression: [label] });
      if (!direction) notes.push({ severity: "warning", code: "incomplete", diagnostics: `${label} has a target but no 'direction'; Goal/$evaluate needs increase, decrease or maintain.`, expression: [label] });
    } else if (str(g.get("measure"))) {
      notes.push({ severity: "warning", code: "incomplete", diagnostics: `${label} names a measure but has no numeric 'target', so it cannot be evaluated.`, expression: [label] });
    }
  }

  // ── 4. Nutrition orders: units, schedule, preferences ───────────────────
  const rewritten = { ...body, parameter: [] };
  const orderExtras = [];
  for (const raw of rawParams) {
    if (raw?.name === "addresses" || raw?.name === "subject") continue; // re-added below
    if (raw?.name !== "nutritionOrder" || !Array.isArray(raw.part)) { rewritten.parameter.push(raw); continue; }
    const i = orderExtras.length;
    const label = `nutritionOrder[${i}]`;
    const o = readParams({ parameter: raw.part });
    const kind = str(o.get("kind"));
    const parts = [...raw.part];
    const replace = (name, q) => { const k = parts.findIndex((x) => x?.name === name); if (k >= 0) parts[k] = { name, valueQuantity: q }; };

    for (const n of o.all("nutrient")) {
      const amount = n?.get?.("amount");
      if (isObj(amount) && isNum(amount.value) && !NUTRIENT_UNITS.has((unitOf(amount) ?? "").toLowerCase())) {
        errors.push(`${label}.nutrient "${str(n.get("name")) ?? ""}": amount needs a recognised unit (${[...NUTRIENT_UNITS].join(", ")}); units are never guessed.`);
      }
    }
    const quantity = o.get("quantity");
    if (kind === "supplement" && isObj(quantity) && isNum(quantity.value)) {
      if (!unitOf(quantity)) errors.push(`${label}.quantity needs a unit (e.g. mL, g, packet); units are never guessed.`);
      else if (quantity.value <= 0) errors.push(`${label}.quantity must be above 0.`);
    }
    if (kind === "enteral-formula") {
      const rate = o.get("rate"), maxV = o.get("maxVolume");
      if (isObj(rate) && isNum(rate.value)) {
        if (!RATE_UNITS.has((unitOf(rate) ?? "").toLowerCase())) errors.push(`${label}.rate must be in mL/h (got "${unitOf(rate) ?? "no unit"}").`);
        else if (rate.value <= 0 || rate.value > 1000) errors.push(`${label}.rate ${rate.value} mL/h is outside the plausible range (above 0 to 1000).`);
        else replace("rate", { value: rate.value, unit: "mL/h", system: UCUM, code: "mL/h" });
      }
      if (isObj(maxV) && isNum(maxV.value)) {
        const f = VOLUME_UNITS[(unitOf(maxV) ?? "").toLowerCase()];
        if (!f) errors.push(`${label}.maxVolume must be in mL or L (got "${unitOf(maxV) ?? "no unit"}").`);
        else if (maxV.value <= 0 || maxV.value * f > 20000) errors.push(`${label}.maxVolume ${maxV.value} ${unitOf(maxV)} is outside the plausible range (above 0 to 20000 mL).`);
        else replace("maxVolume", { value: maxV.value * f, unit: "mL", system: UCUM, code: "mL" });
      }
    }

    const extras = {};
    const tpd = o.get("timesPerDay");
    if (tpd !== undefined) {
      if (!Number.isInteger(tpd) || tpd < 1 || tpd > 24) errors.push(`${label}.timesPerDay must be a whole number from 1 to 24.`);
      else extras.timesPerDay = tpd;
    }
    for (const f of ["startDate", "endDate"]) {
      const s = str(o.get(f));
      if (s === undefined) continue;
      const t = parseFhirTime(s);
      if (!t || t.precision !== "day") errors.push(`${label}.${f} "${s}" must be a full date (YYYY-MM-DD).`);
      else extras[f] = s;
    }
    if (extras.startDate && extras.endDate && extras.endDate < extras.startDate) errors.push(`${label}.endDate is before startDate.`);
    extras.foodPreference = o.all("foodPreference").map(str).filter(Boolean);
    extras.excludeFood = o.all("excludeFood").map(str).filter(Boolean);
    extras.allergyIntolerance = o.all("allergyIntolerance").map(str).filter(Boolean);
    for (const a of extras.allergyIntolerance) if (!REF_ALLERGY.test(a)) errors.push(`${label}.allergyIntolerance "${a.slice(0, 80)}" must be an AllergyIntolerance reference ("AllergyIntolerance/123").`);
    orderExtras.push(extras);
    rewritten.parameter.push({ ...raw, part: parts });
  }

  // ── 5. Activities: education, counseling, coordination, follow-up, referral
  /** specs in the order the base operation emits its ServiceRequests, then ours */
  const baseActivities = [];
  for (const [param, domain, requiredName] of [["education", "education", "topic"], ["counseling", "counseling", "topic"], ["coordination", "coordination", "reason"]]) {
    for (const [i, x] of p.all(param).entries()) {
      if (typeof x?.get !== "function") continue;
      const label = `${param}[${i}]`;
      baseActivities.push({
        domain, label, text: str(x.get(requiredName)),
        assignedTo: party(x.get("assignedTo")), due: dueDate(x.get("dueDate"), label), priority: priorityOf(x.get("priority"), label),
        note: str(x.get("note")),
      });
    }
  }
  const newActivities = [];
  for (const [i, x] of p.all("followUp").entries()) {
    const label = `followUp[${i}]`;
    if (typeof x?.get !== "function") { errors.push(`${label} must be a part with nested parts (reason, dueDate, ...).`); continue; }
    const reason = str(x.get("reason"));
    if (!reason) errors.push(`${label}.reason (what the follow-up is for) is required.`);
    if (x.get("dueDate") === undefined) errors.push(`${label}.dueDate is required: a follow-up without a date cannot be scheduled.`);
    const monitor = x.all("monitor").map(str).filter(Boolean);
    const method = str(x.get("method"));
    newActivities.push({
      domain: "follow-up", display: "Nutrition follow-up", label, text: reason ? `Nutrition follow-up: ${reason}` : undefined,
      reason, assignedTo: party(x.get("assignedTo")), due: dueDate(x.get("dueDate"), label), priority: priorityOf(x.get("priority"), label),
      note: [method && `Method: ${method}`, monitor.length && `Monitor: ${monitor.join("; ")}`, str(x.get("note"))].filter(Boolean).join(" | ") || undefined,
      always: true,
    });
  }
  for (const [i, x] of p.all("referral").entries()) {
    const label = `referral[${i}]`;
    if (typeof x?.get !== "function") { errors.push(`${label} must be a part with nested parts (to, reason, ...).`); continue; }
    const to = str(x.get("to")), reason = str(x.get("reason"));
    if (!to) errors.push(`${label}.to (the service or professional referred to) is required.`);
    if (!reason) errors.push(`${label}.reason is required.`);
    newActivities.push({
      domain: "referral", display: "Referral to another professional or service", label, text: to ? `Referral to ${to}` : undefined, reason,
      performer: party(x.get("performer")), due: dueDate(x.get("dueDate"), label), priority: priorityOf(x.get("priority"), label),
      note: str(x.get("note")), always: true, referral: true,
    });
  }
  if (errors.length) return fail(errors);

  // ── 6. Run the base operation on the checked, normalised input ──────────
  rewritten.parameter.push({ name: "subject", valueString: subject });
  for (const a of addresses) rewritten.parameter.push({ name: "addresses", valueString: a });
  const r = evaluateIntervene(rewritten, ctx);
  if (!r.ok) return r;

  const entries = r.body.entry;
  const carePlanEntry = entries[0];
  const carePlan = carePlanEntry.resource;
  const goals = entries.filter((x) => x.resource.resourceType === "Goal");
  const orders = entries.filter((x) => x.resource.resourceType === "NutritionOrder");
  const baseSRs = entries.filter((x) => x.resource.resourceType === "ServiceRequest");
  const reasonRefs = addresses.map((reference) => ({ reference }));
  const lifecycle = status === "draft" ? "draft" : "requested";
  const planIntent = intent;

  // CarePlan
  if (encounterStr) carePlan.encounter = { reference: encounterStr };
  if (author) carePlan.author = author;
  if (endStr) carePlan.period = { ...carePlan.period, end: endStr };
  if (addresses.length === 0) {
    carePlan.note = [...(carePlan.note ?? []), { text: "This plan is not linked to a nutrition diagnosis: no Condition was supplied or referenced ('resource' or 'addresses')." }];
    notes.push({ severity: "information", code: "informational", diagnostics: "The plan is not linked to a nutrition diagnosis (no 'resource' or 'addresses')." });
  }

  // Goals
  for (const g of goals) {
    if (author?.reference && REF_ORDERER.test(author.reference)) g.resource.expressedBy = author;
  }

  // Orders
  orders.forEach((en, i) => {
    const o = en.resource, x = orderExtras[i] ?? {};
    if (encounterStr) o.encounter = { reference: encounterStr };
    if (author?.reference && REF_ORDERER.test(author.reference)) o.orderer = author;
    if (x.allergyIntolerance?.length) o.allergyIntolerance = x.allergyIntolerance.map((reference) => ({ reference }));
    if (x.foodPreference?.length) o.foodPreferenceModifier = x.foodPreference.map((text) => ({ text }));
    if (x.excludeFood?.length) o.excludeFoodModifier = x.excludeFood.map((text) => ({ text }));
    if (x.timesPerDay || x.startDate || x.endDate) {
      const timing = {
        repeat: {
          ...(x.timesPerDay ? { frequency: x.timesPerDay, period: 1, periodUnit: "d" } : {}),
          ...(x.startDate || x.endDate ? { boundsPeriod: { ...(x.startDate ? { start: x.startDate } : {}), ...(x.endDate ? { end: x.endDate } : {}) } } : {}),
        },
      };
      if (o.oralDiet) o.oralDiet.schedule = [timing];
      else if (o.supplement?.[0]) o.supplement[0].schedule = [timing];
      else if (o.enteralFormula) o.enteralFormula.administration = [{ ...(o.enteralFormula.administration?.[0] ?? {}), schedule: timing }];
    }
  });

  // ServiceRequests: the base ones, then follow-up and referral
  const srFor = (spec, existing) => {
    const sr = existing ?? {
      resourceType: "ServiceRequest",
      status,
      intent,
      category: [
        { coding: [{ system: cs(base, "ncp-step"), code: "nutrition-intervention" }] },
        { coding: [{ system: cs(base, "ncp-intervention-domain"), code: spec.domain, display: spec.display }] },
        ...(spec.referral ? [{ coding: [{ system: SNOMED, code: "3457005", display: "Patient referral" }] }] : []),
      ],
      code: { text: spec.text },
      subject: { reference: subject },
      authoredOn: ctx.now,
    };
    if (spec.priority) sr.priority = spec.priority;
    if (spec.due) sr.occurrenceDateTime = spec.due;
    if (encounterStr) sr.encounter = { reference: encounterStr };
    if (author) sr.requester = author;
    const performer = spec.performer ?? spec.assignedTo;
    if (performer) sr.performer = [performer];
    if (reasonRefs.length) sr.reasonReference = reasonRefs;
    if (spec.reason) sr.reasonCode = [{ text: spec.reason }];
    if (spec.note && !existing) sr.note = [{ text: spec.note }];
    return sr;
  };
  baseActivities.forEach((spec, i) => { if (baseSRs[i]) srFor(spec, baseSRs[i].resource); });
  const newSRs = newActivities.map((spec) => ({ fullUrl: newUuid(ctx), resource: srFor(spec), spec }));
  const activities = [...(carePlan.activity ?? []), ...newSRs.map((s) => ({ reference: { reference: s.fullUrl } }))];
  if (activities.length) carePlan.activity = activities; // FHIR JSON has no empty arrays
  else delete carePlan.activity;

  // Tasks: who does what by when
  const tasks = [];
  const addTask = (sr, spec) => {
    if (!(spec.always || spec.assignedTo || spec.due)) return;
    const owner = spec.referral ? spec.performer : spec.assignedTo;
    tasks.push({
      fullUrl: newUuid(ctx),
      resource: {
        resourceType: "Task",
        status: lifecycle,
        intent: planIntent,
        basedOn: [{ reference: carePlanEntry.fullUrl }],
        focus: { reference: sr.fullUrl },
        code: { coding: [{ system: cs(base, "ncp-intervention-domain"), code: spec.domain, display: spec.display ?? DOMAIN_DISPLAY[spec.domain] }] },
        description: sr.resource.code.text,
        for: { reference: subject },
        ...(encounterStr ? { encounter: { reference: encounterStr } } : {}),
        authoredOn: ctx.now,
        lastModified: ctx.now,
        ...(author ? { requester: author } : {}),
        ...(owner ? { owner } : {}),
        ...(spec.priority ? { priority: spec.priority } : {}),
        ...(spec.due ? { restriction: { period: { end: spec.due } } } : {}),
        ...(reasonRefs.length ? { reasonReference: reasonRefs } : {}),
        ...(spec.reason ? { reasonCode: { text: spec.reason } } : {}),
        ...(spec.note ? { note: [{ text: spec.note }] } : {}),
      },
    });
  };
  baseActivities.forEach((spec, i) => { if (baseSRs[i]) addTask(baseSRs[i], spec); });
  newSRs.forEach((s) => addTask(s, s.spec));

  // Provenance for the whole plan
  const created = [carePlanEntry, ...goals, ...orders, ...baseSRs, ...newSRs, ...tasks];
  const extra = [...newSRs.map(({ fullUrl, resource }) => ({ fullUrl, resource })), ...tasks];
  if (author) {
    extra.push({
      fullUrl: newUuid(ctx),
      resource: {
        resourceType: "Provenance",
        target: created.map((x) => ({ reference: x.fullUrl })),
        recorded: ctx.now,
        activity: { coding: [{ system: V3_DATA_OPERATION, code: "CREATE", display: "create" }] },
        agent: [{ type: { coding: [{ system: PROV_PARTICIPANT, code: "author", display: "Author" }] }, who: author }],
        entity: [
          ...addresses.map((reference) => ({ role: "derivation", what: { reference } })),
          ...sources.map((display) => ({ role: "source", what: { display } })),
        ],
      },
    });
  }
  if (notes.length) extra.push({ fullUrl: newUuid(ctx), resource: { resourceType: "OperationOutcome", issue: notes } });

  return { ok: true, status: 200, body: { ...r.body, entry: [...entries, ...extra] } };
}

export const INTERVENTION_OPERATIONS = { "CarePlan/$intervene": evaluateInterveneStructured };
export const interventionOperationFor = (param, action) => INTERVENTION_OPERATIONS[`${param}/${action}`] ?? null;

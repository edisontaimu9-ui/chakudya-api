// Fixed-cut-off MUAC classification (severe / moderate / normal), 6 months to adult.
// Reference: WHO, "Guideline for Integrated Approach to the National Care of HIV
// Infected Children (6 months - 14 years)", 2008, as reproduced in the FANTA
// Ethiopia MUAC classification chart. No database table: the cut-offs are fixed.
//
// Rule for every age group (cm): severe < low | moderate low..high (both ends
// inclusive) | normal > high. Age is in whole completed months.
//   6-11 months   : <11   | 11-12     | >12
//   12-59 months  : <11   | 11-13     | >13
//   5-9 years     : <13.5 | 13.5-14.5 | >14.5
//   10-14 years   : <16   | 16-18     | >18
//   adults (15 y+): <18   | 18-21     | >21
//
// NOTE: the 6-59 month rows here differ from the WHO/UNICEF community
// screening cut-offs (115 mm severe, 125 mm moderate) used by most CMAM
// programmes. Screening aid only, not a diagnosis. Not the z-score table
// (see muacForAge.js).

export const MUAC_FIXED_MIN_MONTHS = 6;
export const MUAC_FIXED_MAX_MONTHS = 1200; // 100 years, sanity bound

const GROUPS = [
  { key: "6-11 months",  from: 6,   to: 11,   severe: 11,   moderate_max: 12 },
  { key: "12-59 months", from: 12,  to: 59,   severe: 11,   moderate_max: 13 },
  { key: "5-9 years",    from: 60,  to: 119,  severe: 13.5, moderate_max: 14.5 },
  { key: "10-14 years",  from: 120, to: 179,  severe: 16,   moderate_max: 18 },
  { key: "adults",       from: 180, to: Infinity, severe: 18, moderate_max: 21 },
];

/** Parse ?age_months=&(muac_cm | muac_mm). Returns { ageMonths, muacCm } or { error }. */
export function parseMuacFixedQuery(searchParams) {
  const ageRaw = searchParams.get("age_months");
  const ageMonths = Number(ageRaw);
  if (ageRaw === null || ageRaw === "" || !Number.isInteger(ageMonths)) {
    return { error: "'age_months' is required (whole completed months; adults: years x 12, e.g. 30 years = 360)" };
  }
  if (ageMonths < MUAC_FIXED_MIN_MONTHS || ageMonths > MUAC_FIXED_MAX_MONTHS) {
    return { error: `'age_months' must be ${MUAC_FIXED_MIN_MONTHS} or more (these cut-offs start at 6 months)` };
  }
  let muacCm;
  const cmRaw = searchParams.get("muac_cm");
  const mmRaw = searchParams.get("muac_mm");
  if (cmRaw !== null && cmRaw !== "") muacCm = Number(cmRaw);
  else if (mmRaw !== null && mmRaw !== "") muacCm = Number(mmRaw) / 10;
  else return { error: "Provide 'muac_cm' (centimetres) or 'muac_mm' (millimetres)" };
  if (!Number.isFinite(muacCm) || muacCm < 5 || muacCm > 60) {
    return { error: "MUAC is not plausible (check you did not pass millimetres as muac_cm)" };
  }
  return { ageMonths, muacCm: Math.round(muacCm * 1000) / 1000 };
}

/** Returns { age_group, status, muac_cm, cutoffs_cm: { severe_below, normal_above } }. */
export function classifyMuacFixed(ageMonths, muacCm) {
  const g = GROUPS.find((x) => ageMonths >= x.from && ageMonths <= x.to);
  let status;
  if (muacCm < g.severe) status = "severe";
  else if (muacCm <= g.moderate_max) status = "moderate";
  else status = "normal";
  return {
    age_group: g.key,
    status,
    muac_cm: muacCm,
    cutoffs_cm: { severe_below: g.severe, normal_above: g.moderate_max },
  };
}

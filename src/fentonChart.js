// Server-rendered SVG growth chart for GET /fenton-preterm/chart.
//
// LICENSE — same condition as fentonPreterm.js: the caller of this endpoint
// gets a rendered image, never the underlying numeric curve. This mirrors
// Dr. Fenton's own public tool, which outputs jpg/pdf images rather than
// raw data points (per her email). Percentile curve *values* are computed
// here, server-side, purely to draw pixel coordinates into an SVG <path> —
// they are never serialized back to the caller as numbers. Do not add a
// "return the computed percentile arrays as JSON" mode to this file.

import { FENTON_MIN_DAYS, FENTON_MAX_DAYS } from "./fentonPreterm.js";

// Standard normal z-values for the percentile lines drawn on the chart.
const PERCENTILE_LINES = [
  { p: 3, z: -1.8808, color: "#c0392b", width: 1.2 },
  { p: 10, z: -1.2816, color: "#e67e22", width: 1.2 },
  { p: 50, z: 0, color: "#2c3e50", width: 1.8 },
  { p: 90, z: 1.2816, color: "#e67e22", width: 1.2 },
  { p: 97, z: 1.8808, color: "#c0392b", width: 1.2 },
];

function lmsToValue(L, M, S, z) {
  return L !== 0 ? M * Math.pow(1 + L * S * z, 1 / L) : M * Math.exp(S * z);
}

const METRIC_LABEL = { weight: "Weight (g)", length: "Length (cm)", hc: "Head circumference (cm)" };

/**
 * rows: fenton_preterm_lms rows for one (reference_year, sex, metric),
 *   ordered by time_days ascending. { l, m, s, time_days }.
 * points: optional array of { gestAgeWeeks, day, value } — the infant's own
 *   measurements to overlay as dots + a connecting line.
 * Returns a complete, self-contained SVG string.
 */
export function renderFentonChartSVG({ rows, metric, sex, referenceYear, points = [] }) {
  const W = 900, H = 560;
  const margin = { top: 50, right: 100, bottom: 60, left: 70 };
  const plotW = W - margin.left - margin.right;
  const plotH = H - margin.top - margin.bottom;

  const xDomain = [FENTON_MIN_DAYS / 7 + 22, FENTON_MAX_DAYS / 7 + 22]; // gestational weeks

  // Compute all 5 percentile curves first, to get the y-domain from actual data.
  const curves = PERCENTILE_LINES.map(({ p, z, color, width }) => ({
    p,
    color,
    width,
    values: rows.map((r) => ({
      weeks: 22 + Number(r.time_days) / 7,
      value: lmsToValue(Number(r.l), Number(r.m), Number(r.s), z),
    })),
  }));

  let yMin = Infinity, yMax = -Infinity;
  for (const c of curves) {
    for (const pt of c.values) {
      if (pt.value < yMin) yMin = pt.value;
      if (pt.value > yMax) yMax = pt.value;
    }
  }
  for (const pt of points) {
    if (pt.value < yMin) yMin = pt.value;
    if (pt.value > yMax) yMax = pt.value;
  }
  const yPad = (yMax - yMin) * 0.06 || 1;
  yMin -= yPad;
  yMax += yPad;

  const xScale = (weeks) => margin.left + ((weeks - xDomain[0]) / (xDomain[1] - xDomain[0])) * plotW;
  const yScale = (v) => margin.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  const toPath = (values) => values.map((pt, i) => `${i === 0 ? "M" : "L"} ${xScale(pt.weeks).toFixed(2)} ${yScale(pt.value).toFixed(2)}`).join(" ");

  // X-axis ticks every 4 weeks, Y-axis ~6 ticks.
  const xTicks = [];
  for (let w = Math.ceil(xDomain[0] / 4) * 4; w <= xDomain[1]; w += 4) xTicks.push(w);
  const yTickCount = 6;
  const yTicks = Array.from({ length: yTickCount + 1 }, (_, i) => yMin + ((yMax - yMin) * i) / yTickCount);

  const curvePaths = curves
    .map(
      (c) =>
        `<path d="${toPath(c.values)}" fill="none" stroke="${c.color}" stroke-width="${c.width}" />` +
        `<text x="${xScale(c.values[c.values.length - 1].weeks) + 6}" y="${yScale(c.values[c.values.length - 1].value) + 4}" font-size="11" fill="${c.color}">P${c.p}</text>`
    )
    .join("\n");

  const overlay =
    points.length > 0
      ? (() => {
          const sorted = [...points].sort((a, b) => a.gestAgeWeeks + a.day / 7 - (b.gestAgeWeeks + b.day / 7));
          const overlayValues = sorted.map((pt) => ({ weeks: pt.gestAgeWeeks + pt.day / 7, value: pt.value }));
          const line =
            overlayValues.length > 1
              ? `<path d="${toPath(overlayValues)}" fill="none" stroke="#1a6fbd" stroke-width="2" stroke-dasharray="4 3" />`
              : "";
          const dots = overlayValues
            .map((pt) => `<circle cx="${xScale(pt.weeks).toFixed(2)}" cy="${yScale(pt.value).toFixed(2)}" r="4.5" fill="#1a6fbd" stroke="#fff" stroke-width="1.5" />`)
            .join("\n");
          return line + "\n" + dots;
        })()
      : "";

  const gridLines = yTicks
    .map((t) => `<line x1="${margin.left}" y1="${yScale(t).toFixed(2)}" x2="${W - margin.right}" y2="${yScale(t).toFixed(2)}" stroke="#e5e5e5" stroke-width="1" />`)
    .join("\n");

  const yAxisLabels = yTicks
    .map((t) => `<text x="${margin.left - 8}" y="${yScale(t).toFixed(2) + 4}" font-size="11" text-anchor="end" fill="#444">${Math.round(t)}</text>`)
    .join("\n");

  const xAxisLabels = xTicks
    .map((w) => `<text x="${xScale(w).toFixed(2)}" y="${H - margin.bottom + 20}" font-size="11" text-anchor="middle" fill="#444">${w}w</text>`)
    .join("\n");
  const xAxisTicks = xTicks
    .map((w) => `<line x1="${xScale(w).toFixed(2)}" y1="${H - margin.bottom}" x2="${xScale(w).toFixed(2)}" y2="${H - margin.bottom + 5}" stroke="#888" />`)
    .join("\n");

  const sexLabel = sex === "girls" ? "Girls" : "Boys";
  const title = `Fenton ${referenceYear} Preterm Growth Chart — ${METRIC_LABEL[metric] ?? metric} — ${sexLabel}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Helvetica, Arial, sans-serif">
  <rect width="${W}" height="${H}" fill="#ffffff" />
  <text x="${W / 2}" y="24" font-size="16" font-weight="bold" text-anchor="middle" fill="#1a1a1a">${title}</text>
  ${gridLines}
  <line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${H - margin.bottom}" stroke="#333" />
  <line x1="${margin.left}" y1="${H - margin.bottom}" x2="${W - margin.right}" y2="${H - margin.bottom}" stroke="#333" />
  ${xAxisTicks}
  ${xAxisLabels}
  ${yAxisLabels}
  <text x="${W / 2}" y="${H - 14}" font-size="12" text-anchor="middle" fill="#444">Gestational / postmenstrual age (weeks)</text>
  <text x="18" y="${margin.top + plotH / 2}" font-size="12" text-anchor="middle" fill="#444" transform="rotate(-90 18 ${margin.top + plotH / 2})">${METRIC_LABEL[metric] ?? metric}</text>
  ${curvePaths}
  ${overlay}
  <text x="${W - margin.right}" y="${H - 8}" font-size="9" text-anchor="end" fill="#999">Fenton ${referenceYear} reference. Licensed, non-commercial use only. Screening aid, not a diagnosis.</text>
</svg>`;
}

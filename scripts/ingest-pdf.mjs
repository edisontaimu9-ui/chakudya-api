#!/usr/bin/env node
/**
 * ingest-pdf.mjs — ingest a PDF into the Chakudya RAG knowledge base.
 *
 * Reads the PDF straight from phone storage (no upload anywhere), splits it
 * into chunks that keep section headings and tables intact, then POSTs each
 * chunk to /rag/ingest.  DRY RUN BY DEFAULT: nothing is sent unless you pass
 * --ingest.
 *
 * Needs poppler (pdftotext, pdfimages) and Node 18+:   pkg install poppler
 *
 * Usage
 *   node scripts/ingest-pdf.mjs --pdf FILE --source "Citation string"            (dry run)
 *   ADMIN_KEY=... node scripts/ingest-pdf.mjs --pdf FILE --source "..." --ingest (real)
 *   ADMIN_KEY=... node scripts/ingest-pdf.mjs --source "..." --purge             (undo)
 *
 * Options
 *   --context clinical|general|both   default: both
 *   --max-chars N                     target chunk size, default 1200
 *   --min-chars N                     merge chunks smaller than this, default 150
 *   --out FILE                        dry-run preview file, default ingest-preview.json
 *   --extra FILE.json                 extra chunks, e.g. descriptions of figures:
 *                                     [{"page": 5, "heading": "Food groups", "content": "..."}]
 *   --pages 3-40                      only process this page range (dry run friendly)
 *   --skip-pages 1-2,61-72,80         leave these pages out (covers, numeric lookup grids, pages you'll hand-write)
 *   --skip-tables 49                  drop only the tables on these pages, keep their prose
 *
 * Env
 *   ADMIN_KEY     admin key for the Worker (sent as "Authorization: Bearer <key>";
 *                 set AUTH_HEADER=x-admin-key (or similar) to send it raw in that header)
 *   API_URL       default https://chakudya-api.edisontaimu9.workers.dev
 *
 * Ingest is resumable: progress is saved beside the PDF's slug in the current
 * folder, so if the connection drops, run the same command again.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";

// ── args / config ────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const API_URL = (process.env.API_URL || "https://chakudya-api.edisontaimu9.workers.dev").replace(/\/$/, "");
const KEY = process.env.ADMIN_KEY || "";
const source = typeof args.source === "string" ? args.source : "";
const context = args.context || "both";
const maxChars = Number(args["max-chars"] || 1200);
const minChars = Number(args["min-chars"] || 150);
const previewFile = typeof args.out === "string" ? args.out : "ingest-preview.json";
const VALID_CONTEXTS = ["clinical", "general", "both"];

const die = (msg) => {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

function authHeaders() {
  const h = { "Content-Type": "application/json" };
  if (process.env.AUTH_HEADER) h[process.env.AUTH_HEADER] = KEY;
  else h.Authorization = `Bearer ${KEY}`;
  return h;
}

if (!source) die("--source is required (the citation string, e.g. \"Eat Well to Live Well (2021)\")");
if (!VALID_CONTEXTS.includes(context)) die(`--context must be one of: ${VALID_CONTEXTS.join(", ")}`);
const progressFile = `ingest-progress-${slug(source)}.json`;

// ── purge mode (undo) ────────────────────────────────────────────────────────
if (args.purge) {
  if (!KEY) die("Set ADMIN_KEY to purge.");
  const res = await fetch(`${API_URL}/rag/source?source=${encodeURIComponent(source)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  const text = await res.text();
  console.log(res.status, text);
  if (res.ok && fs.existsSync(progressFile)) fs.unlinkSync(progressFile);
  process.exit(res.ok ? 0 : 1);
}

const pdf = typeof args.pdf === "string" ? args.pdf : "";
if (!pdf) die("--pdf is required");
if (!fs.existsSync(pdf)) die(`File not found: ${pdf}`);

// ── PDF extraction (poppler) ─────────────────────────────────────────────────
function run(cmd, cmdArgs) {
  try {
    return execFileSync(cmd, cmdArgs, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  } catch (e) {
    if (e.code === "ENOENT") die(`'${cmd}' not found. Install poppler:  pkg install poppler`);
    die(`'${cmd}' failed: ${e.message}`);
  }
}

function splitPages(text) {
  const pages = text.split("\f");
  if (pages.length && !pages[pages.length - 1].trim()) pages.pop();
  return pages;
}

const rawPages = splitPages(run("pdftotext", ["-enc", "UTF-8", pdf, "-"]));
const layoutPages = splitPages(run("pdftotext", ["-layout", "-enc", "UTF-8", pdf, "-"]));
const totalPages = Math.max(rawPages.length, layoutPages.length);

// page range filter
let firstPage = 1;
let lastPage = totalPages;
if (typeof args.pages === "string") {
  const m = args.pages.match(/^(\d+)-(\d+)$/);
  if (!m) die("--pages must look like 3-40");
  firstPage = Math.max(1, Number(m[1]));
  lastPage = Math.min(totalPages, Number(m[2]));
}

// page sets: --skip-pages drops whole pages, --skip-tables drops only the tables on those pages
function parsePageSet(flag) {
  const set = new Set();
  if (typeof args[flag] !== "string") return set;
  for (const part of args[flag].split(",")) {
    const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!m) die(`--${flag} must look like 1-2,61-72,80`);
    for (let q = Number(m[1]); q <= Number(m[2] || m[1]); q++) set.add(q);
  }
  return set;
}
const skipPages = parsePageSet("skip-pages");
const skipTables = parsePageSet("skip-tables");

const ranges = (arr) => {
  const a = [...new Set(arr)].sort((x, y) => x - y);
  if (!a.length) return "";
  const out = [];
  let s0 = a[0];
  let prev = a[0];
  for (let i = 1; i <= a.length; i++) {
    if (a[i] === prev + 1) {
      prev = a[i];
      continue;
    }
    out.push(s0 === prev ? `${s0}` : `${s0}-${prev}`);
    s0 = a[i];
    prev = a[i];
  }
  return out.join(",");
};

// images per page (ignore tiny icons/bullets)
const imagesPerPage = {};
try {
  const lines = run("pdfimages", ["-list", pdf]).split("\n").slice(2);
  for (const line of lines) {
    const c = line.trim().split(/\s+/);
    if (c.length < 5) continue;
    const page = parseInt(c[0], 10);
    const w = parseInt(c[3], 10);
    const h = parseInt(c[4], 10);
    if (c[2] === "image" && w >= 150 && h >= 150) imagesPerPage[page] = (imagesPerPage[page] || 0) + 1;
  }
} catch {
  /* image report is optional */
}

// ── cleaning ─────────────────────────────────────────────────────────────────
const normLine = (l) => l.trim().replace(/\s+/g, " ").replace(/\d+/g, "#").toLowerCase();
const repeating = new Set();
const headerTexts = []; // long running headers, so they can also be stripped from mid-paragraph
if (totalPages >= 3) {
  const threshold = Math.max(3, Math.ceil(totalPages * 0.4));
  for (const pages of [rawPages, layoutPages]) {
    const counts = new Map();
    const orig = new Map();
    for (const p of pages) {
      // lines with 3+ columns are table rows (e.g. a header repeated on every page) — keep them
      const lines = p.split("\n").filter((l) => cellsOf(l).length < 3);
      const seen = new Set();
      for (const l of lines) {
        const n = normLine(l);
        if (!n || n.length >= 200) continue;
        seen.add(n);
        if (!orig.has(n)) orig.set(n, l.trim().replace(/\s+/g, " "));
      }
      for (const l of seen) counts.set(l, (counts.get(l) || 0) + 1);
    }
    for (const [l, n] of counts) {
      if (n < threshold) continue;
      repeating.add(l);
      const o = orig.get(l);
      if (o && o.length >= 25 && !/\d/.test(o)) headerTexts.push(o);
    }
  }
}
const headerRegexes = [...new Set(headerTexts)].map(
  (t) => new RegExp(t.split(" ").map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"), "gi")
);
const isPageNumber = (l) => /^\s*(page\s*)?\d{1,3}(\s*of\s*\d{1,3})?\s*$/i.test(l);
const keepLine = (l) => !repeating.has(normLine(l)) && !isPageNumber(l);

const BULLET = /^\s*([•●▪◦·*]|[-–—]\s|\d{1,2}[.)]\s)/;

// lone capitalised words that are table/box labels, not section headings
const LABEL_WORDS = /^(limit|avoid|eat|choose|include|height|weight|age|sex|note|notes|example|examples|source|sources|total|yes|no|none|other|others|tip|tips|key|table|figure|box|serving|portion|amount|energy)$/i;

function isHeadingLine(t, next) {
  if (!t || t.length > 80 || next === undefined) return false;
  if (/[.,;]$/.test(t) || BULLET.test(t)) return false;
  const words = t.split(/\s+/);
  if (words.length > 10) return false;
  const letters = t.replace(/[^A-Za-z]/g, "");
  if (letters.length < 3) return false;
  const allCaps = letters === letters.toUpperCase();
  const capRatio = words.filter((w) => /^[A-Z0-9]/.test(w)).length / words.length;
  // a lone word must look like a real heading, not a label such as "Limit" or "Height"
  if (words.length === 1 && (letters.length < 4 || LABEL_WORDS.test(t))) return false;
  return allCaps || capRatio >= 0.6;
}

/** Turn a block of text lines into paragraphs: fixes wraps + hyphenation, finds headings. */
function toParagraphs(text) {
  const lines = text.split("\n").map((l) => l.trim());
  const lens = lines.filter(Boolean).map((l) => l.length).sort((a, b) => a - b);
  const typical = lens.length ? lens[Math.floor(lens.length * 0.85)] : 80;
  const out = [];
  let cur = "";
  let lastLen = 0;
  const flushCur = () => {
    let text = cur.replace(/[ \t]+/g, " ");
    for (const re of headerRegexes) text = text.replace(re, " ");
    text = text.replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").trim();
    // skip an exact repeat of the previous paragraph (e.g. a cover title printed twice)
    if (text && !(out.length && out[out.length - 1].text === text)) out.push({ heading: false, text });
    cur = "";
  };
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i];
    if (!t) {
      // a blank line in the middle of a sentence (text wrapped around a figure) is not a paragraph break
      if (cur && !/[.!?:]$/.test(cur)) {
        let k = i + 1;
        while (k < lines.length && !lines[k]) k++;
        if (k < lines.length && /^[a-z(]/.test(lines[k])) continue;
      }
      flushCur();
      continue;
    }
    if (!keepLine(t)) continue;
    if (/^[•●▪◦·]$/.test(t)) continue; // bullet glyph on its own line (reading-order output)
    if ((!cur || /[.!?:]$/.test(cur)) && isHeadingLine(t, lines[i + 1])) {
      flushCur();
      out.push({ heading: true, text: t });
      continue;
    }
    if (!cur) cur = t;
    else if (BULLET.test(t)) cur += "\n" + t;
    else if (/[A-Za-z]-$/.test(cur) && /^[a-z]/.test(t)) cur = cur.slice(0, -1) + t;
    else if (lastLen < typical * 0.5 && t.length < typical * 0.5 && !/[.!?,;:]$/.test(cur)) cur += "\n" + t; // short lines in a row = list items
    else if (/[.!?]$/.test(cur) && /^[A-Z]/.test(t) && lastLen < typical * 0.7) {
      flushCur();
      cur = t;
    } else cur += " " + t;
    lastLen = t.length;
  }
  flushCur();
  return out;
}

// ── table detection on -layout output ───────────────────────────────────────
function cellsOf(line) {
  return line.trim().split(/\s{3,}/).map((c) => c.trim()).filter(Boolean);
}
function isTableLine(line) {
  if (!line.trim() || BULLET.test(line)) return false;
  const cells = cellsOf(line);
  if (cells.length >= 3) return true;
  if (cells.length === 2) return cells.every((c) => c.length <= 32);
  return false;
}

/** True if a -layout page looks like two text columns (a vertical gutter of spaces). */
function isTwoColumn(pageText) {
  const lines = pageText.split("\n").filter((l) => l.trim());
  if (lines.length < 10) return false;
  const width = Math.max(...lines.map((l) => l.length));
  const eligible = lines.filter((l) => l.length > width * 0.55);
  if (eligible.length < 8) return false;
  let run = 0;
  for (let pos = Math.floor(width * 0.3); pos <= Math.floor(width * 0.7); pos++) {
    const spaces = eligible.filter((l) => l[pos] === " ").length;
    if (spaces / eligible.length >= 0.9) {
      if (++run >= 2) return true;
    } else run = 0;
  }
  return false;
}

const proseCell = (c) => c.split(/\s+/).length >= 7;

/** Cells of a layout line WITH their start columns (cells are separated by 3+ spaces). */
function cellsPos(line) {
  const out = [];
  const re = /\S+(?: {1,2}\S+)*/g;
  let m;
  while ((m = re.exec(line))) out.push({ text: m[0], start: m.index });
  return out;
}
// a line whose cells all start lowercase / "(" continues the cell above (a wrapped cell)
const isContinuationLine = (line) => {
  const cells = cellsPos(line);
  return cells.length > 0 && cells.every((c) => /^[a-z(]/.test(c.text));
};

/**
 * If a real table run starts at lines[i], return the index just past its last row, else -1.
 * A run is 3+ consecutive column-like lines (wrapped-cell continuation lines may sit between
 * them). Runs where many rows contain a long sentence fragment are rejected: that is prose
 * beside a sidebar/figure, not a table.
 */
function tableRunEnd(lines, i) {
  let j = i;
  const tableLines = [];
  while (j < lines.length) {
    const l = lines[j];
    if (isTableLine(l)) {
      tableLines.push(l);
      j++;
    } else if (!l.trim() && tableLines.length && j + 1 < lines.length && isTableLine(lines[j + 1])) j++;
    else if (tableLines.length && l.trim() && lines[j - 1].trim() && isContinuationLine(l)) j++;
    else break;
  }
  if (tableLines.length < 3) return -1;
  const proseRows = tableLines.filter((r) => cellsOf(r).some(proseCell)).length;
  if (proseRows / tableLines.length > 0.25) return -1;
  return j;
}

const tidyCell = (t) => t.replace(/(\d)-\s+(\d)/g, "$1-$2").replace(/(\d)\.\s+(\d)/g, "$1.$2");

/** Turn the raw lines of one table run into "a | b | c" rows, joining wrapped cells. */
function buildRows(runLines) {
  const lines = runLines.filter((l) => l.trim());
  // in a longer table where nearly every line looks like a continuation, it is just lowercase text: don't merge
  const contCount = lines.slice(1).filter(isContinuationLine).length;
  const mergeWrapped = lines.length < 6 || contCount / (lines.length - 1) <= 0.7;
  const rows = [];
  for (const line of lines) {
    const cells = cellsPos(line);
    const prev = rows[rows.length - 1];
    if (mergeWrapped && prev && isContinuationLine(line)) {
      for (const c of cells) {
        let k = 0;
        prev.forEach((pc, idx) => {
          if (pc.start <= c.start + 2) k = idx;
        });
        prev[k].text += " " + c.text;
      }
    } else rows.push(cells.map((c) => ({ ...c })));
  }
  return rows.map((r) => r.map((c) => tidyCell(c.text)).join(" | "));
}

/** Split a layout page into alternating {type:'text'|'table'} blocks. */
function layoutBlocks(pageText) {
  const lines = pageText.split("\n").filter((l) => !l.trim() || keepLine(l));
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const end = tableRunEnd(lines, i);
    if (end > 0) {
      blocks.push({ type: "table", rows: buildRows(lines.slice(i, end)) });
      i = end;
      continue;
    }
    let j = i + 1;
    while (j < lines.length && tableRunEnd(lines, j) < 0) j++;
    blocks.push({ type: "text", text: lines.slice(i, j).map((l) => l.trim()).join("\n") });
    i = j;
  }
  return blocks;
}

/** Count lines with a wide internal gap — a sign of side-by-side columns/sidebars. */
function gapLineCount(pageText) {
  return pageText.split("\n").filter((l) => keepLine(l) && /\S {3,}\S/.test(l.trim())).length;
}

// ── build ordered segments ───────────────────────────────────────────────────
const segments = []; // {page, type:'para'|'heading'|'table', text|rows}
const tablePages = [];
const columnPages = [];
const numericPages = new Set();
for (let p = firstPage; p <= lastPage; p++) {
  if (skipPages.has(p)) continue;
  const layout = layoutPages[p - 1] || "";
  const raw = rawPages[p - 1] || "";
  const blocks = layoutBlocks(layout);
  const hasTable = blocks.some((b) => b.type === "table");
  const twoCol = isTwoColumn(layout);
  if (hasTable) tablePages.push(p);
  if (twoCol) columnPages.push(p);
  if (!hasTable && (twoCol || gapLineCount(layout) >= 4)) {
    // side-by-side columns / sidebars: reading-order text beats -layout
    if (!twoCol) columnPages.push(p);
    for (const par of toParagraphs(raw)) segments.push({ page: p, type: par.heading ? "heading" : "para", text: par.text });
    continue;
  }
  for (const b of blocks) {
    if (b.type === "table") {
      if (skipTables.has(p)) continue;
      segments.push({ page: p, type: "table", rows: b.rows });
      const flat = b.rows.join("").replace(/[\s|]/g, "");
      if (flat.length && (flat.match(/[0-9.,:+%-]/g) || []).length / flat.length > 0.6) numericPages.add(p);
    } else for (const par of toParagraphs(b.text)) segments.push({ page: p, type: par.heading ? "heading" : "para", text: par.text });
  }
}

// ── chunking ─────────────────────────────────────────────────────────────────
const SKIP_HEADING = /^(references?|bibliography|further reading|acknowledge?ments?)\b/i;
const chunks = [];
let heading = "";
let headingPage = 0;
let buf = [];
let bufStart = 0;
let bufEnd = 0;
let skipping = false;
let skippedRefParas = 0;

function splitLong(text) {
  if (text.length <= maxChars) return [text];
  const parts = [];
  let cur = "";
  for (const s of text.split(/(?<=[.!?])\s+/)) {
    if ((cur + " " + s).length > maxChars && cur) {
      parts.push(cur);
      cur = s;
    } else cur = cur ? cur + " " + s : s;
  }
  if (cur) parts.push(cur);
  return parts;
}

function pushChunk(type, body, pageStart, pageEnd) {
  const content = heading ? `${heading}\n\n${body}` : body;
  chunks.push({ type, heading, page: pageStart, page_end: pageEnd, content });
}

function flush() {
  if (buf.length) pushChunk("text", buf.join("\n\n"), bufStart, bufEnd);
  buf = [];
}

for (const seg of segments) {
  if (seg.type === "heading") {
    flush();
    skipping = SKIP_HEADING.test(seg.text);
    heading = seg.text;
    headingPage = seg.page;
    continue;
  }
  // a heading from many pages back no longer describes this content
  if (heading && seg.page - headingPage > 6) {
    flush();
    heading = "";
  }
  if (skipping) {
    skippedRefParas++;
    continue;
  }
  if (seg.type === "table") {
    flush();
    const header = seg.rows[0];
    let group = [];
    let len = 0;
    const emit = () => {
      if (!group.length) return;
      const rows = group[0] === header ? group : [header, ...group];
      pushChunk("table", `Table (page ${seg.page}):\n${rows.join("\n")}`, seg.page, seg.page);
      group = [];
      len = 0;
    };
    for (const r of seg.rows) {
      if (len + r.length > maxChars * 1.5 && group.length) emit();
      group.push(r);
      len += r.length + 1;
    }
    emit();
    continue;
  }
  for (const piece of splitLong(seg.text)) {
    const cur = buf.join("\n\n").length;
    if (buf.length && cur + piece.length > maxChars) flush();
    if (!buf.length) bufStart = seg.page;
    buf.push(piece);
    bufEnd = seg.page;
  }
}
flush();

// merge tiny text chunks: into the previous chunk with the same heading, or (as a
// lead-in like "Approximate portions per meal:") into the table that follows.
const merged = [];
let droppedTiny = 0;
const stripHeading = (c) => (c.heading && c.content.startsWith(c.heading) ? c.content.slice(c.heading.length).trim() : c.content);
for (let i = 0; i < chunks.length; i++) {
  const c = chunks[i];
  const prev = merged[merged.length - 1];
  const next = chunks[i + 1];
  if (c.type === "text" && c.content.length < minChars) {
    if (next && next.type === "table" && next.heading === c.heading) {
      next.lead = (c.lead ? c.lead + "\n" : "") + stripHeading(c);
      continue;
    }
    if (prev && prev.type === "text" && prev.heading === c.heading) {
      prev.content += "\n\n" + stripHeading(c);
      prev.page_end = c.page_end;
      continue;
    }
    if (c.content.length < 60) {
      droppedTiny++; if (process.env.DEBUG_DROP) console.error("DROPPED:", JSON.stringify(c));
      continue;
    }
  }
  if (c.lead) {
    const body = stripHeading(c);
    c.content = (c.heading ? c.heading + "\n\n" : "") + c.lead + "\n" + body;
  }
  merged.push(c);
}

// extra chunks (figure descriptions etc.)
if (typeof args.extra === "string") {
  if (!fs.existsSync(args.extra)) die(`--extra file not found: ${args.extra}`);
  let extra;
  try {
    extra = JSON.parse(fs.readFileSync(args.extra, "utf8"));
  } catch (e) {
    die(`--extra is not valid JSON: ${e.message}`);
  }
  for (const e of extra) {
    if (!e.content) continue;
    const h = e.heading || "";
    merged.push({
      type: "figure",
      heading: h,
      page: e.page || 0,
      page_end: e.page || 0,
      content: h ? `${h}\n\n${e.content}` : e.content,
    });
  }
}

const payloads = merged.map((c, i) => ({
  content: c.content,
  source,
  context,
  metadata: {
    doc: source,
    type: c.type,
    page: c.page,
    page_end: c.page_end,
    heading: c.heading || null,
    chunk: i + 1,
    of: merged.length,
  },
}));

// ── dry-run report ───────────────────────────────────────────────────────────
function report() {
  const sizes = payloads.map((p) => p.content.length);
  const avg = sizes.length ? Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length) : 0;
  const byType = payloads.reduce((m, p) => ((m[p.metadata.type] = (m[p.metadata.type] || 0) + 1), m), {});
  console.log(`\nPDF: ${pdf}`);
  console.log(`Pages processed: ${firstPage}-${lastPage} of ${totalPages}`);
  console.log(`Source: "${source}"   context: ${context}`);
  console.log(`Chunks: ${payloads.length}  (${Object.entries(byType).map(([k, v]) => `${k}: ${v}`).join(", ")})`);
  console.log(`Size: min ${sizes.length ? Math.min(...sizes) : 0}, avg ${avg}, max ${sizes.length ? Math.max(...sizes) : 0} chars`);
  const hc = new Map();
  for (const c of payloads) if (c.metadata.heading) hc.set(c.metadata.heading, (hc.get(c.metadata.heading) || 0) + 1);
  if (hc.size) {
    const top = [...hc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
    console.log(`Headings used (chunks): ${top.map(([h, n]) => `${h.slice(0, 40)} (${n})`).join("; ")}`);
    console.log(`  ↑ if a heading here is really a table label or a stray word, tell me and I'll add it to the ignore list`);
  }
  if (skippedRefParas) console.log(`Skipped ${skippedRefParas} paragraph(s) under References/Bibliography/Acknowledgements`);
  if (droppedTiny) console.log(`Dropped ${droppedTiny} tiny scrap(s) (<60 chars)`);
  if (skipPages.size) console.log(`Skipped by --skip-pages: ${ranges([...skipPages])}`);
  if (skipTables.size) console.log(`Tables dropped by --skip-tables on pages: ${ranges([...skipTables])} (their other text is kept)`);
  if (tablePages.length) console.log(`\nTable content on pages: ${ranges(tablePages)}  ← check these in the preview`);
  if (numericPages.size) console.log(`Mostly-numeric lookup grids on pages: ${ranges([...numericPages])}  ← rarely useful as retrievable text; consider --skip-pages ${ranges([...numericPages])}`);
  if (columnPages.length) console.log(`Side-by-side columns/sidebars on pages: ${ranges(columnPages)}  ← read in column order; check they read naturally`);

  const imgPages = Object.keys(imagesPerPage).map(Number).filter((p) => p >= firstPage && p <= lastPage && !skipPages.has(p)).sort((a, b) => a - b);
  if (imgPages.length) {
    console.log(`\nPages with pictures (count): ${imgPages.map((p) => `${p}(${imagesPerPage[p]})`).join(", ")}`);
    const thin = imgPages.filter((p) => (rawPages[p - 1] || "").replace(/\s+/g, " ").trim().length < 200);
    if (thin.length) console.log(`Pages that are mostly picture, little text: ${thin.join(", ")}  ← nothing useful extracted; describe them via --extra if they matter`);
  }
  const empty = [];
  for (let p = firstPage; p <= lastPage; p++) if (!skipPages.has(p) && !(rawPages[p - 1] || "").trim()) empty.push(p);
  if (empty.length) console.log(`\nPages with NO text layer (scanned/image only): ${empty.join(", ")}`);

  const show = (label, c) => console.log(`\n── ${label} (chunk ${c.metadata.chunk}, p.${c.metadata.page}, ${c.metadata.type}, ${c.content.length} chars) ──\n${c.content.slice(0, 500)}${c.content.length > 500 ? " …" : ""}`);
  if (payloads.length) {
    show("first chunk", payloads[0]);
    const t = payloads.find((p) => p.metadata.type === "table");
    if (t) show("first table chunk", t);
    if (payloads.length > 1) show("last chunk", payloads[payloads.length - 1]);
  }
}

fs.writeFileSync(previewFile, JSON.stringify(payloads, null, 2));

if (!args.ingest) {
  report();
  console.log(`\nDRY RUN — nothing was sent. Full preview: ${previewFile}`);
  console.log(`To ingest for real, add --ingest (and set ADMIN_KEY).`);
  process.exit(0);
}

// ── real ingest ──────────────────────────────────────────────────────────────
if (!KEY) die("Set ADMIN_KEY before using --ingest.");
if (!payloads.length) die("No chunks to ingest.");

let progress = { source, total: payloads.length, done: [] };
if (fs.existsSync(progressFile)) {
  const saved = JSON.parse(fs.readFileSync(progressFile, "utf8"));
  if (saved.source === source && saved.total === payloads.length) {
    progress = saved;
    console.log(`Resuming: ${progress.done.length}/${payloads.length} chunks already ingested.`);
  } else {
    die(`Found ${progressFile} from a different run (total ${saved.total} vs ${payloads.length} now).\nIf you changed options, clear the old chunks first:  node scripts/ingest-pdf.mjs --source "${source}" --purge\n(that also deletes the progress file)`);
  }
}
const done = new Set(progress.done);

for (let i = 0; i < payloads.length; i++) {
  if (done.has(i)) continue;
  let ok = false;
  for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
    let res;
    try {
      res = await fetch(`${API_URL}/rag/ingest`, { method: "POST", headers: authHeaders(), body: JSON.stringify(payloads[i]) });
    } catch (e) {
      console.error(`  chunk ${i + 1}: network error (${e.message}), retry ${attempt}/3`);
      await sleep(1500 * attempt);
      continue;
    }
    if (res.ok) ok = true;
    else {
      const text = await res.text();
      if (res.status === 401 || res.status === 403) die(`Auth rejected (${res.status}): ${text}\nCheck ADMIN_KEY, or set AUTH_HEADER to the header name the Worker expects. Nothing was inserted for this chunk.`);
      if (res.status === 400) die(`Chunk ${i + 1} rejected (400): ${text}`);
      console.error(`  chunk ${i + 1}: HTTP ${res.status}, retry ${attempt}/3`);
      await sleep(1500 * attempt);
    }
  }
  if (!ok) die(`Chunk ${i + 1} failed after 3 tries. Progress is saved — run the same command again to resume.`);
  done.add(i);
  progress.done = [...done];
  fs.writeFileSync(progressFile, JSON.stringify(progress));
  process.stdout.write(`\r  ingested ${done.size}/${payloads.length}`);
  await sleep(250);
}

console.log(`\n\n✔ Done: ${done.size} chunks ingested under source "${source}".`);
console.log(`Undo any time:  ADMIN_KEY=... node scripts/ingest-pdf.mjs --source "${source}" --purge`);

import test from "node:test";
import assert from "node:assert/strict";
import { chunkMarkdown, extOf } from "../src/ragPipeline.js";

test("extOf", () => {
  assert.equal(extOf("a/b/Guide.PDF"), "pdf");
  assert.equal(extOf("noext"), "");
});

test("chunks keep headings and prepend them", () => {
  const md = "# Intro\n\nHello world.\n\n## Feeding\n\nGive porridge twice daily.";
  const c = chunkMarkdown(md, { maxChars: 1200, minChars: 5 });
  assert.equal(c.length, 2);
  assert.ok(c[0].content.startsWith("Intro\n\n"));
  assert.ok(c[1].content.startsWith("Feeding\n\n"));
});

test("tables stay whole and separate", () => {
  const md = "# T\n\nIntro text here that is long enough to stand alone.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n";
  const c = chunkMarkdown(md, { minChars: 5 });
  const t = c.find((x) => x.type === "table");
  assert.ok(t.content.includes("| 1 | 2 |") && t.content.includes("| 3 | 4 |"));
});

test("long text is split under maxChars", () => {
  const md = "# L\n\n" + "Sentence number one is here. ".repeat(200);
  const c = chunkMarkdown(md, { maxChars: 500, minChars: 5 });
  assert.ok(c.length > 3);
  assert.ok(c.every((x) => x.content.length <= 520));
});

test("long table splits with header repeated", () => {
  const rows = Array.from({ length: 200 }, (_, i) => `| food${i} | ${i} |`).join("\n");
  const c = chunkMarkdown(`# F\n\n| name | kcal |\n|---|---|\n${rows}`, { maxChars: 500 });
  const tables = c.filter((x) => x.type === "table");
  assert.ok(tables.length > 1);
  assert.ok(tables.every((t) => t.content.includes("| name | kcal |")));
});

test("plain text with no headings", () => {
  const c = chunkMarkdown("Just a paragraph.\n\nAnother one.", { minChars: 5 });
  assert.equal(c.length, 1);
  assert.ok(!c[0].content.startsWith("null"));
});

import { cleanMarkdown, pdfPagesToMarkdown, dropReferenceChunks } from "../src/ragPipeline.js";

test("cleanMarkdown strips metadata block, image placeholders, page markers", () => {
  const md = "Metadata\n\n- PDFFormatVersion=1.7\n- Language=en\n\nPage 1\n\n![Logo]()\n\n# Real heading\n\nReal body text.";
  const out = cleanMarkdown(md);
  assert.ok(!out.includes("PDFFormatVersion"));
  assert.ok(!out.includes("![Logo]"));
  assert.ok(!/Page 1/.test(out));
  assert.ok(out.includes("Real body text."));
});

test("pdfPagesToMarkdown: headings, wrapped lines, hyphenation, running headers", () => {
  const hdr = "R. Author et al. Clinical Nutrition 40 (2021)";
  const pages = [
    `${hdr}\n4.5.3. What are the indications of a low-calorie diet?\nThis is a sentence that is wrap-\nped over two lines and\ncontinues here.\n5688`,
    `${hdr}\nMore text on page two.\n5689`,
    `${hdr}\nAnd page three.\n5690`,
  ];
  const md = pdfPagesToMarkdown(pages);
  assert.ok(md.includes("## 4.5.3. What are the indications of a low-calorie diet?"));
  assert.ok(md.includes("wrapped over two lines and continues here."));
  assert.ok(!md.includes("R. Author et al."));
  assert.ok(!/\b568\d\b/.test(md));
});

test("wrapped recommendation sentence is not mistaken for a heading", () => {
  const md = pdfPagesToMarkdown(["4.5.3.2. Recommendation 32. There are very few indications for\nlow-calorie diets."]);
  assert.ok(!md.includes("## "));
});

test("dropReferenceChunks removes bibliography, keeps body", () => {
  const refs = "[1] Thibault R, Chikhi M. Clin Nutr 2011;30:289. [2] Vaillant MF, Hennequin V. Nutr Clin 2019;33:131. [3] Cederholm T, Barazzoni R. Clin Nutr 2017;36:49.";
  const body = "Patients at nutritional risk should receive the hospital diet and be monitored daily [12].";
  const { chunks, dropped } = dropReferenceChunks([{ content: refs }, { content: body }]);
  assert.equal(dropped, 1);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].content, body);
});

test("chunkMarkdown tracks page and page_end from page markers", () => {
  const md = "<!--p:3-->\n\nAlpha text on page three.\n\n<!--p:4-->\n\nBeta text on page four.";
  const [c] = chunkMarkdown(md, { minChars: 5 });
  assert.equal(c.page, 3);
  assert.equal(c.pageEnd, 4);
  assert.ok(!c.content.includes("<!--"));
});

test("a long section spanning pages keeps per-chunk pages", () => {
  const filler = "This is a full sentence about hospital nutrition. ".repeat(60);
  const md = `<!--p:1-->\n\n${filler}\n\n<!--p:2-->\n\n${filler}\n\n<!--p:3-->\n\n${filler}`;
  const cs = chunkMarkdown(md, { maxChars: 1200, minChars: 5 });
  assert.equal(cs[0].page, 1);
  assert.equal(cs[cs.length - 1].pageEnd, 3);
  assert.ok(cs.every((c) => c.page >= 1 && c.pageEnd <= 3 && c.pageEnd >= c.page));
});

test("pdfPagesToMarkdown emits page markers; text without markers has null pages", () => {
  assert.ok(pdfPagesToMarkdown(["One.", "Two."]).includes("<!--p:2-->"));
  assert.equal(chunkMarkdown("No markers here at all.", { minChars: 5 })[0].page, null);
});

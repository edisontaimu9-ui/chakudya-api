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

/**
 * ragPipeline.js — automated RAG ingestion (runs beside the manual
 * scripts/ingest-pdf.mjs + POST /rag/ingest path, which are unchanged).
 *
 *   POST /rag/upload (multipart)  ┐
 *   POST /rag/enqueue (JSON)      ┴→ Supabase Storage → rag_ingest_jobs row
 *        → Cloudflare Queue (INGEST_QUEUE) → queue() consumer:
 *        download → extract text (Workers AI toMarkdown / plain text)
 *        → chunk → Cohere embed (batched) → rag_knowledge_base
 *   GET  /rag/jobs, GET /rag/jobs/:id   → status
 *
 * Redis is not used: Cloudflare Queues is the queue (native to Workers).
 * Chunks go into the same rag_knowledge_base table with the same shape
 * as manual ingest, so /rag/retrieve and /rag/ask need no changes.
 */

import { trackedFetch } from "./upstreamFailures.js";

export const BUCKET = "rag-uploads";
const MAX_BYTES = 25 * 1024 * 1024;
const ALLOWED_EXT = ["pdf", "docx", "txt", "md", "csv", "html"];
const PLAIN_EXT = ["txt", "md", "csv"];
const EMBED_BATCH = 96; // Cohere embed max texts per call
const MIN_TEXT_CHARS = 200; // below this we assume a scanned/empty file
const VALID_CONTEXTS = ["clinical", "general", "both"];

const MIME = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  html: "text/html",
  csv: "text/csv",
  txt: "text/plain",
  md: "text/markdown",
};

// ── Supabase Storage (REST) ──────────────────────────────────────────────────
function storageBase(env) {
  return env.SUPABASE_URL.replace(/\/$/, "") + "/storage/v1";
}
function storageHeaders(env, extra = {}) {
  const key = (env.SUPABASE_KEY || "").trim();
  return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
}
function encPath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

export async function storageUpload(env, path, bytes, contentType) {
  const res = await fetch(`${storageBase(env)}/object/${BUCKET}/${encPath(path)}`, {
    method: "POST",
    headers: storageHeaders(env, { "Content-Type": contentType, "x-upsert": "true" }),
    body: bytes,
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(`Storage upload failed (${res.status}): ${e.message || e.error || "unknown"}`);
  }
}

export async function storageDownload(env, path) {
  const res = await fetch(`${storageBase(env)}/object/authenticated/${BUCKET}/${encPath(path)}`, {
    headers: storageHeaders(env),
  });
  if (!res.ok) throw new Error(`Storage download failed (${res.status}) for "${path}"`);
  return new Uint8Array(await res.arrayBuffer());
}

// ── extraction ───────────────────────────────────────────────────────────────
export function extOf(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(name || "");
  return m ? m[1].toLowerCase() : "";
}

// Strip the noise Workers AI toMarkdown adds (PDF metadata block, image
// placeholders, "Page N" markers) so it can't pass for real content.
export function cleanMarkdown(md) {
  return String(md || "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/^#{0,6}[ \t]*Metadata[ \t]*\n(?:[ \t]*-[^\n]*\n?|\n)+/gim, "")
    .replace(/^[ \t]*Page \d+[ \t]*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Numbered section headings like "4.5.3. What are the indications of ...?"
// (not wrapped sentences such as "4.5.3.2. Recommendation 32. There are ...")
const NUM_HEADING = /^\d{1,2}\.(?:\d{1,2}\.?)*\s+([A-Z].{2,110})$/;
function isHeadingLine(l) {
  const m = NUM_HEADING.exec(l);
  return !!m && !/\.\s+[A-Z]/.test(m[1]) && !/[,;:]$/.test(l);
}

/**
 * pdf.js gives raw lines per page. Rebuild paragraphs: drop running headers /
 * page numbers (lines repeated on many pages), join wrapped lines, undo
 * end-of-line hyphenation, and turn numbered section titles into "## " headings.
 */
export function pdfPagesToMarkdown(pages) {
  const freq = new Map();
  for (const p of pages) {
    for (const l of new Set(p.split("\n").map((x) => x.trim()))) if (l) freq.set(l, (freq.get(l) || 0) + 1);
  }
  const minRep = Math.max(3, Math.ceil(pages.length * 0.3));
  const isNoise = (l) => /^\d{3,5}$/.test(l) || (l.length < 160 && (freq.get(l) || 0) >= minRep);

  const paras = [];
  let cur = [];
  const flush = () => {
    if (cur.length) paras.push(cur.join(" ").replace(/\s+/g, " ").trim());
    cur = [];
  };
  for (let pi = 0; pi < pages.length; pi++) {
    // Page marker (consumed by chunkMarkdown, never reaches chunk text).
    // Paragraphs break at page boundaries so every chunk knows its pages.
    flush();
    paras.push(`<!--p:${pi + 1}-->`);
    for (const raw of pages[pi].split("\n")) {
      const l = raw.trim();
      if (!l || isNoise(l)) continue;
      if (isHeadingLine(l)) {
        flush();
        paras.push("## " + l);
        continue;
      }
      const last = cur[cur.length - 1];
      if (last && /[A-Za-z]-$/.test(last) && /^[a-z]/.test(l)) cur[cur.length - 1] = last.slice(0, -1) + l;
      else cur.push(l);
    }
  }
  flush();
  return paras.join("\n\n");
}

export async function extractText(env, name, bytes) {
  const ext = extOf(name);
  if (PLAIN_EXT.includes(ext)) return new TextDecoder().decode(bytes);

  if (ext === "pdf") {
    // Real text extraction (pdf.js via unpdf). Workers AI toMarkdown returned
    // only metadata/image placeholders for some publisher PDFs.
    const { getDocumentProxy, extractText: pdfText } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await pdfText(pdf, { mergePages: false });
    return pdfPagesToMarkdown(text);
  }

  if (!env.AI) throw new Error("Workers AI binding 'AI' is not configured (needed for DOCX/HTML)");
  const blob = new Blob([bytes], { type: MIME[ext] || "application/octet-stream" });
  const [r] = await env.AI.toMarkdown([{ name, blob }]);
  if (!r || r.format === "error") throw new Error(`Text extraction failed: ${r?.error || "no result"}`);
  return cleanMarkdown(r.data || "");
}

// ── chunking (markdown-aware: keeps headings, keeps tables whole) ────────────
function splitLongText(text, maxChars) {
  if (text.length <= maxChars) return [text];
  const out = [];
  let cur = "";
  for (const s of text.split(/(?<=[.!?])\s+/)) {
    if ((cur + " " + s).trim().length > maxChars && cur) {
      out.push(cur.trim());
      cur = s;
    } else cur = (cur + " " + s).trim();
    while (cur.length > maxChars) {
      // no sentence breaks: hard split on a space
      let cut = cur.lastIndexOf(" ", maxChars);
      if (cut < maxChars * 0.5) cut = maxChars;
      out.push(cur.slice(0, cut).trim());
      cur = cur.slice(cut).trim();
    }
  }
  if (cur) out.push(cur.trim());
  return out;
}

function splitTable(lines, maxChars) {
  const text = lines.join("\n");
  if (text.length <= maxChars * 2) return [text];
  const head = lines.slice(0, 2); // header row + separator
  const rows = lines.slice(2);
  const out = [];
  let cur = [];
  let len = head.join("\n").length;
  for (const row of rows) {
    if (len + row.length + 1 > maxChars * 1.5 && cur.length) {
      out.push([...head, ...cur].join("\n"));
      cur = [];
      len = head.join("\n").length;
    }
    cur.push(row);
    len += row.length + 1;
  }
  if (cur.length) out.push([...head, ...cur].join("\n"));
  return out;
}

export function chunkMarkdown(text, { maxChars = 1200, minChars = 150 } = {}) {
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let heading = null;
  let page = null;
  let para = [];
  let table = [];
  const flushPara = () => {
    if (para.length) blocks.push({ heading, page, type: "text", text: para.join("\n").trim() });
    para = [];
  };
  const flushTable = () => {
    if (table.length) blocks.push({ heading, page, type: "table", lines: table });
    table = [];
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const pm = line.match(/^<!--p:(\d+)-->$/);
    if (pm) {
      flushPara();
      flushTable();
      page = Number(pm[1]);
      continue;
    }
    const h = line.match(/^#{1,6}\s+(.+)$/);
    if (h) {
      flushPara();
      flushTable();
      heading = h[1].trim();
      continue;
    }
    if (/^\s*\|/.test(line)) {
      flushPara();
      table.push(line);
      continue;
    }
    flushTable();
    if (!line.trim()) flushPara();
    else para.push(line);
  }
  flushPara();
  flushTable();

  // assemble chunks
  const chunks = [];
  let cur = null;
  const flushCur = () => {
    if (cur && cur.body.trim()) chunks.push(cur);
    cur = null;
  };
  for (const b of blocks) {
    if (b.type === "table") {
      flushCur();
      for (const t of splitTable(b.lines, maxChars)) {
        chunks.push({ heading: b.heading, type: "table", body: t, page: b.page, pageEnd: b.page });
      }
      continue;
    }
    for (const piece of splitLongText(b.text, maxChars)) {
      if (cur && cur.heading === b.heading && cur.body.length + piece.length + 2 <= maxChars) {
        cur.body += "\n\n" + piece;
        cur.pageEnd = b.page;
      } else {
        flushCur();
        cur = { heading: b.heading, type: "text", body: piece, page: b.page, pageEnd: b.page };
      }
    }
  }
  flushCur();

  // merge tiny text chunks into the previous one under the same heading
  const merged = [];
  for (const c of chunks) {
    const prev = merged[merged.length - 1];
    if (prev && c.type === "text" && prev.type === "text" && prev.heading === c.heading && c.body.length < minChars) {
      prev.body += "\n\n" + c.body;
      prev.pageEnd = c.pageEnd;
    } else merged.push({ ...c });
  }

  return merged.map((c) => ({
    type: c.type,
    heading: c.heading,
    page: c.page ?? null,
    pageEnd: c.pageEnd ?? null,
    content: c.heading ? `${c.heading}\n\n${c.body}` : c.body,
  }));
}

/** Drop chunks that are mostly a numbered bibliography ("[12] Surname AB, ... 2019;33:1-9"). */
export function dropReferenceChunks(chunks) {
  const kept = [];
  let dropped = 0;
  for (const c of chunks) {
    const refs = (c.content.match(/\[\d{1,3}\]\s+\p{Lu}[\p{L}'’-]+\s+\p{Lu}{1,3}[,\s]/gu) || []).length;
    const years = (c.content.match(/\b(?:19|20)\d{2}[;:.,]/g) || []).length;
    if (refs >= 2 && years >= 3) dropped++;
    else kept.push(c);
  }
  return { chunks: kept, dropped };
}

// ── embeddings (batched; same model as embedText in index.js) ────────────────
export async function embedBatch(texts, env) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await trackedFetch(env, "cohere", "https://api.cohere.com/v1/embed", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.COHERE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ texts, model: "embed-multilingual-v3.0", input_type: "search_document" }),
    });
    if (res.ok) return (await res.json()).embeddings;
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      continue;
    }
    const e = await res.json().catch(() => ({}));
    throw new Error(`Cohere embed failed: ${e.message || res.status}`);
  }
}

// ── job processing (called by the queue consumer) ────────────────────────────
async function setJob(db, id, patch) {
  await db.update("rag_ingest_jobs", id, { ...patch, updated_at: new Date().toISOString() });
}

export async function processJob(env, db, jobId) {
  const { ok, body: job } = await db.selectOne("rag_ingest_jobs", jobId);
  const row = Array.isArray(job) ? job[0] : job;
  if (!ok || !row?.id) throw new Error(`Job ${jobId} not found`);
  if (row.status === "done") return row; // duplicate delivery — nothing to do

  await setJob(db, jobId, { status: "processing", attempts: (row.attempts || 0) + 1, error: null });

  const bytes = await storageDownload(env, row.file_path);
  const text = await extractText(env, row.file_name, bytes);
  if (text.trim().length < MIN_TEXT_CHARS) {
    const e = new Error("Almost no text extracted — likely a scanned/image-only file. Use manual ingest (OCR) for this one.");
    e.permanent = true;
    throw e;
  }
  const { chunks, dropped } = dropReferenceChunks(chunkMarkdown(text));
  if (dropped) console.log(`[rag-ingest] job ${jobId}: dropped ${dropped} bibliography chunk(s)`);
  if (!chunks.length) {
    const e = new Error("No chunks produced from extracted text");
    e.permanent = true;
    throw e;
  }

  // Idempotent: clear anything a previous attempt of THIS job inserted, and
  // (if asked) every older chunk under this source, before inserting.
  await db.removeWhere("rag_knowledge_base", { "metadata->>job_id": `eq.${jobId}` });
  if (row.replace) await db.removeWhere("rag_knowledge_base", { source: `eq.${row.source}` });

  let inserted = 0;
  for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
    const slice = chunks.slice(i, i + EMBED_BATCH);
    const embeddings = await embedBatch(slice.map((c) => c.content), env);
    const rows = slice.map((c, j) => ({
      content: c.content,
      embedding: JSON.stringify(embeddings[j]),
      source: row.source,
      context: row.context,
      metadata: {
        doc: row.source,
        type: c.type,
        heading: c.heading || null,
        ...(c.page ? { page: c.page } : {}),
        ...(c.pageEnd && c.pageEnd !== c.page ? { page_end: c.pageEnd } : {}),
        chunk: i + j + 1,
        of: chunks.length,
        job_id: jobId,
        file: row.file_name,
        ingest: "auto",
      },
    }));
    const r = await db.insertMany("rag_knowledge_base", rows);
    if (!r.ok) throw new Error(`Insert failed (${r.status}): ${r.body?.message || "unknown"}`);
    inserted += rows.length;
  }

  await setJob(db, jobId, { status: "done", chunk_count: inserted, error: null });
  return { id: jobId, chunk_count: inserted };
}

/** Cloudflare Queues consumer. One document per invocation (max_batch_size = 1). */
export async function handleIngestQueue(batch, env, db) {
  for (const msg of batch.messages) {
    const jobId = msg.body?.job_id;
    try {
      await processJob(env, db, jobId);
      msg.ack();
    } catch (e) {
      console.error(`[rag-ingest] job ${jobId} failed:`, e.message);
      try {
        await setJob(db, jobId, { status: "failed", error: String(e.message).slice(0, 500) });
      } catch {}
      // permanent problems (scanned PDF etc.) or out of attempts: stop retrying
      if (e.permanent || msg.attempts >= 3) msg.ack();
      else msg.retry({ delaySeconds: 30 * msg.attempts });
    }
  }
}

const JOB_STATUSES = ["queued", "processing", "done", "failed"];

/** Parses the optional list filters for GET /rag/jobs. Returns { filters, limit, offset } or { error }. */
export function jobListQuery(params) {
  const filters = {};
  const status = params.get("status");
  if (status) {
    if (!JOB_STATUSES.includes(status)) return { error: `'status' must be one of: ${JOB_STATUSES.join(", ")}` };
    filters.status = `eq.${status}`;
  }
  const limit = Math.min(Math.max(parseInt(params.get("limit") || "20", 10) || 20, 1), 100);
  const offset = Math.max(parseInt(params.get("offset") || "0", 10) || 0, 0);
  return { filters, limit, offset };
}

/** Keeps list responses small: a failed job's error text is capped (the single-job route returns it whole). */
export function trimJobError(job) {
  return job && typeof job.error === "string" && job.error.length > 500 ? { ...job, error: job.error.slice(0, 500) + "…" } : job;
}

// ── HTTP routes ──────────────────────────────────────────────────────────────
function safeName(name) {
  return name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-120) || "file";
}

async function createAndEnqueue(db, env, { filePath, fileName, source, context, replace }, { success, err }) {
  const { ok, status, body: job } = await db.insert("rag_ingest_jobs", {
    file_path: filePath,
    file_name: fileName,
    source,
    context,
    replace: !!replace,
  });
  if (!ok) return err(job?.message || "Could not create ingest job (is sql/015 applied?)", status);
  if (!env.INGEST_QUEUE) {
    return err(`Job ${job.id} created but INGEST_QUEUE binding is missing — create the queue and redeploy`, 503);
  }
  await env.INGEST_QUEUE.send({ job_id: job.id });
  return success(job, { message: "Queued. Poll GET /rag/jobs/" + job.id });
}

function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.length !== y.length) return false;
  return crypto.subtle.timingSafeEqual(x, y);
}

/**
 * POST /rag/webhook — called by the Supabase trigger (sql/016) whenever a file
 * lands in the rag-uploads bucket. Auth = shared secret header, not the admin key.
 * Folder picks the context: clinical/…, general/…, anything else = both.
 * Source = file name without extension. Re-uploads replace the old chunks.
 */
export async function handleRagWebhook(request, env, db, { success, err }) {
  const secret = env.INGEST_WEBHOOK_SECRET;
  if (!secret) return err("INGEST_WEBHOOK_SECRET is not configured", 503);
  if (!safeEqual(request.headers.get("x-webhook-secret") || "", secret)) return err("Unauthorized", 401);

  let body = null;
  try {
    body = await request.json();
  } catch {}
  const name = body?.name;
  if (body?.bucket !== BUCKET || !name) return err("'bucket' and 'name' are required");

  // Skip (200, so the webhook never retries): API uploads already have a job; unsupported types.
  if (name.startsWith("api/")) return success({ skipped: "api upload" });
  const ext = extOf(name);
  if (!ALLOWED_EXT.includes(ext)) return success({ skipped: `unsupported .${ext}` });

  const dup = await db.select("rag_ingest_jobs", {
    filters: { file_path: `eq.${name}`, status: "in.(queued,processing)" },
    limit: 1,
  });
  if (dup.ok && Array.isArray(dup.body) && dup.body.length) {
    return success({ skipped: "already queued", id: dup.body[0].id });
  }

  const segs = name.split("/");
  const fileName = segs.pop();
  const context = VALID_CONTEXTS.includes(segs[0]) ? segs[0] : "both";
  const source = fileName.replace(/\.[^.]+$/, "").replace(/_+/g, " ").trim();

  const { ok, status, body: job } = await db.insert("rag_ingest_jobs", {
    file_path: name,
    file_name: fileName,
    source,
    context,
    replace: true,
  });
  if (!ok) return err(job?.message || "Could not create ingest job", status);
  if (!env.INGEST_QUEUE) return err("INGEST_QUEUE binding is missing", 503);
  // small delay: lets Storage finish writing the object before we download it
  await env.INGEST_QUEUE.send({ job_id: job.id }, { delaySeconds: 10 });
  return success(job, { message: "Queued from storage trigger" });
}

export async function handleRagPipeline(request, url, db, env, param, jobId, { success, err }) {
  if (param === "webhook") {
    if (request.method !== "POST") return err("Method not allowed", 405);
    return handleRagWebhook(request, env, db, { success, err });
  }

  // GET /rag/jobs  |  GET /rag/jobs/:id
  if (param === "jobs") {
    if (request.method !== "GET") return err("Method not allowed", 405);
    if (jobId) {
      const { ok, status, body } = await db.selectOne("rag_ingest_jobs", jobId);
      const row = Array.isArray(body) ? body[0] : body;
      if (!ok || !row?.id) return err("Job not found", status === 200 ? 404 : status);
      return success(row);
    }
    // Optional ?status=queued|processing|done|failed, ?limit= (1-100, default 20), ?offset=.
    const q = jobListQuery(url.searchParams);
    if (q.error) return err(q.error);
    const { ok, status, body, total } = await db.select("rag_ingest_jobs", { filters: q.filters, limit: q.limit, offset: q.offset, order: "created_at.desc" });
    if (!ok) return err(body?.message || "Could not list jobs", status);
    const rows = Array.isArray(body) ? body.map(trimJobError) : [];
    return success(rows, { count: rows.length, total: typeof total === "number" ? total : null, limit: q.limit, offset: q.offset });
  }

  if (request.method !== "POST") return err("Method not allowed", 405);

  // POST /rag/upload — multipart: file, source?, context?, replace?
  if (param === "upload") {
    let form;
    try {
      form = await request.formData();
    } catch {
      return err("Send multipart/form-data with a 'file' field");
    }
    const file = form.get("file");
    if (!file || typeof file === "string") return err("'file' field is required");
    const ext = extOf(file.name);
    if (!ALLOWED_EXT.includes(ext)) return err(`Unsupported file type ".${ext}". Allowed: ${ALLOWED_EXT.join(", ")}`);
    if (file.size > MAX_BYTES) return err(`File too large (max ${MAX_BYTES / 1024 / 1024} MB)`, 413);

    const context = form.get("context") || "both";
    if (!VALID_CONTEXTS.includes(context)) return err(`'context' must be one of: ${VALID_CONTEXTS.join(", ")}`);
    const source = (form.get("source") || file.name.replace(/\.[^.]+$/, "")).toString().trim();
    const replace = ["true", "1", "yes"].includes(String(form.get("replace") || "").toLowerCase());

    const path = `api/${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}-${safeName(file.name)}`;
    try {
      await storageUpload(env, path, await file.arrayBuffer(), file.type || MIME[ext] || "application/octet-stream");
    } catch (e) {
      return err(e.message, 502);
    }
    return createAndEnqueue(db, env, { filePath: path, fileName: file.name, source, context, replace }, { success, err });
  }

  // POST /rag/enqueue — JSON {path, source, context?, replace?} for a file already in the bucket,
  //                     or {job_id} to retry a failed job
  if (param === "enqueue") {
    let body = null;
    try {
      body = await request.json();
    } catch {}
    if (!body) return err("Request body required");

    if (body.job_id) {
      const { ok, body: j } = await db.selectOne("rag_ingest_jobs", body.job_id);
      const row = Array.isArray(j) ? j[0] : j;
      if (!ok || !row?.id) return err("Job not found", 404);
      if (!env.INGEST_QUEUE) return err("INGEST_QUEUE binding is missing", 503);
      await db.update("rag_ingest_jobs", row.id, { status: "queued", error: null, updated_at: new Date().toISOString() });
      await env.INGEST_QUEUE.send({ job_id: row.id });
      return success({ id: row.id, status: "queued" }, { message: "Re-queued" });
    }

    const { path, source, context = "both", replace = false } = body;
    if (!path) return err("'path' (inside the rag-uploads bucket) is required");
    if (!source) return err("'source' is required");
    if (!VALID_CONTEXTS.includes(context)) return err(`'context' must be one of: ${VALID_CONTEXTS.join(", ")}`);
    if (!ALLOWED_EXT.includes(extOf(path))) return err(`Unsupported file type. Allowed: ${ALLOWED_EXT.join(", ")}`);
    return createAndEnqueue(
      db,
      env,
      { filePath: path, fileName: path.split("/").pop(), source, context, replace },
      { success, err }
    );
  }

  return err("Not found", 404);
}

#!/usr/bin/env python3
"""
Ingest a PDF into the Chakudya RAG knowledge base (POST /rag/ingest).

Default mode extracts text page-by-page (pypdf, layout-preserving mode --
pure Python, no native compile step, which matters on Termux/ARM64), splits
each page into ~150-220 word chunks along paragraph boundaries, and POSTs
each chunk with page-level metadata so retrieval results can cite exactly
where they came from.

Table pages are detected automatically and kept as a single unsplit chunk
(instead of running through paragraph-splitting, which can cut a table
apart from its header row).

Scanned/picture-only pages produce no extractable text in default mode and
are flagged at the end -- re-run with --ocr to rasterize every page with
pdftoppm and read it with Tesseract instead.

Usage:
    export CHAKUDYA_ADMIN_KEY="your-admin-key"
    python3 ingest_pdf_to_rag.py <path-to.pdf> \
        --source "Krause & Mahan's Food and the Nutrition Care Process, 16th Ed. (pp. 1131-1168)" \
        --context both \
        --start-page 1131

    # scanned/image-only PDF (or a PDF with scanned pages mixed in):
    python3 ingest_pdf_to_rag.py <path-to.pdf> --source "..." --ocr

Dry run first (no network calls, just shows what would be sent):
    python3 ingest_pdf_to_rag.py <path-to.pdf> --source "..." --dry-run
"""

import argparse
import os
import subprocess
import sys
import tempfile
import shutil
import time

try:
    from pypdf import PdfReader
except ImportError:
    sys.exit("Missing dependency. Run: pip install pypdf requests --break-system-packages")

try:
    import requests
except ImportError:
    sys.exit("Missing dependency. Run: pip install pypdf requests --break-system-packages")

try:
    import pytesseract
    from PIL import Image
except ImportError:
    pytesseract = None  # only required when --ocr is passed

DEFAULT_BASE_URL = "https://chakudya-api.edisontaimu9.workers.dev"
MIN_CHUNK_WORDS = 60
TARGET_CHUNK_WORDS = 180
MAX_CHUNK_WORDS = 260


def looks_like_table(page_text):
    """Heuristic: tabular pages are dense with numbers/short tokens and have
    many short lines (rows), unlike normal prose paragraphs. Layout-mode
    extraction preserves column spacing with runs of whitespace, which is
    itself a strong signal.
    """
    lines = [l for l in page_text.split("\n") if l.strip()]
    if len(lines) < 4:
        return False
    short_lines = sum(1 for l in lines if len(l.split()) <= 12)
    digit_lines = sum(1 for l in lines if sum(c.isdigit() for c in l) >= 2)
    wide_gap_lines = sum(1 for l in lines if "   " in l)  # 3+ spaces = column gap
    return (short_lines / len(lines) > 0.6) and (
        digit_lines / len(lines) > 0.25 or wide_gap_lines / len(lines) > 0.4
    )


def split_page_into_chunks(page_text):
    """Greedily group paragraphs into ~TARGET_CHUNK_WORDS-sized chunks."""
    paragraphs = [p.strip() for p in page_text.split("\n\n") if p.strip()]
    if not paragraphs:
        # Fall back to line-based splitting if the PDF has no blank-line
        # paragraph breaks (common in scanned/columnar textbook layouts).
        paragraphs = [p.strip() for p in page_text.split("\n") if p.strip()]

    chunks = []
    current = []
    current_words = 0

    for para in paragraphs:
        para_words = len(para.split())
        if current_words + para_words > MAX_CHUNK_WORDS and current_words >= MIN_CHUNK_WORDS:
            chunks.append(" ".join(current))
            current = [para]
            current_words = para_words
        else:
            current.append(para)
            current_words += para_words
        if current_words >= TARGET_CHUNK_WORDS:
            chunks.append(" ".join(current))
            current = []
            current_words = 0

    if current:
        chunks.append(" ".join(current))

    return chunks


def ocr_extract_all_pages(pdf_path, dpi):
    """
    Rasterize every page of pdf_path with pdftoppm (poppler), then OCR each
    page image with Tesseract. Returns a list of per-page text strings,
    index-aligned with page number (0-based). Encrypted-but-no-real-password
    PDFs are handled automatically -- pdftoppm tries an empty password same
    as most viewers.
    """
    tmp_dir = tempfile.mkdtemp(prefix="ingest_ocr_")
    try:
        prefix = os.path.join(tmp_dir, "page")
        result = subprocess.run(
            ["pdftoppm", "-jpeg", "-r", str(dpi), pdf_path, prefix],
            capture_output=True, text=True
        )
        if result.returncode != 0:
            sys.exit(f"pdftoppm failed: {result.stderr.strip()}")

        image_files = sorted(f for f in os.listdir(tmp_dir) if f.endswith(".jpg"))
        if not image_files:
            sys.exit("pdftoppm produced no page images -- check the PDF isn't corrupt or password-protected with a real password.")

        page_texts = []
        for idx, fname in enumerate(image_files, 1):
            img_path = os.path.join(tmp_dir, fname)
            print(f"OCR page {idx}/{len(image_files)} ({fname}) ...")
            text = pytesseract.image_to_string(Image.open(img_path))
            page_texts.append(text)
        return page_texts
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pdf_path", help="Path to the PDF file")
    ap.add_argument("--source", required=True, help="Citation string stored on every chunk's 'source' field")
    ap.add_argument("--context", default="both", choices=["clinical", "general", "both"])
    ap.add_argument("--start-page", type=int, default=1, help="Real-world page number of the PDF's first page (for accurate metadata)")
    ap.add_argument("--base-url", default=DEFAULT_BASE_URL)
    ap.add_argument("--dry-run", action="store_true", help="Preview chunks without calling the API")
    ap.add_argument("--sleep", type=float, default=0.3, help="Seconds to sleep between ingest calls (politeness delay)")
    ap.add_argument("--ocr", action="store_true", help="Rasterize each page with pdftoppm and OCR with Tesseract instead of extracting a text layer (use for scanned/image-only PDFs, e.g. flattened slide decks)")
    ap.add_argument("--ocr-dpi", type=int, default=200, help="Rasterization DPI for --ocr mode (higher = better accuracy, slower)")
    args = ap.parse_args()

    if args.ocr and pytesseract is None:
        sys.exit("Missing OCR dependency. Run: pip install pytesseract pillow --break-system-packages\n"
                  "Also make sure the tesseract binary is installed: pkg install tesseract poppler")

    admin_key = os.environ.get("CHAKUDYA_ADMIN_KEY")
    if not args.dry_run and not admin_key:
        sys.exit("Set CHAKUDYA_ADMIN_KEY env var first: export CHAKUDYA_ADMIN_KEY=\"your-admin-key\"")

    if not os.path.isfile(args.pdf_path):
        sys.exit(f"File not found: {args.pdf_path}")

    print(f"Reading {args.pdf_path} ...")
    reader = PdfReader(args.pdf_path)
    if reader.is_encrypted:
        result = reader.decrypt("")
        if result == 0:
            sys.exit(
                "This PDF requires a real password to open (empty password "
                "did not work). Re-run with the correct password, or obtain "
                "an unlocked copy of the file."
            )
    total_pages = len(reader.pages)
    print(f"{total_pages} pages found. Real-world page numbers: {args.start_page}-{args.start_page + total_pages - 1}")

    all_chunks = []  # list of (real_page_number, chunk_text, is_table)
    blank_pages = []  # non-OCR mode only: pages with zero extractable text

    ocr_texts = None
    if args.ocr:
        print(f"OCR mode: rasterizing at {args.ocr_dpi} DPI and running Tesseract on each page...")
        ocr_texts = ocr_extract_all_pages(args.pdf_path, args.ocr_dpi)
        if len(ocr_texts) != total_pages:
            print(f"Warning: pdftoppm produced {len(ocr_texts)} images but pypdf reports {total_pages} pages -- using the shorter of the two.")

    page_count_for_loop = len(ocr_texts) if ocr_texts is not None else total_pages
    for i in range(page_count_for_loop):
        real_page = args.start_page + i

        if ocr_texts is not None:
            text = ocr_texts[i]
        else:
            # "layout" mode preserves the PDF's visual column/row spacing
            # instead of pypdf's default stream-order text, which is what
            # scrambles tables into unreadable word soup.
            try:
                text = reader.pages[i].extract_text(extraction_mode="layout") or ""
            except Exception:
                text = reader.pages[i].extract_text() or ""

        if not text.strip():
            if ocr_texts is None:
                # No text layer at all -> almost certainly a scanned page or
                # a picture/diagram with no text layer. Flag it instead of
                # silently dropping it -- re-run with --ocr to pick these up.
                blank_pages.append(real_page)
            continue

        if looks_like_table(text):
            # Don't run table pages through paragraph-based chunk splitting
            # -- that assumes prose and will cut a table apart from its
            # header row or mid-row. Keep the whole page as one chunk so a
            # query against "Table 29" retrieves the actual rows, not just
            # the caption.
            all_chunks.append((real_page, text.strip(), True))
        else:
            for chunk in split_page_into_chunks(text):
                if len(chunk.split()) >= MIN_CHUNK_WORDS // 2:  # skip near-empty scraps
                    all_chunks.append((real_page, chunk, False))

    print(f"Built {len(all_chunks)} chunks.")
    if blank_pages:
        print(
            f"⚠️  {len(blank_pages)} page(s) had NO extractable text and are NOT "
            f"included above: {blank_pages}\n"
            f"    Re-run with --ocr to rasterize and OCR these specific pages "
            f"(or the whole PDF)."
        )
    print()

    if args.dry_run:
        preview_n = min(3, len(all_chunks))
        print(f"--dry-run: showing first {preview_n} chunk(s), no API calls made.\n")
        for page_num, chunk, is_table in all_chunks[:preview_n]:
            tag = " [TABLE]" if is_table else ""
            print(f"--- page {page_num}{tag} ({len(chunk.split())} words) ---")
            print(chunk[:300] + ("..." if len(chunk) > 300 else ""))
            print()
        print(f"Total chunks that WOULD be ingested: {len(all_chunks)}")
        return

    endpoint = f"{args.base_url.rstrip('/')}/rag/ingest"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {admin_key}",
    }

    ok_count = 0
    fail_count = 0
    for idx, (page_num, chunk, is_table) in enumerate(all_chunks, 1):
        metadata = {"page": page_num}
        if is_table:
            metadata["type"] = "table"
        payload = {
            "content": chunk,
            "source": args.source,
            "context": args.context,
            "metadata": metadata,
        }
        tag = " [TABLE]" if is_table else ""
        try:
            resp = requests.post(endpoint, json=payload, headers=headers, timeout=30)
            if resp.status_code == 200:
                ok_count += 1
                print(f"[{idx}/{len(all_chunks)}] page {page_num}{tag} -> OK")
            else:
                fail_count += 1
                print(f"[{idx}/{len(all_chunks)}] page {page_num}{tag} -> FAILED ({resp.status_code}): {resp.text[:200]}")
        except requests.RequestException as e:
            fail_count += 1
            print(f"[{idx}/{len(all_chunks)}] page {page_num}{tag} -> ERROR: {e}")

        time.sleep(args.sleep)

    print(f"\nDone. {ok_count} ingested, {fail_count} failed out of {len(all_chunks)} total.")
    if fail_count:
        sys.exit(1)


if __name__ == "__main__":
    main()
